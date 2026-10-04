//! Spawn the bundled daemon in releases, or source Bun in explicit development.
//! The window starts it only while supervising and no runtime is listening.

#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

pub fn spawn(resources: &std::path::Path) -> Option<Child> {
    let is_source_daemon = cfg!(debug_assertions)
        || std::env::var("REAL_BOT_SOURCE_DAEMON").as_deref() == Ok("1");
    let mut cmd = if is_source_daemon {
        let (bun, main_ts, cwd) = launch_spec()?;
        let mut cmd = Command::new(bun);
        if watch_daemon() {
            cmd.arg("--watch");
        }
        cmd.arg(&main_ts).current_dir(cwd);
        cmd
    } else {
        let path = bundled_daemon(resources)?;
        let mut cmd = Command::new(path);
        cmd.env_remove("BUN_BE_BUN")
            .env_remove("BUN_OPTIONS")
            .env_remove("NODE_OPTIONS");
        cmd
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null());
    #[cfg(unix)]
    let channel = super::remote_setup::prepare_channel(&mut cmd)?;
    // After the line above: on Windows the channel IS the daemon's stdin and stdout.
    #[cfg(windows)]
    super::remote_setup::prepare_channel(&mut cmd);
    #[cfg(windows)]
    suppress_console_window(&mut cmd);
    // Only a source daemon THIS WINDOW spawns gets this treatment — `pnpm dev`'s usual daemon is
    // pnpm's own child, never passes through here, and is unchanged: its stderr is still whatever
    // pnpm gave it (the terminal `pnpm dev` runs in). Even here, "inherit was /dev/null" is only
    // true when the window itself has no console (launched from Finder, or a script that redirected
    // its own output away) — under `tauri dev` the window's stderr is a pipe back to the tauri
    // CLI's terminal, so for that launch this instead MOVES already-visible output into the file
    // below. Either way the point holds: every `[organizer]` line `organizer.ts` logs when a filing
    // comes to nothing was easy to lose (ADR 0040 P0's observability), and now always lands somewhere
    // durable. A packaged build's compiled daemon keeps inheriting stderr, unchanged. Rotation (see
    // `dev_stderr_log`) is only checked here, at spawn: a `bun --watch` daemon that runs for a long
    // stretch without this window restarting it keeps appending past the cap until it does. A file
    // that failed to open — an unwritable data dir — falls back to the same inherited behavior
    // rather than losing the daemon over a log.
    match is_source_daemon.then(|| dev_stderr_log(&super::local_api::data_dir())).flatten() {
        Some(file) => cmd.stderr(file),
        None => cmd.stderr(Stdio::inherit()),
    };
    if let Ok(dir) = std::env::var("REAL_BOT_DATA_DIR") {
        cmd.env("REAL_BOT_DATA_DIR", dir);
    }
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut child = cmd.spawn().ok()?;
    #[cfg(unix)]
    super::remote_setup::adopt_channel(channel);
    #[cfg(windows)]
    {
        super::remote_setup::adopt_channel(&mut child);
        end_with_this_process(&child);
    }
    Some(child)
}

