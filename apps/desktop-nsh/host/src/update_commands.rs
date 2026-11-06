//! The update commands the About card calls, answered as the Tauri app does
//! (`apps/desktop/src-tauri/src/lib.rs`: `can_install_update`, `update_install_state`,
//! `cancel_update_install`, `start_update_install`, `install_update`, `stage_from_mount`). The feed
//! check (`check_for_update`) is `updates::check`, registered for every desktop in `launch.rs`.
//!
//! A dev build can install nothing: `installable_bundle` answers `not-installed`, so the About
//! card offers the browser download and no bundle is ever replaced.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use crate::dev_build::Identity;
use crate::installer::{self, InstallState, Installer, Phase};

static INSTALLER: LazyLock<Installer> = LazyLock::new(Installer::default);

/// Where a downloaded build would be installed: the `.app` this process runs out of.
/// `not-installed` for a dev build or a bare binary.
fn installable_bundle(id: &Identity) -> Result<PathBuf, String> {
    if id.is_dev() {
        return Err("not-installed".into());
    }
    let exe = std::env::current_exe().map_err(|_| "not-installed".to_string())?;
    installer::bundle_root(&exe).ok_or_else(|| "not-installed".to_string())
}

pub fn can_install(id: &Identity) -> bool {
    installable_bundle(id).map(|bundle| installer::can_replace_bundle(&bundle)).unwrap_or(false)
}

pub fn state() -> InstallState {
    INSTALLER.snapshot()
}

/// Cancels a running download, or clears a failed one.
pub fn cancel() -> InstallState {
    INSTALLER.reset();
    INSTALLER.snapshot()
}

/// The preflight runs here so a refusal reaches the button press rather than the progress bar.
/// `quit` takes the app down for the swap once the new build is staged.
pub fn start(
    id: &Identity,
    url: &str,
    version: &str,
    quit: impl FnOnce() + Send + 'static,
) -> Result<InstallState, String> {
    let target = installable_bundle(id)?;
    if !installer::is_installable_asset_url(url) {
        return Err("bad-url".into());
    }
    if !installer::can_replace_bundle(&target) {
        return Err("read-only".into());
    }
    let cancel = INSTALLER.begin(version)?;
    let (id, url, version) = (id.clone(), url.to_owned(), version.to_owned());
    std::thread::spawn(move || install_update(&id, url, version, target, cancel, quit));
    Ok(INSTALLER.snapshot())
}

/// `~/Library/Caches/<bundle id>`, where Tauri's `app_cache_dir` puts it.
fn staging_dir(id: &Identity) -> PathBuf {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Caches").join(&id.bundle_id))
        .unwrap_or_else(|| std::env::temp_dir().join(&id.bundle_id))
}

