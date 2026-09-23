//! Download a release `.dmg` inside the app and swap the running bundle with
//! the app inside it.
//!
//! The network read, the mount and the bundle swap all happen here, off the
//! webview: the webview only starts the job, polls `InstallState` for the
//! progress bar, and can cancel it. Everything that can be decided without a
//! disk or a network — which URLs are installable, where the running bundle
//! lives, what `hdiutil` printed, whether the mounted app is the build we were
//! promised — is a pure function so it can be unit tested.
//!
//! There is no minisign signature to check (see ADR 0022): the trust anchor is
//! TLS to github.com plus the release-asset URL allowlist, and the mounted
//! bundle has to carry our identifier and the version the check offered.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

/// Release assets live under this prefix. Only a `.dmg` below it is installable.
pub const ASSET_URL_PREFIX: &str = "https://github.com/Blackman99/deskfolk/releases/download/";
/// A release `.dmg` is ~100MB. Anything past this is a bogus feed, not a build.
pub const MAX_DOWNLOAD_BYTES: u64 = 1_500_000_000;
/// Chunk the body so the progress bar moves without hammering the state lock.
pub const CHUNK_BYTES: usize = 256 * 1024;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Downloading,
    Verifying,
    Installing,
    Restarting,
    Failed,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    pub phase: Phase,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub version: Option<String>,
    /// A stable code the messenger maps to a sentence: `not-installed`,
    /// `read-only`, `bad-url`, `busy`, `download-failed`, `verify-failed`,
    /// `install-failed`.
    pub error: Option<String>,
    /// The technical detail behind `error`, shown small under the sentence.
    pub detail: Option<String>,
}

impl InstallState {
    pub fn idle() -> Self {
        InstallState::default()
    }

    /// A job is in flight — the messenger keeps polling, and a second start is
    /// refused.
    pub fn is_active(&self) -> bool {
        matches!(
            self.phase,
            Phase::Downloading | Phase::Verifying | Phase::Installing | Phase::Restarting
        )
    }
}

/// The job's shared state: one snapshot the webview polls, one cancel flag the
/// download loop reads. The flag is replaced per job, so a cancelled worker
/// that has not noticed yet keeps reading the flag it was started with instead
/// of the retry's.
#[derive(Default)]
pub struct Installer {
    state: Mutex<InstallState>,
    cancel: Mutex<Arc<AtomicBool>>,
}

impl Installer {
    pub fn snapshot(&self) -> InstallState {
        self.state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| InstallState::idle())
    }

    /// Claim the job. `Err("busy")` when one is already running, so two clicks
    /// cannot download twice into the same staging folder.
    pub fn begin(&self, version: &str) -> Result<Arc<AtomicBool>, String> {
        let mut guard = self.state.lock().map_err(|_| "installer poisoned".to_string())?;
        if guard.is_active() {
            return Err("busy".into());
        }
        *guard = InstallState {
            phase: Phase::Downloading,
            downloaded: 0,
            total: None,
            version: Some(version.to_string()),
            error: None,
            detail: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut current) = self.cancel.lock() {
            *current = cancel.clone();
        }
        Ok(cancel)
    }

    pub fn update(&self, edit: impl FnOnce(&mut InstallState)) {
        if let Ok(mut guard) = self.state.lock() {
            edit(&mut guard);
        }
    }

    pub fn advance(&self, phase: Phase) {
        self.update(|state| state.phase = phase);
    }

    pub fn fail(&self, code: &str, detail: impl Into<String>) {
        self.update(|state| {
            state.phase = Phase::Failed;
            state.error = Some(code.to_string());
            state.detail = Some(detail.into());
        });
    }

    /// Back to idle: the user cancelled, or a failed job was dismissed.
    pub fn reset(&self) {
        if let Ok(cancel) = self.cancel.lock() {
            cancel.store(true, Ordering::SeqCst);
        }
        self.update(|state| *state = InstallState::idle());
    }
}

