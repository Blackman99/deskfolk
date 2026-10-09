//! Debug builds run as a bare binary. Notification Center ignores a process
//! with no bundle identifier, so `tauri dev` could not present a banner even
//! after the user allowed notifications. This wraps the debug executable in a
//! minimal `.app` and replaces the process image with that copy, keeping the
//! same pid so the dev runner still tracks it. Release builds already ship
//! inside `Deskfolk.app` and never take this path.

use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Same identifier as the installed app, so a permission already granted in
/// System Settings applies to `tauri dev` instead of a second, never-asked app.
const BUNDLE_ID: &str = "com.real-bot.desktop";
const MARKER: &str = "REAL_BOT_DEV_BUNDLE";
/// Tauri only sets the Dock's icon at runtime in dev; Stage Manager reads the
/// bundle's own, so without this one the window showed a blank app there.
const ICON_FILE: &str = "icon.icns";
const ICON: &[u8] = include_bytes!("../icons/icon.icns");
/// The app's own entitlements: the dev app is signed with the hardened runtime too, which keeps
/// the microphone shut without them (the composer's voice input, ADR 0073).
const ENTITLEMENTS: &str = include_str!("../Entitlements.plist");
/// Same words as `Info.plist`, which only the release bundle gets; macOS refuses the microphone to
/// an app that does not say why it wants it.
const MICROPHONE_USAGE: &str =
    "Deskfolk records what you say into the message box and turns it into text with the speech service you set up.";

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
    let icon_changed = write_icon(&app)?;
    fs::write(app.join("Contents").join("Info.plist"), info_plist(&name.to_string_lossy()))
        .map_err(|err| err.to_string())?;
    sign_dev_app(&app)?;
    if icon_changed {
        register(&app);
    }
    Ok(app)
}

fn info_plist(executable: &str) -> String {
    format!(
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
  <string>{executable}</string>
  <key>CFBundleIconFile</key>
  <string>{ICON_FILE}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0-dev</string>
  <key>CFBundleVersion</key>
  <string>0</string>
  <key>LSUIElement</key>
  <false/>
  <key>NSMicrophoneUsageDescription</key>
  <string>{MICROPHONE_USAGE}</string>
</dict>
</plist>
"#
    )
}

/// Rewritten only when it differs; `true` when it was, so the bundle needs registering again.
fn write_icon(app: &Path) -> Result<bool, String> {
    let resources = app.join("Contents").join("Resources");
    fs::create_dir_all(&resources).map_err(|err| err.to_string())?;
    let icon = resources.join(ICON_FILE);
    if fs::read(&icon).is_ok_and(|current| current == ICON) {
        return Ok(false);
    }
    fs::write(&icon, ICON).map_err(|err| err.to_string())?;
    Ok(true)
}

/// Launch Services and the icon cache keep what they read when they first saw the bundle: a
/// rewritten Info.plist changes neither, so a dev app made before it had an icon kept showing a
/// blank one. The icon cache goes by the bundle directory's own mtime, which writing files inside
/// it never moves, so bump that before registering again.
fn register(app: &Path) {
    let _ = bump_mtime(app);
    let _ = Command::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
    .arg("-f")
    .arg(app)
    .status();
}

fn bump_mtime(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir)?.set_modified(std::time::SystemTime::now())
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
    // Beside the bundle, not in it: a file inside Contents would have to be sealed too.
    let entitlements = app.with_file_name("Deskfolk Dev.entitlements");
    if fs::read_to_string(&entitlements).ok().as_deref() != Some(ENTITLEMENTS) {
        fs::write(&entitlements, ENTITLEMENTS).map_err(|err| err.to_string())?;
    }
    let status = Command::new("codesign")
        .args(["--force", "--sign", "-", "--options", "runtime", "--identifier", BUNDLE_ID])
        .arg("--entitlements")
        .arg(&entitlements)
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

    #[test]
    fn the_dev_app_carries_the_app_icon() {
        let app = std::env::temp_dir().join(format!("dev-bundle-icon-{}.app", std::process::id()));
        let _ = fs::remove_dir_all(&app);
        assert!(write_icon(&app).unwrap());
        assert!(!write_icon(&app).unwrap(), "an unchanged icon is not written again");
        let written = fs::read(app.join("Contents").join("Resources").join(ICON_FILE)).unwrap();
        assert_eq!(written, include_bytes!("../icons/icon.icns"));
        assert!(info_plist("real-bot-desktop")
            .contains(&format!("<key>CFBundleIconFile</key>\n  <string>{ICON_FILE}</string>")));

        let plist = info_plist("real-bot-desktop");
        assert!(plist.contains(&format!("<key>NSMicrophoneUsageDescription</key>\n  <string>{MICROPHONE_USAGE}</string>")));
        assert!(
            include_str!("../Info.plist").contains(&format!("<string>{MICROPHONE_USAGE}</string>")),
            "the dev app asks for the microphone in the release bundle's words"
        );
        assert!(ENTITLEMENTS.contains("<key>com.apple.security.device.audio-input</key>\n  <true/>"));

        let long_ago = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        fs::File::open(&app).unwrap().set_modified(long_ago).unwrap();
        bump_mtime(&app).unwrap();
        assert!(fs::metadata(&app).unwrap().modified().unwrap() > long_ago);
        let _ = fs::remove_dir_all(&app);
    }
}
