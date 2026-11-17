//! The folder dialog and the file manager where the shell does not answer them itself (Windows,
//! Linux; the macOS shell has `host/src/system.rs`): the Tauri app's `pick_workspace_folder` and
//! `open_workspace_path`, through NSH's own `pick_paths`, `open_path` and `reveal_path` (the shell's
//! `IFileOpenDialog`, `ShellExecuteW` and `SHOpenFolderAndSelectItems` on Windows; GTK's file dialog
//! and file launcher on Linux). `app/src/platform/tauri-bridge.ts` answers the two commands with
//! them, so the messenger's calls stay as they were.
//!
//! As in the Tauri app, a file that would run rather than open is shown in the file manager
//! instead: one Windows rates dangerous to open (`AssocIsDangerous`: programs, scripts, shortcuts,
//! installers), and on Linux one with its execute bit set or a launcher's, a script's or a
//! program's extension. A file a Bot wrote carries no mark of where it came from; running it is the
//! person's own double-click.

use std::path::{Path, PathBuf};

use nsh_core::file_dialog::OpenDialog;
use nsh_core::prelude::*;

/// What TSX imports as `Files` from `deskfolk/native`.
#[module]
pub struct Files;

#[module]
impl Files {
    /// `pickFolder(title, current)`: the folder the person picked, or null when they cancelled. The
    /// dialog starts in `current` (`~` expanded), or in its parent when `current` is not there yet.
    pub async fn pick_folder(title: String, current: String) -> Result<Option<String>, String> {
        let title = if title.trim().is_empty() { "Choose folder".to_owned() } else { title };
        let mut dialog = OpenDialog::folders().title(title);
        if let Some(start) = starting_directory(&current) {
            dialog = dialog.directory(start);
        }
        let picked = pick_paths(dialog).await?;
        Ok(picked.and_then(|paths| paths.into_iter().next()).map(|path| path.to_string_lossy().into_owned()))
    }

    /// `openPath(path, reveal)`: opens the file or folder in its default app, or shows it selected in
    /// the file manager (`reveal`, and a file that would run when opened).
    pub async fn open_path(path: String, reveal: bool) -> Result<(), String> {
        let target = PathBuf::from(&path);
        if !target.is_absolute() {
            return Err("path must be absolute".into());
        }
        if !target.exists() {
            return Err("path does not exist".into());
        }
        if reveal || (target.is_file() && runs_when_opened(&target)) {
            reveal_path(target).await
        } else {
            nsh_core::prelude::open_path(target).await
        }
    }
}

/// `~`, `~/…` (and on Windows `~\…`) as the home folder; the folder itself when it is there, else
/// its parent when that is; nothing for an empty value. The Tauri app's `starting_directory`.
fn starting_directory(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let path = expand_home(raw, cfg!(windows), |name| std::env::var_os(name));
    if path.is_dir() {
        return Some(path);
    }
    let parent = path.parent()?;
    (parent.is_dir() && !parent.as_os_str().is_empty()).then(|| parent.to_path_buf())
}

fn expand_home(raw: &str, windows: bool, env: impl Fn(&str) -> Option<std::ffi::OsString>) -> PathBuf {
    let rest = if raw == "~" {
        Some("")
    } else if let Some(rest) = raw.strip_prefix("~/") {
        Some(rest)
    } else if windows {
        raw.strip_prefix("~\\")
    } else {
        None
    };
    if let Some(rest) = rest {
        let home = env("HOME").or_else(|| if windows { env("USERPROFILE") } else { None });
        if let Some(home) = home {
            let mut path = PathBuf::from(home);
            if !rest.is_empty() {
                path.push(rest);
            }
            return path;
        }
    }
    PathBuf::from(raw)
}

/// Whether opening `path` would run it (see the module's note).
#[cfg(windows)]
fn runs_when_opened(path: &Path) -> bool {
    use windows::Win32::UI::Shell::AssocIsDangerous;
    use windows::core::HSTRING;
    // A file with no extension opens the "Open with" picker, which runs nothing.
    let Some(extension) = path.extension() else { return false };
    let assoc = HSTRING::from(format!(".{}", extension.to_string_lossy()));
    // SAFETY: a NUL-terminated wide string that outlives the call.
    unsafe { AssocIsDangerous(&assoc).as_bool() }
}

#[cfg(any(target_os = "linux", all(test, unix)))]
const LINUX_RUNNABLE_EXTENSIONS: &[&str] = &[
    "desktop", "sh", "bash", "zsh", "ksh", "csh", "fish", "run", "bin", "appimage", "jar", "py", "pl", "rb", "x86_64", "exe",
    "msi", "com", "bat", "cmd", "flatpakref", "flatpakrepo",
];

#[cfg(target_os = "linux")]
fn runs_when_opened(path: &Path) -> bool {
    linux_runs_when_opened(path)
}

/// A file whose execute bit is set, or whose extension a desktop may run when it is opened
/// (launchers, scripts, programs, packages that install themselves, Windows programs Wine starts).
#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_runs_when_opened(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let executable = std::fs::metadata(path).map(|meta| meta.permissions().mode() & 0o111 != 0).unwrap_or(true);
    let runnable_extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .is_some_and(|ext| LINUX_RUNNABLE_EXTENSIONS.contains(&ext.as_str()));
    executable || runnable_extension
}

/// The macOS shell answers these itself, and the web has no local files.
#[cfg(not(any(windows, target_os = "linux")))]
fn runs_when_opened(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_expanded_where_each_system_writes_it() {
        let env = |name: &str| (name == "HOME").then(|| std::ffi::OsString::from("/home/a"));
        assert_eq!(expand_home("~", false, env), PathBuf::from("/home/a"));
        assert_eq!(expand_home("~/work", false, env), PathBuf::from("/home/a/work"));
        assert_eq!(expand_home("~\\work", false, env), PathBuf::from("~\\work"));
        let profile = |name: &str| (name == "USERPROFILE").then(|| std::ffi::OsString::from("C:/Users/a"));
        assert_eq!(expand_home("~\\work", true, profile), PathBuf::from("C:/Users/a").join("work"));
        assert_eq!(expand_home("/srv/x", true, profile), PathBuf::from("/srv/x"));
    }

    #[test]
    fn the_dialog_starts_in_the_folder_or_its_parent() {
        let dir = std::env::temp_dir();
        assert_eq!(starting_directory(&dir.to_string_lossy()), Some(dir.clone()));
        let missing = dir.join("deskfolk-not-there-yet");
        assert_eq!(starting_directory(&missing.to_string_lossy()), Some(dir));
        assert_eq!(starting_directory("  "), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_runnable_file_is_shown_not_opened_on_linux() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("deskfolk-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let note = dir.join("note.md");
        std::fs::write(&note, "x").unwrap();
        std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!linux_runs_when_opened(&note));
        let launcher = dir.join("tool.desktop");
        std::fs::write(&launcher, "x").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(linux_runs_when_opened(&launcher));
        let script = dir.join("run-me");
        std::fs::write(&script, "#!/bin/sh").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(linux_runs_when_opened(&script));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
