//! Handing a path, a link or the clipboard's text to the operating system: Open and Show in
//! Finder for workspace files, external links, and Paste in the terminal's right-click menu.
//! macOS uses `open`, Windows the shell's own calls, Linux `xdg-open` and the file manager's
//! `org.freedesktop.FileManager1` D-Bus interface.

#[tauri::command]
pub fn open_workspace_path(path: String, reveal: bool) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.is_absolute() {
        return Err("path must be absolute".into());
    }
    if !target.exists() {
        return Err("path does not exist".into());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(&path)
            .status()
            .map_err(|err| err.to_string())
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("open failed".into())
                }
            })
    }
    #[cfg(windows)]
    {
        // ShellExecute's "open" runs an .exe, .bat, .js or .lnk, and a file a Bot wrote carries
        // no mark-of-the-web for SmartScreen to stop. A type Windows itself rates dangerous is
        // shown in Explorer instead, where running it is the person's own double-click.
        if reveal || (target.is_file() && windows_is_dangerous_type(target)) {
            windows_reveal_in_explorer(&path)
        } else {
            windows_shell_open(&path)
        }
    }
    #[cfg(target_os = "linux")]
    {
        // xdg-open hands a .desktop file, an executable or a script to whatever runs it on some
        // desktops, and a file a Bot wrote is not one the person has looked at. Those are shown
        // in the file manager instead, as on Windows, where running one is their own double-click.
        if reveal || (target.is_file() && linux_runs_when_opened(target)) {
            linux_reveal(target);
            Ok(())
        } else {
            linux_xdg_open(&path)
        }
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = reveal;
        Err("open with system is only on macOS, Windows and Linux".into())
    }
}

/// Extensions a Linux desktop may run rather than show when the file is opened: launchers,
/// scripts, programs, packages that install themselves, and Windows programs Wine would start.
#[cfg(any(target_os = "linux", all(test, unix)))]
const LINUX_RUNNABLE_EXTENSIONS: &[&str] = &[
    "desktop", "sh", "bash", "zsh", "ksh", "csh", "fish", "run", "bin", "appimage", "jar", "py",
    "pl", "rb", "x86_64", "exe", "msi", "com", "bat", "cmd", "flatpakref", "flatpakrepo",
];

/// A file whose execute bit is set, or whose extension a desktop may run when it is opened.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_runs_when_opened(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let executable = std::fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(true);
    let runnable_extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .is_some_and(|ext| LINUX_RUNNABLE_EXTENSIONS.contains(&ext.as_str()));
    executable || runnable_extension
}

/// `file://` plus the path, every byte outside `[A-Za-z0-9/._~-]` percent-encoded. Commas too,
/// which a URI may carry bare, because `dbus-send` reads `array:string:` items comma-separated.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_file_uri(path: &std::path::Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut uri = String::from("file://");
    for &byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || b"/._~-".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// `xdg-open`, not waited for: with no desktop helper it may run the handler in the foreground
/// for as long as that stays open, and this command runs on the main thread. A thread reaps it.
#[cfg(target_os = "linux")]
fn linux_xdg_open(target: &str) -> Result<(), String> {
    let mut child = std::process::Command::new("xdg-open")
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|err| format!("xdg-open: {err}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Shows the file or folder selected in the file manager (`FileManager1.ShowItems`, which
/// Nautilus, Dolphin, Nemo, Caja and Thunar answer), else opens the folder it is in. Off the main
/// thread: the call waits for the file manager to start.
#[cfg(target_os = "linux")]
fn linux_reveal(target: &std::path::Path) {
    let uri = linux_file_uri(target);
    let parent = target
        .parent()
        .unwrap_or(std::path::Path::new("/"))
        .to_string_lossy()
        .into_owned();
    std::thread::spawn(move || {
        let shown = std::process::Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--reply-timeout=10000",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
            ])
            .arg(format!("array:string:{uri}"))
            .arg("string:")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !shown {
            let _ = linux_xdg_open(&parent);
        }
    });
}

