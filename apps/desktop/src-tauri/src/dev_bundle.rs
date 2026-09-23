//! Debug builds run as a bare binary. Notification Center ignores a process
//! with no bundle identifier, so `tauri dev` could not present a banner even
//! after the user allowed notifications. This wraps the debug executable in a
//! minimal `.app` and replaces the process image with that copy, keeping the
//! same pid so the dev runner still tracks it. Release builds already ship
//! inside `Deskfolk.app` and never take this path.

use std::fs;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Same identifier as the installed app, so a permission already granted in
/// System Settings applies to `tauri dev` instead of a second, never-asked app.
const BUNDLE_ID: &str = "com.real-bot.desktop";
const MARKER: &str = "REAL_BOT_DEV_BUNDLE";

pub fn reexec_inside_bundle() {
    if std::env::var_os(MARKER).is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if bundle_root(&exe).is_some() {
        return;
    }
    let Ok(app) = ensure_dev_app(&exe) else {
        return;
    };
    let bundled = app.join("Contents").join("MacOS").join(
        exe.file_name().unwrap_or_else(|| std::ffi::OsStr::new("real-bot-desktop")),
    );
    let mut command = Command::new(&bundled);
    command.args(std::env::args().skip(1));
    command.env(MARKER, "1");
    // `exec` only returns when the image could not be replaced.
    let err = command.exec();
    eprintln!("real-bot dev bundle: {err}");
}

/// `…/Foo.app` when `exe` lives at `Foo.app/Contents/MacOS/<name>`.
fn bundle_root(exe: &Path) -> Option<PathBuf> {
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

fn ensure_dev_app(exe: &Path) -> Result<PathBuf, String> {
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent".to_string())?;
    let app = dir.join("Deskfolk Dev.app");
    let macos = app.join("Contents").join("MacOS");
    fs::create_dir_all(&macos).map_err(|err| err.to_string())?;
    let name = exe
        .file_name()
        .ok_or_else(|| "executable has no name".to_string())?;
    let dest = macos.join(name);
    copy_exe(exe, &dest)?;
    let mut plist = fs::File::create(app.join("Contents").join("Info.plist"))
        .map_err(|err| err.to_string())?;
    write!(
        plist,
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>{BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>Deskfolk</string>
  <key>CFBundleDisplayName</key>
  <string>Deskfolk</string>
  <key>CFBundleExecutable</key>
  <string>{}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0-dev</string>
  <key>CFBundleVersion</key>
  <string>0</string>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>
"#,
        name.to_string_lossy()
    )
    .map_err(|err| err.to_string())?;
    sign_dev_app(&app)?;
    Ok(app)
}

fn copy_exe(src: &Path, dest: &Path) -> Result<(), String> {
    if let (Ok(src_meta), Ok(dest_meta)) = (fs::metadata(src), fs::metadata(dest)) {
        let same_bytes = src_meta.len() == dest_meta.len();
        let dest_current = match (src_meta.modified(), dest_meta.modified()) {
            (Ok(src_time), Ok(dest_time)) => dest_time >= src_time,
            _ => false,
        };
        if same_bytes && dest_current {
            return Ok(());
        }
        let _ = fs::remove_file(dest);
    }
    fs::copy(src, dest).map_err(|err| err.to_string())?;
    Ok(())
}

/// Sign the copied executable after Info.plist exists, so the signature covers the bundle id.
fn sign_dev_app(app: &Path) -> Result<(), String> {
    let status = Command::new("codesign")
        .args(["--force", "--sign", "-", "--options", "runtime", "--identifier", BUNDLE_ID])
        .arg(app)
        .status()
        .map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("codesign exited with {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_root_recognizes_only_a_real_app_layout() {
        assert_eq!(
            bundle_root(Path::new("/tmp/Deskfolk Dev.app/Contents/MacOS/real-bot-desktop")),
            Some(PathBuf::from("/tmp/Deskfolk Dev.app"))
        );
        assert_eq!(
            bundle_root(Path::new("/repo/apps/desktop/src-tauri/target/debug/real-bot-desktop")),
            None
        );
    }
}
