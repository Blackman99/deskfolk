//! The windows' last size, so the next one opens at it: the Tauri app's `window_state.rs`, kept as it
//! was. Width and height in points and whether the window was maximized (or full screen, which comes
//! back zoomed); no position, since a saved origin can land off screen after a display change.
//!
//! The file sits in the window's own NSH data directory (`config::nsh_data_dir`), not beside the
//! runtime's files. A shell that has none yet takes the Tauri app's (`window-size.json` in its app
//! data directory, `~/Library/Application Support/<bundle id>`), so a Mac that ran the Tauri app
//! opens at the size it had there.
//!
//! macOS only: Windows and Linux keep theirs through NSH's own `restoreBounds` (`win.rs`, `gtk.rs`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILENAME: &str = "window-size.json";
pub const DEFAULT_WIDTH: f64 = 1100.0;
pub const DEFAULT_HEIGHT: f64 = 760.0;
pub const MIN_WIDTH: f64 = 640.0;
pub const MIN_HEIGHT: f64 = 480.0;
const MAX_EDGE: f64 = 10_000.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for WindowSize {
    fn default() -> Self {
        Self { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false }
    }
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILENAME)
}

pub fn clamp(size: WindowSize) -> WindowSize {
    WindowSize { width: clamp_edge(size.width, MIN_WIDTH), height: clamp_edge(size.height, MIN_HEIGHT), maximized: size.maximized }
}

/// What to keep of a window `width` × `height` points now: a maximized or full-screen one keeps the
/// size it had before, so un-maximizing next time returns to it. `zoomed` is `None` while an edge is
/// being dragged (AppKit cannot be asked then, `window.rs`): the flag stays what it was.
pub fn snapshot(width: f64, height: f64, zoomed: Option<bool>, previous: &WindowSize) -> WindowSize {
    match zoomed {
        Some(true) => WindowSize { width: previous.width, height: previous.height, maximized: true },
        Some(false) => clamp(WindowSize { width, height, maximized: false }),
        None => clamp(WindowSize { width, height, maximized: previous.maximized }),
    }
}

/// The saved size, or the default for a missing or unreadable file.
pub fn load(dir: &Path) -> WindowSize {
    read(&path(dir)).unwrap_or_default()
}

/// The saved size; with none saved yet, the one `legacy` (the Tauri app's directory) holds.
pub fn load_or_import(dir: &Path, legacy: Option<&Path>) -> WindowSize {
    read(&path(dir)).or_else(|| legacy.and_then(|dir| read(&path(dir)))).unwrap_or_default()
}

fn read(file: &Path) -> Option<WindowSize> {
    let text = fs::read_to_string(file).ok()?;
    match serde_json::from_str::<WindowSize>(&text) {
        Ok(size) if size.width.is_finite() && size.height.is_finite() => Some(clamp(size)),
        _ => None,
    }
}

pub fn save(dir: &Path, size: &WindowSize) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let body = serde_json::to_vec_pretty(size).map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    fs::write(path(dir), body)
}

fn clamp_edge(value: f64, min: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.round().clamp(min, MAX_EDGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deskfolk-window-state-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_is_the_configured_default() {
        let dir = scratch("missing");
        assert_eq!(load(&dir), WindowSize::default());
        assert_eq!(WindowSize::default().width, DEFAULT_WIDTH);
        assert_eq!(WindowSize::default().height, DEFAULT_HEIGHT);
        assert!(!WindowSize::default().maximized);
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = scratch("roundtrip");
        let size = WindowSize { width: 1440.0, height: 900.0, maximized: true };
        save(&dir, &size).unwrap();
        assert_eq!(load(&dir), size);
    }

    #[test]
    fn garbage_or_partial_json_falls_back() {
        let dir = scratch("garbage");
        fs::write(path(&dir), "not-json").unwrap();
        assert_eq!(load(&dir), WindowSize::default());
        fs::write(path(&dir), "{\"width\":0}").unwrap();
        assert_eq!(load(&dir), WindowSize::default());
        fs::write(path(&dir), "{\"width\":0,\"height\":0}").unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.width, MIN_WIDTH);
        assert_eq!(loaded.height, MIN_HEIGHT);
        assert!(!loaded.maximized);
    }

    #[test]
    fn clamps_tiny_huge_and_non_finite() {
        let tiny = clamp(WindowSize { width: 10.0, height: 10.0, maximized: false });
        assert_eq!(tiny.width, MIN_WIDTH);
        assert_eq!(tiny.height, MIN_HEIGHT);
        let huge = clamp(WindowSize { width: 99_999.0, height: f64::INFINITY, maximized: true });
        assert_eq!(huge.width, MAX_EDGE);
        assert_eq!(huge.height, MIN_HEIGHT);
        assert!(huge.maximized);
    }

    #[test]
    fn a_maximized_window_keeps_the_size_it_had_before() {
        let previous = WindowSize { width: 1200.0, height: 800.0, maximized: false };
        assert_eq!(snapshot(2560.0, 1400.0, Some(true), &previous), WindowSize { width: 1200.0, height: 800.0, maximized: true });
        assert_eq!(snapshot(1300.4, 820.0, Some(false), &previous), WindowSize { width: 1300.0, height: 820.0, maximized: false });
        // Mid-drag the flag stays as it was.
        let zoomed = WindowSize { maximized: true, ..previous };
        assert!(snapshot(1000.0, 700.0, None, &zoomed).maximized);
    }

    #[test]
    fn the_tauri_apps_size_is_taken_until_one_of_ours_is_saved() {
        let ours = scratch("ours");
        let tauri = scratch("tauri");
        save(&tauri, &WindowSize { width: 2364.0, height: 1410.0, maximized: false }).unwrap();
        assert_eq!(load_or_import(&ours, Some(&tauri)).width, 2364.0);
        save(&ours, &WindowSize { width: 1000.0, height: 700.0, maximized: false }).unwrap();
        assert_eq!(load_or_import(&ours, Some(&tauri)).width, 1000.0);
        assert_eq!(load_or_import(&scratch("none"), None), WindowSize::default());
    }
}
