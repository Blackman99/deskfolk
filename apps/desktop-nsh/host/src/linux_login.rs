//! Launch at login on Linux, through the XDG autostart entry the Tauri app's Linux build wrote
//! (`tauri_plugin_autostart`, `auto-launch`): `~/.config/autostart/Deskfolk.desktop`, starting
//! `/usr/bin/real-bot-desktop --hidden` (the AppImage: itself, `$APPIMAGE --hidden`). Keeping that
//! entry's name and command keeps a 0.4.0 install's login start working after the upgrade, and
//! `--hidden` keeps the login launch in the tray (`gtk.rs`). NSH's own login item writes an entry
//! under the app's id with no arguments, so it is not used: it would start the app twice, with a
//! window. A dev build leaves the entry alone, as on Windows (`win_login.rs`).

use std::path::{Path, PathBuf};

/// The entry's file name, the Tauri app's (`auto-launch` names it after the app).
const ENTRY: &str = "Deskfolk.desktop";

/// `~/.config/autostart` (`$XDG_CONFIG_HOME/autostart` when that is absolute).
fn autostart_dir() -> Option<PathBuf> {
    autostart_dir_for(&|name| std::env::var(name).ok())
}

fn autostart_dir_for(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let config = env("XDG_CONFIG_HOME").filter(|dir| dir.starts_with('/')).map(PathBuf::from);
    let config = config.or_else(|| env("HOME").filter(|home| !home.is_empty()).map(|home| PathBuf::from(home).join(".config")))?;
    Some(config.join("autostart"))
}

/// What the entry starts: the AppImage itself when this runs from one, else this program as it is
/// installed (`/usr/bin/real-bot-desktop` resolves to it; the link is what the Tauri entry named).
fn program() -> Option<String> {
    if let Some(image) = std::env::var("APPIMAGE").ok().filter(|path| path.starts_with('/')) {
        return Some(image);
    }
    let linked = Path::new("/usr/bin/real-bot-desktop");
    if linked.exists() {
        return Some(linked.display().to_string());
    }
    std::env::current_exe().ok().map(|exe| exe.display().to_string())
}

/// The entry, as `auto-launch` wrote it.
fn entry(program: &str) -> String {
    let quoted = if program.contains(' ') { format!("\"{program}\"") } else { program.to_owned() };
    format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Deskfolk\nComment=Deskfolk startup script\nExec={quoted} --hidden\nStartupNotify=false\nTerminal=false\n"
    )
}

/// Whether the app launches at login now.
pub fn enabled() -> bool {
    autostart_dir().is_some_and(|dir| dir.join(ENTRY).is_file())
}

/// `set_launch_at_login({ enabled })`: the entry written or removed; whether it is there after.
pub fn set(enabled: bool) -> Result<bool, String> {
    if !crate::config::RELEASE {
        return Ok(false);
    }
    let dir = autostart_dir().ok_or("no home directory")?;
    let path = dir.join(ENTRY);
    if enabled {
        let program = program().ok_or("cannot tell where this program is")?;
        std::fs::create_dir_all(&dir).map_err(|why| format!("{}: {why}", dir.display()))?;
        std::fs::write(&path, entry(&program)).map_err(|why| format!("{}: {why}", path.display()))?;
    } else if let Err(why) = std::fs::remove_file(&path) {
        if why.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("{}: {why}", path.display()));
        }
    }
    Ok(self::enabled())
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
    fn the_entry_starts_the_installed_program_hidden_as_the_tauri_app_did() {
        let text = entry("/usr/bin/real-bot-desktop");
        assert!(text.contains("Exec=/usr/bin/real-bot-desktop --hidden\n"));
        assert!(text.contains("Name=Deskfolk\n"));
        assert!(entry("/home/a/Apps/Deskfolk 0.6.AppImage").contains("Exec=\"/home/a/Apps/Deskfolk 0.6.AppImage\" --hidden"));
    }

    #[test]
    fn the_entry_lives_in_the_users_autostart_folder() {
        let env = |vars: &'static [(&'static str, &'static str)]| move |name: &str| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string());
        assert_eq!(autostart_dir_for(&env(&[("HOME", "/home/a")])), Some(PathBuf::from("/home/a/.config/autostart")));
        assert_eq!(autostart_dir_for(&env(&[("HOME", "/home/a"), ("XDG_CONFIG_HOME", "/cfg")])), Some(PathBuf::from("/cfg/autostart")));
        assert_eq!(autostart_dir_for(&env(&[("HOME", "/home/a"), ("XDG_CONFIG_HOME", "rel")])), Some(PathBuf::from("/home/a/.config/autostart")));
        assert_eq!(autostart_dir_for(&env(&[])), None);
    }
}