/// Only a `.dmg` under this repository's release-download prefix, with no
/// whitespace, control characters or `..` (it becomes a path and an argument).
pub fn is_installable_asset_url(url: &str) -> bool {
    url.starts_with(ASSET_URL_PREFIX)
        && url.ends_with(".dmg")
        && !url.contains("..")
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The `.app` that holds the running executable: `…/Deskfolk.app` from
/// `…/Deskfolk.app/Contents/MacOS/Deskfolk`. `None` for anything that is not
/// running out of a bundle (a `cargo run` binary, a plain CLI build).
pub fn bundle_root(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let app = contents.parent()?;
    if app.extension()? != "app" {
        return None;
    }
    Some(app.to_path_buf())
}

/// The file name to save the download as, taken from the URL's last segment.
/// Falls back to a fixed name when the segment is missing or has separators.
pub fn download_file_name(url: &str) -> String {
    let segment = url.rsplit('/').next().unwrap_or("");
    if segment.is_empty() || segment.contains(['/', '\\']) || segment.starts_with('.') {
        return "update.dmg".to_string();
    }
    segment.to_string()
}

/// Where this job's files live, all under one folder that is wiped when the
/// job starts and removed by the swap script at the end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagingPaths {
    pub root: PathBuf,
    pub dmg: PathBuf,
    pub mount: PathBuf,
}

pub fn staging_paths(cache_dir: &Path, url: &str) -> StagingPaths {
    let root = cache_dir.join("updates");
    StagingPaths {
        dmg: root.join(download_file_name(url)),
        mount: root.join("mount"),
        root,
    }
}

/// Pick the mount point out of `hdiutil attach`'s tab-separated output: the
/// last column of the line that has one, skipping the `/dev/diskN` column.
pub fn parse_mount_point(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| {
            line.split('\t')
                .map(str::trim)
                .filter(|field| field.starts_with('/') && !field.starts_with("/dev/"))
                .next_back()
                .map(str::to_string)
        })
        .next_back()
}

/// `CFBundleIdentifier` and `CFBundleShortVersionString` out of `plutil`'s JSON.
pub fn bundle_info(plist_json: &str) -> Result<(String, String), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(plist_json).map_err(|err| format!("Info.plist: {err}"))?;
    let identifier = parsed
        .get("CFBundleIdentifier")
        .and_then(serde_json::Value::as_str)
        .ok_or("Info.plist has no CFBundleIdentifier")?;
    let version = parsed
        .get("CFBundleShortVersionString")
        .and_then(serde_json::Value::as_str)
        .ok_or("Info.plist has no CFBundleShortVersionString")?;
    Ok((identifier.to_string(), version.to_string()))
}

/// The mounted app has to be our identifier and the exact version the update
/// check offered — a release whose assets were swapped or renamed stops here
/// rather than at the swap.
pub fn verify_bundle(
    plist_json: &str,
    expected_identifier: &str,
    expected_version: &str,
) -> Result<(), String> {
    let (identifier, version) = bundle_info(plist_json)?;
    if identifier != expected_identifier {
        return Err(format!(
            "downloaded bundle is {identifier}, expected {expected_identifier}"
        ));
    }
    if version != expected_version {
        return Err(format!(
            "downloaded bundle is version {version}, expected {expected_version}"
        ));
    }
    Ok(())
}

/// Is this path writable by us? Asked of the kernel rather than by writing a
/// probe file, because one of the paths asked about is the running app bundle
/// and nothing should be creating files inside a signed bundle.
pub fn is_writable(path: &Path) -> bool {
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    // SAFETY: `c_path` is a valid NUL-terminated string for the call's duration.
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
}

