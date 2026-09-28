//! Spawn the bundled daemon in releases, or source Bun in explicit development.
//! The window starts it only while supervising and no runtime is listening.

#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

pub fn spawn(resources: &std::path::Path) -> Option<Child> {
    let mut cmd = if cfg!(debug_assertions)
        || std::env::var("REAL_BOT_SOURCE_DAEMON").as_deref() == Ok("1")
    {
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
    #[cfg(unix)]
    let channel = super::remote_setup::prepare_channel(&mut cmd)?;
    #[cfg(windows)]
    suppress_console_window(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Ok(dir) = std::env::var("REAL_BOT_DATA_DIR") {
        cmd.env("REAL_BOT_DATA_DIR", dir);
    }
    let child = cmd.spawn().ok()?;
    #[cfg(unix)]
    super::remote_setup::adopt_channel(channel);
    Some(child)
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
}
