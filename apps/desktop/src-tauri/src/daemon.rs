//! Start the daemon the window supervises. Two shapes, one policy:
//!
//! - **Packaged**: the compiled daemon rides along as `externalBin` and sits next to this binary.
//!   Nothing else is needed — no Bun on the machine, no source checkout.
//! - **From source**: the machine's Bun runs `apps/daemon/src/main.ts`, with `--watch` in debug.
//!
//! The source path is a compile-time absolute path, so it is only ever right on the machine that
//! built the binary. A release built in CI pointed at the runner's home directory, which is why an
//! installed app could never start a runtime and sat at "can't reach the runtime" for good.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Base name of the compiled daemon; `externalBin` in `tauri.conf.json` ends with it.
const SIDECAR_NAME: &str = "real-bot-daemon";

#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
    /// The compiled daemon shipped with the app.
    Sidecar(PathBuf),
    /// A source checkout, run with the machine's Bun.
    Source {
        bun: PathBuf,
        main_ts: PathBuf,
        cwd: PathBuf,
    },
}

pub fn spawn() -> Option<Child> {
    let mut cmd = match launch()? {
        Launch::Sidecar(bin) => {
            let mut cmd = Command::new(&bin);
            if let Some(dir) = bin.parent() {
                cmd.current_dir(dir);
            }
            cmd
        }
        Launch::Source { bun, main_ts, cwd } => {
            let mut cmd = Command::new(bun);
            if watch_daemon() {
                cmd.arg("--watch");
            }
            cmd.arg(&main_ts).current_dir(cwd);
            cmd
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Ok(dir) = std::env::var("REAL_BOT_DATA_DIR") {
        cmd.env("REAL_BOT_DATA_DIR", dir);
    }
    cmd.spawn().ok()
}

pub fn child_alive(child: &mut Child) -> bool {
    child.try_wait().ok().flatten().is_none()
}

fn launch() -> Option<Launch> {
    // An explicit entry point wins: it is the escape hatch for running a checkout's daemon under a
    // packaged window, and the daemon tests use it.
    if let Some(main_ts) = env_path("REAL_BOT_DAEMON_MAIN") {
        return source_launch(main_ts);
    }
    if let Some(bin) = env_path("REAL_BOT_DAEMON_BIN") {
        return Some(Launch::Sidecar(bin));
    }
    // Debug is the dev loop: prefer the checkout so `--watch` keeps picking up edits even when a
    // sidecar was built alongside it.
    if cfg!(debug_assertions) {
        if let Some(launch) = crate_main_ts().and_then(source_launch) {
            return Some(launch);
        }
        return sidecar_path().map(Launch::Sidecar);
    }
    if let Some(bin) = sidecar_path() {
        return Some(Launch::Sidecar(bin));
    }
    crate_main_ts().and_then(source_launch)
}

fn source_launch(main_ts: PathBuf) -> Option<Launch> {
    let cwd = main_ts.parent()?.parent()?.to_path_buf();
    Some(Launch::Source {
        bun: bun_path()?,
        main_ts,
        cwd,
    })
}

fn env_path(key: &str) -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var(key).ok()?);
    path.is_file().then_some(path)
}

fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    sidecar_in(exe.parent()?)
}

/// Tauri drops `externalBin` next to the window binary. Whether it keeps the target-triple suffix
/// has moved between versions, so take either rather than bake one spelling in.
fn sidecar_in(dir: &Path) -> Option<PathBuf> {
    let plain = dir.join(SIDECAR_NAME);
    if plain.is_file() {
        return Some(plain);
    }
    let prefix = format!("{SIDECAR_NAME}-");
    let mut matches: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix))
                && entry.path().is_file()
        })
        .map(|entry| entry.path())
        .collect();
    matches.sort();
    matches.into_iter().next()
}

fn bun_path() -> Option<PathBuf> {
    if let Some(path) = env_path("REAL_BOT_BUN") {
        return Some(path);
    }
    if let Some(path) = which("bun") {
        return Some(path);
    }
    let home = std::env::var("HOME").ok()?;
    let fallback = PathBuf::from(home).join(".bun/bin/bun");
    fallback.is_file().then_some(fallback)
}

fn crate_main_ts() -> Option<PathBuf> {
    let from_crate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../daemon/src/main.ts");
    from_crate.is_file().then_some(from_crate)
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
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "real-bot-daemon-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\n").expect("write");
        path
    }

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
    fn sidecar_is_found_next_to_the_window_binary() {
        let dir = scratch("plain");
        let bin = touch(&dir, SIDECAR_NAME);
        assert_eq!(sidecar_in(&dir), Some(bin));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sidecar_is_found_when_the_target_triple_is_kept() {
        let dir = scratch("triple");
        let bin = touch(&dir, "real-bot-daemon-aarch64-apple-darwin");
        assert_eq!(sidecar_in(&dir), Some(bin));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bundle_without_a_sidecar_resolves_to_nothing() {
        let dir = scratch("empty");
        touch(&dir, "real-bot-desktop");
        assert_eq!(sidecar_in(&dir), None);
        fs::remove_dir_all(&dir).ok();
    }

    /// The Rust side and the bundle config have to agree on the name, or the app ships a binary
    /// nothing looks for.
    #[test]
    fn tauri_config_declares_the_sidecar_this_module_looks_for() {
        let conf = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"),
        )
        .expect("tauri.conf.json");
        let parsed: serde_json::Value = serde_json::from_str(&conf).expect("valid json");
        let declared = parsed["bundle"]["externalBin"][0]
            .as_str()
            .expect("externalBin entry");
        assert_eq!(declared, format!("binaries/{SIDECAR_NAME}"));
    }
}