/// Can we replace this bundle in place? Both the bundle and the folder holding
/// it have to be writable — the swap renames the old one aside and writes the
/// new one next to it. A copy in `/Applications` installed by another user, or
/// one on a read-only volume, fails here before anything downloads.
pub fn can_replace_bundle(app: &Path) -> bool {
    let Some(parent) = app.parent() else {
        return false;
    };
    is_writable(parent) && is_writable(app)
}

/// Copy the body to `dest`, reporting progress. `on_progress` returns `false`
/// to stop (the user cancelled), which removes the partial file and reports
/// `cancelled`.
pub fn stream_to_file(
    mut body: impl Read,
    total: Option<u64>,
    dest: &Path,
    max_bytes: u64,
    mut on_progress: impl FnMut(u64, Option<u64>) -> bool,
) -> Result<u64, String> {
    if let Some(total) = total {
        if total > max_bytes {
            return Err(format!("download is {total} bytes, over the {max_bytes} cap"));
        }
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = std::fs::File::create(dest).map_err(|err| err.to_string())?;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut downloaded: u64 = 0;
    loop {
        let read = match body.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) => {
                let _ = std::fs::remove_file(dest);
                return Err(err.to_string());
            }
        };
        downloaded += read as u64;
        if downloaded > max_bytes {
            let _ = std::fs::remove_file(dest);
            return Err(format!("download passed the {max_bytes} byte cap"));
        }
        if let Err(err) = file.write_all(&buffer[..read]) {
            let _ = std::fs::remove_file(dest);
            return Err(err.to_string());
        }
        if !on_progress(downloaded, total) {
            let _ = std::fs::remove_file(dest);
            return Err("cancelled".into());
        }
    }
    file.flush().map_err(|err| err.to_string())?;
    if let Some(total) = total {
        if downloaded != total {
            let _ = std::fs::remove_file(dest);
            return Err(format!("got {downloaded} of {total} bytes"));
        }
    }
    Ok(downloaded)
}

/// Open the asset for reading. Redirects are followed (the release URL hands
/// off to a CDN host), but the URL we asked for is the allowlisted one.
pub fn open_asset(
    url: &str,
    user_agent: &str,
) -> Result<(Box<dyn Read + Send + Sync + 'static>, Option<u64>), String> {
    let agent = crate::updates::with_env_proxy(ureq::AgentBuilder::new(), url)
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .user_agent(user_agent)
        .build();
    let response = agent
        .get(url)
        .set("Accept", "application/octet-stream")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => other.to_string(),
        })?;
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    Ok((response.into_reader(), total))
}

fn run(program: &str, args: &[&std::ffi::OsStr]) -> Result<std::process::Output, String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|err| format!("{program}: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        let message = if message.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            message.to_string()
        };
        return Err(format!("{program} failed: {message}"));
    }
    Ok(output)
}

/// Attach the image read-only under `mount_parent` (never `/Volumes`, so a
/// half-finished install cannot collide with a disk the user mounted) and
/// return the mount point. The image checksum is verified by `hdiutil`.
pub fn attach_dmg(dmg: &Path, mount_parent: &Path) -> Result<String, String> {
    std::fs::create_dir_all(mount_parent).map_err(|err| err.to_string())?;
    let output = run(
        "/usr/bin/hdiutil",
        &[
            "attach".as_ref(),
            dmg.as_os_str(),
            "-nobrowse".as_ref(),
            "-noautoopen".as_ref(),
            "-readonly".as_ref(),
            "-mountrandom".as_ref(),
            mount_parent.as_os_str(),
        ],
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_mount_point(&stdout).ok_or_else(|| format!("no mount point in: {}", stdout.trim()))
}

pub fn detach_dmg(mount: &Path) {
    let quiet = |args: &[&std::ffi::OsStr]| {
        let _ = std::process::Command::new("/usr/bin/hdiutil")
            .args(args)
            .output();
    };
    quiet(&["detach".as_ref(), mount.as_os_str(), "-quiet".as_ref()]);
}

/// The single `.app` inside a mounted release image.
pub fn find_app_bundle(mount: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(mount).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().map(|ext| ext == "app").unwrap_or(false))
}

