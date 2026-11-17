//! Launch at login on Windows: the `Deskfolk` value under the current user's `Run` key, the one the
//! Tauri app's autostart wrote, holding this program and `--hidden` (the window starts hidden and
//! the app waits in the notification area, `win.rs`). `set_launch_at_login` writes or removes it
//! (Settings › General); a release also makes it follow that setting as it starts (`sync`), so an
//! install that came over the Tauri app keeps launching at login only if the setting says so, and
//! the value always names the program that is there now. A dev build answers `false` and changes
//! nothing, as on the Mac (`login_item.rs`).

use std::path::Path;

use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, WIN32_ERROR};
use windows::Win32::System::Registry::{
    HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW,
};
use windows::core::w;

const RUN_KEY: windows::core::PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");
const VALUE: windows::core::PCWSTR = w!("Deskfolk");

/// What the `Run` value holds for `exe`: the program, quoted, and `--hidden`.
pub fn command_line(exe: &Path) -> String {
    format!("\"{}\" --hidden", exe.display())
}

/// Whether a `Run` value starts the app at login.
pub fn enabled() -> bool {
    let mut size = 0u32;
    // SAFETY: a size query with no buffer.
    let found = unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE, RRF_RT_REG_SZ, None, None, Some(&mut size)) };
    found.is_ok()
}

/// `set_launch_at_login({ enabled })`: the value written or removed; the state afterwards.
pub fn set(enabled: bool) -> Result<bool, String> {
    if !crate::config::RELEASE {
        return Ok(false);
    }
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let line: Vec<u16> = command_line(&exe).encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated wide string and its size in bytes, alive for the call.
        let done = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                RUN_KEY,
                VALUE,
                REG_SZ.0,
                Some(line.as_ptr().cast()),
                (line.len() * std::mem::size_of::<u16>()) as u32,
            )
        };
        check(done)?;
    } else {
        // SAFETY: plain strings.
        let done = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE) };
        if done != ERROR_FILE_NOT_FOUND {
            check(done)?;
        }
    }
    Ok(self::enabled())
}

fn check(code: WIN32_ERROR) -> Result<(), String> {
    if code.is_ok() { Ok(()) } else { Err(format!("the Run key answered error {}", code.0)) }
}

/// A release's start: launch at login follows the setting (`launch_at_login`, on unless turned
/// off), read from the runtime once it answers. On a thread of its own: it waits on the network.
pub fn sync(endpoint: crate::endpoint::Endpoint) {
    if !crate::config::RELEASE {
        return;
    }
    std::thread::spawn(move || {
        let Some(wanted) = crate::endpoint::launch_at_login_setting(&endpoint) else {
            log::warn!("launch at login left as it is: the settings did not answer");
            return;
        };
        match set(wanted) {
            Ok(now) => log::info!("launch at login {}", if now { "on" } else { "off" }),
            Err(why) => log::warn!("launch at login: {why}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_value_starts_this_program_hidden() {
        assert_eq!(
            command_line(Path::new(r"C:\Users\a\AppData\Local\Deskfolk\real-bot-desktop.exe")),
            r#""C:\Users\a\AppData\Local\Deskfolk\real-bot-desktop.exe" --hidden"#
        );
    }
}
