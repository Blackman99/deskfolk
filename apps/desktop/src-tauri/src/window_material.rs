//! The frosted material behind the page.
//!
//! On macOS it is the sidebar material `tauri.macos.conf.json` gives the window, there from the
//! window's birth. On Windows it is Mica, which Windows 11 draws and Windows 10 does not: the
//! window asks for it once at startup and keeps the answer for the page (`window_material`),
//! because a clear page over a window with nothing behind it shows the desktop. Where Mica is
//! refused the webview is made opaque again, so the moment before the page paints shows a plain
//! ground rather than the desktop.
//!
//! Asked for through `window_vibrancy` directly rather than Tauri's `set_effects`: that one throws
//! the answer away, and the answer is the point. Acrylic and blur are not tried in its place: both
//! lag the window on drag and resize on the Windows builds people have.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

/// What the window got. Shared with the page through the `window_material` command.
#[derive(Default)]
pub struct MaterialState {
    glass: AtomicBool,
}

impl MaterialState {
    /// The page's word for it: `glass` where the ground may show the material, `none` otherwise.
    pub fn material(&self) -> &'static str {
        if self.glass.load(Ordering::Relaxed) {
            "glass"
        } else {
            "none"
        }
    }

    fn set(&self, glass: bool) {
        self.glass.store(glass, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn window_material(state: tauri::State<'_, MaterialState>) -> &'static str {
    state.material()
}

/// The page's own ground colours (`tokens.css` `--bg`), for a webview that must stay opaque.
#[cfg(windows)]
const LIGHT_GROUND: tauri::window::Color = tauri::window::Color(238, 241, 242, 255);
#[cfg(windows)]
const DARK_GROUND: tauri::window::Color = tauri::window::Color(15, 20, 22, 255);

/// Asks the window for its material and records the answer. Once, at setup, after the window
/// exists and before it is shown.
pub fn apply(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<MaterialState>();
    #[cfg(windows)]
    {
        let Some(window) = app.get_webview_window("main") else {
            state.set(false);
            return;
        };
        // `None`: the dark-mode attribute is the theme sync's (`plugin:window|set_theme`), which the
        // page drives from its own setting, so Mica follows the app and not only the system.
        let glass = window_vibrancy::apply_mica(&window, None).is_ok();
        if !glass {
            let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
            let _ =
                window.set_background_color(Some(if dark { DARK_GROUND } else { LIGHT_GROUND }));
        }
        state.set(glass);
    }
    #[cfg(target_os = "macos")]
    {
        // The config's `windowEffects` is applied as the window is built; nothing to ask for.
        state.set(true);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        state.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::MaterialState;

    #[test]
    fn the_answer_is_none_until_the_window_has_material() {
        let state = MaterialState::default();
        assert_eq!(state.material(), "none");
        state.set(true);
        assert_eq!(state.material(), "glass");
        state.set(false);
        assert_eq!(state.material(), "none");
    }
}