/// Read a bundle's `Info.plist` as JSON, whichever way it was serialized.
pub fn read_bundle_plist(app: &Path) -> Result<String, String> {
    let plist = app.join("Contents").join("Info.plist");
    let output = run(
        "/usr/bin/plutil",
        &[
            "-convert".as_ref(),
            "json".as_ref(),
            "-o".as_ref(),
            "-".as_ref(),
            plist.as_os_str(),
        ],
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn copy_bundle(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|err| err.to_string())?;
    }
    run("/usr/bin/ditto", &[src.as_os_str(), dest.as_os_str()]).map(|_| ())
}

/// Swaps the bundle once this process is gone, then reopens the app.
///
/// It runs detached from the window, because the window is what it waits for.
/// `mv` aside instead of delete-then-copy: if `ditto` fails halfway there is
/// still a whole app to move back, so a failed update leaves the old version
/// installed rather than an empty `/Applications` entry. `REAL_BOT_OPEN` is
/// the seam the test uses to run the swap without launching anything.
pub const SWAP_SCRIPT: &str = r#"#!/bin/sh
# Deskfolk update swap. Args: <target .app> <staged .app> <window pid> <staging dir>
target="$1"
staged="$2"
pid="$3"
staging="$4"
opener="${REAL_BOT_OPEN:-/usr/bin/open}"
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 300 ]; then
    exit 1
  fi
  sleep 0.2
done
backup="$staging/previous.app"
rm -rf "$backup"
if ! /bin/mv "$target" "$backup"; then
  # Nothing was touched, but this process already quit for the swap: bring it back.
  "$opener" "$target"
  exit 1
fi
if /usr/bin/ditto "$staged" "$target"; then
  /usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
else
  rm -rf "$target"
  /bin/mv "$backup" "$target"
fi
"$opener" "$target"
rm -rf "$staging"
rm -f "$0"
"#;

/// Write the swap script outside the staging folder, because the script is
/// what deletes that folder.
pub fn write_swap_script(dir: &Path) -> Result<PathBuf, String> {
    let path = dir.join(format!("real-bot-swap-{}.sh", std::process::id()));
    std::fs::write(&path, SWAP_SCRIPT).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| err.to_string())?;
    }
    Ok(path)
}

