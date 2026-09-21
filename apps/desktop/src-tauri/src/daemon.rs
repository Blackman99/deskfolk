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
    let native = super::remote_native::native_dir(resources).join(SIDECAR_NAME);
    if native.is_file() {
        return Some(native);
    }
    let beside = std::env::current_exe().ok()?.parent()?.join(SIDECAR_NAME);
    beside.is_file().then_some(beside)
}

/// Base name of the compiled daemon, in the resource directory or beside the window binary.
const SIDECAR_NAME: &str = "real-bot-daemon";

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
    let home = std::env::var("HOME").ok()?;
    let fallback = PathBuf::from(home).join(".bun/bin/bun");
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
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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
}