/// Where the source daemon's raw stderr goes in development: `daemon.log` (`startup-log.ts`) is a
/// curated line per start, refusal and fatal error, not this — this is everything else, unfiltered.
const DEV_STDERR_LOG_NAME: &str = "daemon-dev.stderr.log";
/// The previous run's log, kept once past the size cap; the one before that is dropped.
const DEV_STDERR_LOG_ROTATED_NAME: &str = "daemon-dev.stderr.log.1";
/// Large enough to hold a `bun --watch` restart loop's worth of warnings, small enough to open in
/// an editor without thinking about it.
const DEV_STDERR_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Opens the dev daemon's stderr file, rotating it first if the last run left it over the cap.
/// `None` on any failure (an unwritable data dir, mainly) — the caller falls back to inheriting.
fn dev_stderr_log(data_dir: &std::path::Path) -> Option<std::fs::File> {
    std::fs::create_dir_all(data_dir).ok()?;
    let path = data_dir.join(DEV_STDERR_LOG_NAME);
    if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > DEV_STDERR_LOG_MAX_BYTES {
        let _ = std::fs::rename(&path, data_dir.join(DEV_STDERR_LOG_ROTATED_NAME));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

/// Windows has no process group that dies with its leader, so a window killed outright (Task
/// Manager, or the installer closing the app to upgrade it) would leave the daemon running and
/// holding `real-bot-daemon.exe` open, and the upgrade could not replace it. Every daemon this
/// window starts goes into one Job Object that kills everything in it when its last handle
/// closes; the only handle is this process's and is never closed, so however this process ends,
/// the daemon and everything it started (the pty helper, terminal shells) end with it. There is
/// no independent runtime on Windows for the daemon to outlive the window in.
#[cfg(windows)]
fn end_with_this_process(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // The job's HANDLE as an integer, so the static is Sync; 0 when it could not be made.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| {
        // SAFETY: plain Win32 calls on a handle this function owns; `info` is a zeroed POD
        // struct whose size is passed alongside it.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                CloseHandle(job);
                return 0;
            }
            job as usize
        }
    });
    if job == 0 {
        eprintln!("real-bot: no Job Object for the daemon; it may outlive a killed window");
        return;
    }
    // SAFETY: `job` stays open for the life of this process; the child's handle is live.
    if unsafe { AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE) } == 0 {
        eprintln!(
            "real-bot: could not put the daemon in its Job Object ({}); it may outlive a killed window",
            std::io::Error::last_os_error()
        );
    }
}

/// The signed daemon ships in the native resource directory, where `build:native` also gives it
/// the entitlements the credential runtime needs. A build that only produced the plain compiled
/// daemon leaves it next to the window binary instead, and starting a runtime still beats none.
fn bundled_daemon(resources: &std::path::Path) -> Option<PathBuf> {
    let name = sidecar_name();
    let native = super::remote_native::native_dir(resources).join(&name);
    if native.is_file() {
        return Some(native);
    }
    let beside = std::env::current_exe().ok()?.parent()?.join(&name);
    beside.is_file().then_some(beside)
}

/// Base name of the compiled daemon, in the resource directory or beside the window binary.
/// `EXE_SUFFIX` is `.exe` on Windows and empty everywhere else.
const SIDECAR_NAME_STEM: &str = "real-bot-daemon";

fn sidecar_name() -> String {
    format!("{SIDECAR_NAME_STEM}{}", std::env::consts::EXE_SUFFIX)
}

/// A console-owning child (bun, the compiled daemon) would otherwise flash a
/// black terminal window behind the app on every launch.
#[cfg(windows)]
pub(crate) fn suppress_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub fn child_alive(child: &mut Child) -> bool {
    child.try_wait().ok().flatten().is_none()
}

fn launch_spec() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let bun = bun_path()?;
    let main_ts = daemon_main()?;
    let cwd = main_ts.parent()?.parent()?.to_path_buf();
    Some((bun, main_ts, cwd))
}

fn bun_path() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("REAL_BOT_BUN") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(path) = which("bun") {
        return Some(path);
    }
    // `HOME` is usually unset on Windows; `USERPROFILE` is the variable that
    // actually carries the user's home directory there.
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))
    } else {
        std::env::var("HOME")
    }
    .ok()?;
    let fallback = PathBuf::from(home)
        .join(".bun")
        .join("bin")
        .join(format!("bun{}", std::env::consts::EXE_SUFFIX));
    fallback.is_file().then_some(fallback)
}

fn daemon_main() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("REAL_BOT_DAEMON_MAIN") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    let from_crate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../daemon/src/main.ts");
    if from_crate.is_file() {
        return Some(from_crate);
    }
    None
}