/// Start the swap and return. The child outlives this process on purpose.
pub fn spawn_swap(
    script: &Path,
    target: &Path,
    staged: &Path,
    staging: &Path,
) -> Result<(), String> {
    std::process::Command::new("/bin/sh")
        .arg(script)
        .arg(target)
        .arg(staged)
        .arg(std::process::id().to_string())
        .arg(staging)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("real-bot-installer-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The messenger parses this by hand, so the field names and the phase
    /// spellings are the contract between the two halves.
    #[test]
    fn the_state_serializes_as_the_messenger_reads_it() {
        let state = InstallState {
            phase: Phase::Downloading,
            downloaded: 4_194_304,
            total: Some(90_177_536),
            version: Some("0.2.0".into()),
            error: None,
            detail: None,
        };
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"phase":"downloading","downloaded":4194304,"total":90177536,"version":"0.2.0","error":null,"detail":null}"#
        );
        let phases = [
            (Phase::Idle, "idle"),
            (Phase::Downloading, "downloading"),
            (Phase::Verifying, "verifying"),
            (Phase::Installing, "installing"),
            (Phase::Restarting, "restarting"),
            (Phase::Failed, "failed"),
        ];
        for (phase, spelling) in phases {
            assert_eq!(serde_json::to_string(&phase).unwrap(), format!("\"{spelling}\""));
        }
    }

    #[test]
    fn only_dmg_assets_of_this_repository_are_installable() {
        assert!(is_installable_asset_url(
            "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_aarch64.dmg"
        ));
        // The release page is a valid download link but not something to install.
        assert!(!is_installable_asset_url(
            "https://github.com/Blackman99/deskfolk/releases/tag/v0.2.0"
        ));
        assert!(!is_installable_asset_url(
            "https://github.com/other/real-bot/releases/download/v0.2.0/Deskfolk_0.2.0_aarch64.dmg"
        ));
        assert!(!is_installable_asset_url(
            "http://github.com/Blackman99/deskfolk/releases/download/v0.2.0/a.dmg"
        ));
        assert!(!is_installable_asset_url(
            "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/app.zip"
        ));
        assert!(!is_installable_asset_url(
            "https://github.com/Blackman99/deskfolk/releases/download/../../evil.dmg"
        ));
        assert!(!is_installable_asset_url(
            "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/a b.dmg"
        ));
        assert!(!is_installable_asset_url(
            "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/a\n.dmg"
        ));
    }

    #[test]
    fn bundle_root_walks_up_from_the_executable() {
        assert_eq!(
            bundle_root(Path::new("/Applications/Deskfolk.app/Contents/MacOS/Deskfolk")),
            Some(PathBuf::from("/Applications/Deskfolk.app"))
        );
        // A `cargo run` / `tauri dev` binary is not in a bundle.
        assert_eq!(
            bundle_root(Path::new("/repo/apps/desktop/src-tauri/target/debug/real-bot-desktop")),
            None
        );
        assert_eq!(bundle_root(Path::new("/usr/local/bin/real-bot")), None);
        assert_eq!(
            bundle_root(Path::new("/Applications/Deskfolk/Contents/MacOS/Deskfolk")),
            None
        );
        assert_eq!(bundle_root(Path::new("/")), None);
    }

    #[test]
    fn download_file_name_comes_from_the_url_and_never_escapes() {
        assert_eq!(
            download_file_name(
                "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_aarch64.dmg"
            ),
            "Deskfolk_0.2.0_aarch64.dmg"
        );
        assert_eq!(download_file_name("https://example.com/"), "update.dmg");
        assert_eq!(download_file_name("https://example.com/.hidden"), "update.dmg");
    }

    #[test]
    fn staging_paths_keep_everything_under_one_folder() {
        let paths = staging_paths(
            Path::new("/Users/me/Library/Caches/com.real-bot.desktop"),
            "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_aarch64.dmg",
        );
        assert_eq!(
            paths.root,
            PathBuf::from("/Users/me/Library/Caches/com.real-bot.desktop/updates")
        );
        assert_eq!(paths.dmg, paths.root.join("Deskfolk_0.2.0_aarch64.dmg"));
        assert_eq!(paths.mount, paths.root.join("mount"));
    }

    #[test]
    fn parse_mount_point_reads_hdiutil_output() {
        let stdout = "/dev/disk4          \tGUID_partition_scheme          \t\n\
                      /dev/disk4s1        \tApple_HFS                      \t/private/tmp/dmg.XXXX/Deskfolk\n";
        assert_eq!(
            parse_mount_point(stdout),
            Some("/private/tmp/dmg.XXXX/Deskfolk".to_string())
        );
        assert_eq!(parse_mount_point("/dev/disk4\tGUID_partition_scheme\t\n"), None);
        assert_eq!(parse_mount_point(""), None);
    }

    #[test]
    fn verify_bundle_matches_identifier_and_version() {
        let plist = r#"{"CFBundleIdentifier":"com.real-bot.desktop","CFBundleShortVersionString":"0.2.0","CFBundleName":"Deskfolk"}"#;
        assert_eq!(
            bundle_info(plist).unwrap(),
            ("com.real-bot.desktop".to_string(), "0.2.0".to_string())
        );
        assert!(verify_bundle(plist, "com.real-bot.desktop", "0.2.0").is_ok());
        assert!(verify_bundle(plist, "com.evil.app", "0.2.0")
            .unwrap_err()
            .contains("com.real-bot.desktop"));
        assert!(verify_bundle(plist, "com.real-bot.desktop", "0.3.0")
            .unwrap_err()
            .contains("0.2.0"));
        assert!(verify_bundle("{}", "com.real-bot.desktop", "0.2.0").is_err());
        assert!(verify_bundle("not json", "com.real-bot.desktop", "0.2.0").is_err());
    }

    #[test]
    fn only_a_running_job_is_active() {
        let mut state = InstallState::idle();
        assert!(!state.is_active());
        for phase in [Phase::Downloading, Phase::Verifying, Phase::Installing, Phase::Restarting] {
            state.phase = phase;
            assert!(state.is_active(), "{phase:?} is a running job");
        }
        state.phase = Phase::Failed;
        assert!(!state.is_active());
    }

    #[test]
    fn a_second_start_is_refused_until_the_job_ends() {
        let installer = Installer::default();
        assert!(installer.begin("0.2.0").is_ok());
        assert_eq!(installer.begin("0.2.0").unwrap_err(), "busy");
        assert_eq!(installer.snapshot().version.as_deref(), Some("0.2.0"));

        installer.fail("download-failed", "HTTP 500");
        let failed = installer.snapshot();
        assert_eq!(failed.phase, Phase::Failed);
        assert_eq!(failed.error.as_deref(), Some("download-failed"));
        assert_eq!(failed.detail.as_deref(), Some("HTTP 500"));

        // A failed job can be retried, and the retry clears the old error.
        assert!(installer.begin("0.2.1").is_ok());
        let retry = installer.snapshot();
        assert_eq!(retry.phase, Phase::Downloading);
        assert_eq!(retry.error, None);
        assert_eq!(retry.detail, None);
    }

    #[test]
    fn reset_cancels_the_running_download_and_a_retry_does_not_revive_it() {
        let installer = Installer::default();
        let cancel = installer.begin("0.2.0").unwrap();
        assert!(!cancel.load(Ordering::SeqCst));
        installer.reset();
        assert!(cancel.load(Ordering::SeqCst), "the download loop sees the flag");
        assert_eq!(installer.snapshot(), InstallState::idle());

        // The retry runs on its own flag: the cancelled worker stays cancelled.
        let retry = installer.begin("0.2.0").unwrap();
        assert!(!retry.load(Ordering::SeqCst));
        assert!(cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn stream_to_file_writes_the_body_and_reports_progress() {
        let dir = temp_dir("stream");
        let dest = dir.join("nested").join("out.dmg");
        let body = vec![7u8; CHUNK_BYTES + 100];
        let total = Some(body.len() as u64);
        let mut ticks = Vec::new();
        let written = stream_to_file(
            Cursor::new(body.clone()),
            total,
            &dest,
            MAX_DOWNLOAD_BYTES,
            |downloaded, seen_total| {
                ticks.push((downloaded, seen_total));
                true
            },
        )
        .unwrap();
        assert_eq!(written, body.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(ticks.len(), 2);
        assert_eq!(ticks[0], (CHUNK_BYTES as u64, total));
        assert_eq!(ticks[1], (body.len() as u64, total));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stream_to_file_drops_the_partial_file_on_cancel() {
        let dir = temp_dir("cancel");
        let dest = dir.join("out.dmg");
        let body = vec![0u8; CHUNK_BYTES * 3];
        let err = stream_to_file(
            Cursor::new(body),
            None,
            &dest,
            MAX_DOWNLOAD_BYTES,
            |_, _| false,
        )
        .unwrap_err();
        assert_eq!(err, "cancelled");
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stream_to_file_refuses_a_body_over_the_cap() {
        let dir = temp_dir("cap");
        let dest = dir.join("out.dmg");
        // Announced over the cap: nothing is read at all.
        let err = stream_to_file(Cursor::new(vec![0u8; 8]), Some(64), &dest, 16, |_, _| true)
            .unwrap_err();
        assert!(err.contains("cap"), "{err}");
        assert!(!dest.exists());

        // Announced small, then keeps going: stopped mid-body.
        let err = stream_to_file(
            Cursor::new(vec![0u8; CHUNK_BYTES * 2]),
            None,
            &dest,
            CHUNK_BYTES as u64,
            |_, _| true,
        )
        .unwrap_err();
        assert!(err.contains("cap"), "{err}");
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stream_to_file_rejects_a_truncated_body() {
        let dir = temp_dir("short");
        let dest = dir.join("out.dmg");
        let err = stream_to_file(Cursor::new(vec![1u8; 10]), Some(20), &dest, 100, |_, _| true)
            .unwrap_err();
        assert_eq!(err, "got 10 of 20 bytes");
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_bundle_or_folder_stops_the_install_before_it_starts() {
        let dir = temp_dir("writable");
        let app = dir.join("Deskfolk.app");
        std::fs::create_dir_all(&app).unwrap();
        assert!(is_writable(&dir));
        assert!(can_replace_bundle(&app));
        assert!(!is_writable(&dir.join("missing")));
        assert!(!can_replace_bundle(&dir.join("missing").join("Deskfolk.app")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // A bundle someone else installed: the folder is readable, not writable.
            std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o500)).unwrap();
            assert!(!is_writable(&app));
            assert!(!can_replace_bundle(&app));
            std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_app_bundle_picks_the_app_in_the_image() {
        let dir = temp_dir("mount");
        std::fs::create_dir_all(dir.join("Deskfolk.app")).unwrap();
        std::fs::write(dir.join("Applications"), b"link").unwrap();
        assert_eq!(find_app_bundle(&dir), Some(dir.join("Deskfolk.app")));
        assert_eq!(find_app_bundle(&dir.join("missing")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_swap_script_is_executable_and_takes_its_paths_as_arguments() {
        let dir = temp_dir("script");
        let script = write_swap_script(&dir).unwrap();
        assert!(script.starts_with(&dir));
        let body = std::fs::read_to_string(&script).unwrap();
        // Paths arrive as arguments, never interpolated into the script text.
        assert!(body.contains("target=\"$1\""));
        assert!(body.contains("staged=\"$2\""));
        assert!(body.contains("pid=\"$3\""));
        assert!(body.contains("staging=\"$4\""));
        // A failed copy restores the bundle it moved aside, and a bundle that
        // could not be moved at all is reopened rather than left closed.
        assert!(body.contains("/bin/mv \"$backup\" \"$target\""));
        assert!(body.contains("if ! /bin/mv \"$target\" \"$backup\"; then"));
        assert!(body.contains("\"$opener\" \"$target\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The script has to survive paths with spaces (`/Applications/Deskfolk.app`)
    /// and run without the app around: exercise it against stand-in folders.
    #[test]
    fn the_swap_script_replaces_the_bundle_and_cleans_up() {
        let dir = temp_dir("swap");
        let staging = dir.join("updates");
        let target = dir.join("Deskfolk.app");
        let staged = staging.join("Deskfolk.app");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("version.txt"), b"old").unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("version.txt"), b"new").unwrap();
        let script = write_swap_script(&dir).unwrap();

        // A pid past the macOS maximum is never alive, so the wait falls
        // through immediately; `REAL_BOT_OPEN` keeps the relaunch from
        // launching a stand-in folder.
        let dead_pid = "999999";
        let status = std::process::Command::new("/bin/sh")
            .arg(&script)
            .arg(&target)
            .arg(&staged)
            .arg(dead_pid)
            .arg(&staging)
            .env("REAL_BOT_OPEN", "/usr/bin/true")
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read_to_string(target.join("version.txt")).unwrap(), "new");
        assert!(!staging.exists(), "the staging folder is removed");
        assert!(!script.exists(), "the script removes itself");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