/// Does Windows rate this file's type a security risk to open — executables,
/// scripts, shortcuts, installers (`AssocIsDangerous`, the list Explorer and
/// Attachment Manager use)? A file with no extension opens the "Open with"
/// picker, which runs nothing.
#[cfg(windows)]
fn windows_is_dangerous_type(path: &std::path::Path) -> bool {
    use windows_sys::Win32::UI::Shell::AssocIsDangerous;
    let Some(ext) = path.extension() else {
        return false;
    };
    let assoc: Vec<u16> = format!(".{}", ext.to_string_lossy())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: a NUL-terminated UTF-16 buffer that outlives the call.
    unsafe { AssocIsDangerous(assoc.as_ptr()) != 0 }
}

/// `explorer.exe /select,"<path>"`, which highlights the file/folder in a
/// Finder-style window rather than opening it. `/select,` wants exactly this
/// form glued to the path — `raw_arg` keeps it literal instead of the normal
/// argument quoting `.arg()` would apply. Explorer's own exit code is not a
/// reliable success signal (observed non-zero on success), so only a failure
/// to launch the process at all is reported as an error.
#[cfg(windows)]
fn windows_reveal_in_explorer(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.raw_arg(format!("/select,\"{path}\""));
    crate::daemon::suppress_console_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|err| err.to_string())
}

/// `ShellExecuteW(NULL, "open", <target>, NULL, NULL, SW_SHOWNORMAL)`: the
/// Windows equivalent of macOS `open` — opens a file/folder with its default
/// handler, or a URL with the default browser/mail client.
#[cfg(windows)]
fn windows_shell_open(target: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let verb = wide("open");
    let file = wide(target);
    // SAFETY: `verb` and `file` are NUL-terminated UTF-16 buffers kept alive
    // for the duration of this call; the rest of the arguments are optional.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Per ShellExecute's own contract, a return value over 32 is success;
    // anything else is one of the SE_ERR_* instance-value error codes.
    if (result as isize) > 32 {
        Ok(())
    } else {
        Err(format!("open failed: {result:?}"))
    }
}

fn is_allowed_external_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed != url || url.is_empty() {
        return false;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("mailto:")
        || url == SHARING_SETTINGS_URL
}

/// System Settings' Sharing pane, where Screen Sharing is turned on for the remote screen. The one
/// settings address the window may open; any other `x-apple.systempreferences:` stays refused.
const SHARING_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.Sharing-Settings.extension";

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !is_allowed_external_url(&url) && !crate::updates::is_allowed_release_url(&url) {
        return Err("url not allowed".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-u")
            .arg(&url)
            .status()
            .map_err(|err| err.to_string())
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("open failed".into())
                }
            })
    }
    #[cfg(windows)]
    {
        windows_shell_open(&url)
    }
    #[cfg(target_os = "linux")]
    {
        linux_xdg_open(&url)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        Err("open with system is only on macOS, Windows and Linux".into())
    }
}

/// The pasteboard's text, for Paste in the terminal's right-click menu. WebKit's own
/// `clipboard.readText` stops for a second confirming click, which no terminal asks for;
/// ⌘V never comes here, it is the Edit menu's paste into the focused field. A command that is
/// not `async` runs on the main thread, which is where GTK's clipboard has to be read on Linux;
/// `wait_for_text` turns the main loop while it waits for whichever app owns the clipboard.
#[tauri::command]
pub fn read_clipboard_text() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        let pasteboard = NSPasteboard::generalPasteboard();
        // SAFETY: an AppKit constant, initialised before any code of ours runs.
        let kind = unsafe { NSPasteboardTypeString };
        pasteboard.stringForType(kind).map(|text| text.to_string())
    }
    #[cfg(windows)]
    {
        windows_clipboard_text()
    }
    #[cfg(target_os = "linux")]
    {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD)
            .wait_for_text()
            .map(|text| text.to_string())
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        None
    }
}