fn watch_daemon() -> bool {
    if let Ok(explicit) = std::env::var("REAL_BOT_DAEMON_WATCH") {
        return explicit == "1" || explicit.eq_ignore_ascii_case("true");
    }
    cfg!(debug_assertions)
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let pathext = std::env::var("PATHEXT").ok();
    for dir in std::env::split_paths(&path) {
        for candidate in which_candidates(name, cfg!(windows), pathext.as_deref()) {
            let candidate = dir.join(candidate);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The file names to try for `name` in one `PATH` directory, in order.
///
/// Off Windows this is just `name`. On Windows a bare command has no
/// extension, so the shell (and this) tries each of `PATHEXT`'s (`bun` before
/// `bun.exe`, so an extensionless shim on `PATH` still wins). `windows` and
/// `pathext` are injected — real callers pass `cfg!(windows)` and the real
/// `PATHEXT` — so the Windows list is exercised from a macOS test.
fn which_candidates(name: &str, windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows || name.contains('.') {
        return vec![name.to_string()];
    }
    let mut candidates = vec![name.to_string()];
    for ext in pathext.unwrap_or(".EXE;.CMD;.BAT").split(';') {
        let ext = ext.trim();
        if !ext.is_empty() {
            candidates.push(format!("{name}{ext}"));
        }
    }
    candidates
}

#[cfg(test)]
fn looks_like_daemon_tree(path: &Path) -> bool {
    path.ends_with("src/main.ts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crate_layout_points_at_daemon_main() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../daemon/src/main.ts");
        assert!(path.is_file(), "expected {} to exist", path.display());
        assert!(looks_like_daemon_tree(&path));
    }

    #[test]
    fn debug_builds_watch_the_daemon_by_default() {
        assert_eq!(watch_daemon(), cfg!(debug_assertions));
    }

    #[test]
    fn sidecar_name_carries_the_platform_exe_suffix() {
        assert_eq!(
            sidecar_name(),
            format!("real-bot-daemon{}", std::env::consts::EXE_SUFFIX)
        );
    }

    #[test]
    fn which_candidates_try_pathext_suffixes_on_windows_only() {
        assert_eq!(
            which_candidates("bun", false, None),
            vec!["bun".to_string()]
        );
        assert_eq!(
            which_candidates("bun", false, Some(".EXE;.CMD")),
            vec!["bun".to_string()],
            "PATHEXT is a Windows-shell concept only"
        );
        assert_eq!(
            which_candidates("bun", true, Some(".COM;.EXE;.BAT")),
            vec!["bun", "bun.COM", "bun.EXE", "bun.BAT"]
        );
        assert_eq!(
            which_candidates("bun", true, None),
            vec!["bun", "bun.EXE", "bun.CMD", "bun.BAT"],
            "a missing PATHEXT still tries the common extensions"
        );
        // A name that already carries an extension is left alone either way.
        assert_eq!(
            which_candidates("bun.exe", true, None),
            vec!["bun.exe".to_string()]
        );
    }

    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = UNIQUE.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("independent-runtime-tests")
            .join(format!("daemon-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dev_stderr_log_opens_a_fresh_file_and_keeps_appending() {
        let dir = temp_dir();
        dev_stderr_log(&dir).unwrap();
        std::fs::write(dir.join(DEV_STDERR_LOG_NAME), "first line\n").unwrap();
        // Opening again (as the next `spawn()` would) appends rather than truncating: a restart
        // loop's earlier output stays readable until the file actually earns rotation.
        use std::io::Write;
        write!(dev_stderr_log(&dir).unwrap(), "second line\n").unwrap();
        let text = std::fs::read_to_string(dir.join(DEV_STDERR_LOG_NAME)).unwrap();
        assert_eq!(text, "first line\nsecond line\n");
        assert!(!dir.join(DEV_STDERR_LOG_ROTATED_NAME).is_file());
    }

    #[test]
    fn dev_stderr_log_rotates_once_past_the_cap() {
        let dir = temp_dir();
        let path = dir.join(DEV_STDERR_LOG_NAME);
        std::fs::write(&path, vec![b'x'; (DEV_STDERR_LOG_MAX_BYTES + 1) as usize]).unwrap();
        dev_stderr_log(&dir).unwrap();
        assert!(dir.join(DEV_STDERR_LOG_ROTATED_NAME).is_file(), "the oversized file should have moved aside");
        // The freshly opened file starts empty, not appended to the content that just moved aside.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn dev_stderr_log_leaves_a_small_file_alone() {
        let dir = temp_dir();
        let path = dir.join(DEV_STDERR_LOG_NAME);
        std::fs::write(&path, "small\n").unwrap();
        dev_stderr_log(&dir).unwrap();
        assert!(!dir.join(DEV_STDERR_LOG_ROTATED_NAME).is_file());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "small\n");
    }
}