/// Download, mount, verify, stage, swap. Each step reports its phase to the About card and stops
/// on the cancel flag; anything that fails leaves the installed app untouched.
fn install_update(
    id: &Identity,
    url: String,
    version: String,
    target: PathBuf,
    cancel: Arc<AtomicBool>,
    quit: impl FnOnce(),
) {
    let state = &*INSTALLER;
    let paths = installer::staging_paths(&staging_dir(id), &url);
    let _ = std::fs::remove_dir_all(&paths.root);
    if let Err(err) = std::fs::create_dir_all(&paths.root) {
        state.fail("install-failed", err.to_string());
        return;
    }

    let user_agent = format!("real-bot-desktop/{}", id.version);
    let (body, total) = match installer::open_asset(&url, &user_agent) {
        Ok(opened) => opened,
        Err(err) => return state.fail("download-failed", err),
    };
    state.update(|snapshot| snapshot.total = total);

    let mut last_tick = Instant::now();
    let downloaded = installer::stream_to_file(body, total, &paths.dmg, installer::MAX_DOWNLOAD_BYTES, |downloaded, total| {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        // The bar moves ten times a second at most.
        if last_tick.elapsed() >= Duration::from_millis(100) || Some(downloaded) == total {
            last_tick = Instant::now();
            state.update(|snapshot| {
                snapshot.downloaded = downloaded;
                snapshot.total = total;
            });
        }
        true
    });
    if let Err(err) = downloaded {
        let _ = std::fs::remove_dir_all(&paths.root);
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        return state.fail("download-failed", err);
    }

    state.advance(Phase::Verifying);
    let mount = match installer::attach_dmg(&paths.dmg, &paths.mount) {
        Ok(mount) => PathBuf::from(mount),
        Err(err) => {
            let _ = std::fs::remove_dir_all(&paths.root);
            return state.fail("verify-failed", err);
        }
    };
    let staged = stage_from_mount(id, &version, &mount, &paths, &cancel);
    installer::detach_dmg(&mount);
    let Some(staged) = staged else {
        let _ = std::fs::remove_dir_all(&paths.root);
        return;
    };

    state.advance(Phase::Restarting);
    let script = match installer::write_swap_script(&std::env::temp_dir()) {
        Ok(script) => script,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&paths.root);
            return state.fail("install-failed", err);
        }
    };
    if let Err(err) = installer::spawn_swap(&script, &target, &staged, &paths.root) {
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_dir_all(&paths.root);
        return state.fail("install-failed", err);
    }
    // The swap waits for this pid, so the app goes down the ordinary way.
    quit();
}

/// Checks the mounted image and copies the app out of it. `None` means the job stopped; the state
/// carries why, unless the person cancelled.
fn stage_from_mount(
    id: &Identity,
    version: &str,
    mount: &PathBuf,
    paths: &installer::StagingPaths,
    cancel: &Arc<AtomicBool>,
) -> Option<PathBuf> {
    let state = &*INSTALLER;
    let Some(bundle) = installer::find_app_bundle(mount) else {
        state.fail("verify-failed", "the image holds no .app");
        return None;
    };
    let plist = match installer::read_bundle_plist(&bundle) {
        Ok(plist) => plist,
        Err(err) => {
            state.fail("verify-failed", err);
            return None;
        }
    };
    if let Err(err) = installer::verify_bundle(&plist, &id.bundle_id, version) {
        state.fail("verify-failed", err);
        return None;
    }
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    state.advance(Phase::Installing);
    let staged = paths.root.join(bundle.file_name()?);
    if let Err(err) = installer::copy_bundle(&bundle, &staged) {
        state.fail("install-failed", err);
        return None;
    }
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    Some(staged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev_identity() -> Identity {
        Identity {
            bundle_id: "com.real-bot.desktop.nsh-dev".into(),
            data_dir: "/tmp/dev".into(),
            port: 17990,
            version: "0.4.0",
        }
    }

    #[test]
    fn a_dev_build_installs_nothing() {
        let id = dev_identity();
        assert_eq!(installable_bundle(&id), Err("not-installed".to_string()));
        assert!(!can_install(&id));
        let started = start(&id, "https://github.com/Blackman99/deskfolk/releases/download/v9/Deskfolk_9_aarch64.dmg", "9.0.0", || {});
        assert_eq!(started.unwrap_err(), "not-installed");
        assert_eq!(state(), InstallState::idle());
        assert_eq!(cancel(), InstallState::idle());
    }

    #[test]
    fn the_install_state_reaches_the_card_as_idle_camel_case() {
        let json = serde_json::to_value(InstallState::idle()).unwrap();
        assert_eq!(json["phase"], "idle");
        assert_eq!(json["downloaded"], 0);
        assert!(json["total"].is_null() && json["version"].is_null() && json["error"].is_null() && json["detail"].is_null());
    }

    #[test]
    fn staging_lives_under_the_bundle_ids_cache_folder() {
        let dir = staging_dir(&dev_identity());
        assert!(dir.ends_with("Library/Caches/com.real-bot.desktop.nsh-dev") || dir.ends_with("com.real-bot.desktop.nsh-dev"));
    }
}
