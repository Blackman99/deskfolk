//! The messenger's system commands the macOS shell answers as the Tauri shell did
//! (`apps/desktop/src-tauri/src/lib.rs` `pick_workspace_folder`, `system_open.rs`
//! `open_workspace_path`): a folder picked in the system's panel, a workspace path opened with its
//! app or shown in Finder. Links and the clipboard need no shell: the app's bridge answers them
//! with NSH's `openUrl` and `Clipboard` (`app/src/platform/tauri-bridge.ts`).

use std::cell::Cell;
use std::path::Path;

use block2::RcBlock;
use nsh_engine::HostCall;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
use objc2_foundation::{NSString, NSURL};
use serde_json::{Value, json};

/// The folder to start in: the current workspace if it is a folder, else its nearest existing
/// parent, else none (the panel's own default).
pub fn starting_directory(current: Option<&str>) -> Option<String> {
    let mut path = Path::new(current?.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return None;
    }
    loop {
        if path.is_dir() {
            return Some(path.to_string_lossy().into_owned());
        }
        path = path.parent()?;
    }
}

/// `pick_workspace_folder({ current, title })`: the chosen folder's path, or null when cancelled.
pub fn pick_folder(mtm: MainThreadMarker, call: HostCall) {
    let data = call.data();
    let title = data["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Choose folder").to_owned();
    let start = starting_directory(data["current"].as_str());
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setCanCreateDirectories(true);
    panel.setAllowsMultipleSelection(false);
    panel.setMessage(Some(&NSString::from_str(&title)));
    if let Some(dir) = start {
        panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(&dir))));
    }
    let call = Cell::new(Some(call));
    let chosen = panel.clone();
    let done = RcBlock::new(move |response: isize| {
        let Some(call) = call.take() else { return };
        let path = (response == NSModalResponseOK)
            .then(|| chosen.URL())
            .flatten()
            .and_then(|url| url.path())
            .map(|path| path.to_string());
        call.resolve(path.map_or(Value::Null, |p| json!(p)));
    });
    panel.beginWithCompletionHandler(&done);
}

/// Why a workspace path cannot be opened, before the system is asked.
pub fn check_openable(path: &str) -> Result<(), String> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err("path must be absolute".into());
    }
    if !target.exists() {
        return Err("path does not exist".into());
    }
    Ok(())
}

/// `open_workspace_path({ path, reveal })`: `open` (or `open -R`, Show in Finder), off the engine
/// thread.
pub fn open_path(call: HostCall) {
    let data = call.data();
    let path = data["path"].as_str().unwrap_or_default().to_owned();
    let reveal = data["reveal"].as_bool().unwrap_or(false);
    if let Err(why) = check_openable(&path) {
        call.reject(why);
        return;
    }
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        match cmd.arg(&path).status() {
            Ok(status) if status.success() => call.resolve(Value::Null),
            Ok(_) => call.reject("open failed"),
            Err(why) => call.reject(why.to_string()),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picker_starts_in_the_nearest_existing_folder() {
        let dir = std::env::temp_dir();
        let missing = dir.join("deskfolk-nsh-no-such-dir/deeper");
        let start = |p: &std::path::Path| starting_directory(p.to_str()).map(std::path::PathBuf::from);
        assert_eq!(start(&dir).as_deref(), Some(dir.as_path()));
        assert_eq!(start(&missing).as_deref().map(|p| p.components().collect::<Vec<_>>()), Some(dir.components().collect()));
        assert_eq!(starting_directory(Some("relative/path")), None);
        assert_eq!(starting_directory(Some("  ")), None);
        assert_eq!(starting_directory(None), None);
    }

    #[test]
    fn only_an_existing_absolute_path_opens() {
        assert!(check_openable("relative").is_err());
        assert!(check_openable("/no/such/deskfolk/path").is_err());
        assert!(check_openable(std::env::temp_dir().to_str().unwrap()).is_ok());
    }
}