/// The Win32 clipboard as Unicode text. `OpenClipboard` can transiently fail
/// while another process (a copy just finished elsewhere) holds it, so a
/// handful of short retries ride that out instead of failing the paste.
#[cfg(windows)]
fn windows_clipboard_text() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;
    const OPEN_ATTEMPTS: u32 = 5;

    let mut opened = false;
    for attempt in 0..OPEN_ATTEMPTS {
        // SAFETY: a null owner window asks for the clipboard without
        // associating it with one of ours.
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        if attempt + 1 < OPEN_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    if !opened {
        return None;
    }
    // SAFETY: the clipboard is open for the whole block below and is always
    // closed before this function returns, on every path.
    let text = unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT);
        if handle.is_null() {
            None
        } else {
            let ptr = GlobalLock(handle) as *const u16;
            if ptr.is_null() {
                None
            } else {
                // The handle owns NUL-terminated UTF-16 text; find the NUL rather
                // than trusting `GlobalSize` not to include allocator padding.
                let mut len = 0usize;
                while *ptr.add(len) != 0 {
                    len += 1;
                }
                let value = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                GlobalUnlock(handle);
                Some(value)
            }
        }
    };
    unsafe { CloseClipboard() };
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_linux_file_uri_encodes_everything_dbus_send_or_a_uri_could_misread() {
        use std::path::Path;
        assert_eq!(linux_file_uri(Path::new("/home/me/notes.md")), "file:///home/me/notes.md");
        assert_eq!(
            linux_file_uri(Path::new("/home/me/a b,c/目录#1.md")),
            "file:///home/me/a%20b%2Cc/%E7%9B%AE%E5%BD%95%231.md"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_linux_might_run_is_shown_instead_of_opened() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rb-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, mode: u32| {
            let path = dir.join(name);
            std::fs::write(&path, "x").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            path
        };
        for risky in ["app.desktop", "install.SH", "tool.AppImage", "run.py", "setup.exe"] {
            assert!(linux_runs_when_opened(&write(risky, 0o644)), "{risky}");
        }
        assert!(linux_runs_when_opened(&write("no-extension-but-executable", 0o755)));
        for plain in ["notes.md", "report.pdf", "shot.png", "data.csv", "page.html", "Makefile"] {
            assert!(!linux_runs_when_opened(&write(plain, 0o644)), "{plain}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn opening_a_type_windows_rates_dangerous_reveals_it_instead() {
        use std::path::Path;
        for risky in ["setup.exe", "run.BAT", "a.cmd", "x.ps1", "y.js", "z.vbs", "go.lnk", "i.msi", "h.hta"] {
            assert!(windows_is_dangerous_type(Path::new(risky)), "{risky}");
        }
        for plain in ["notes.md", "report.pdf", "shot.png", "data.csv", "page.html", "Makefile"] {
            assert!(!windows_is_dangerous_type(Path::new(plain)), "{plain}");
        }
    }

    #[test]
    fn is_allowed_external_url_validates_scheme_and_rejects_unsafe() {
        assert!(is_allowed_external_url("https://example.com"));
        assert!(is_allowed_external_url("http://example.com/path?q=1#frag"));
        assert!(is_allowed_external_url("mailto:dev@real-bot.local"));
        assert!(is_allowed_external_url("x-apple.systempreferences:com.apple.Sharing-Settings.extension"));
        assert!(!is_allowed_external_url("x-apple.systempreferences:com.apple.preference.security"));
        assert!(!is_allowed_external_url("file:///etc/passwd"));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url("data:text/html,x"));
        assert!(!is_allowed_external_url(""));
        assert!(!is_allowed_external_url("   https://example.com"));
        assert!(!is_allowed_external_url("https://example.com   "));
        assert!(!is_allowed_external_url("https://example.com\nevil"));
        assert!(!is_allowed_external_url("https://example.com evil"));
    }
}
