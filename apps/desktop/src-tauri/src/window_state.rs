//! Remember the main window's last size so the next launch matches.
//!
//! Position is not stored: a saved origin can land off-screen after a display
//! change. Maximized is stored so a full-screen session comes back full-screen.
//! The file lives in the window process's app data, not the daemon data dir.
//!
//! While the user is dragging an edge, the remembered maximized flag stays as
//! it was. Asking AppKit whether the window is zoomed from inside a live
//! resize moves the window, so that question waits until the drag ends.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

pub const FILENAME: &str = "window-size.json";
pub const DEFAULT_WIDTH: f64 = 1100.0;
pub const DEFAULT_HEIGHT: f64 = 760.0;
pub const MIN_WIDTH: f64 = 640.0;
pub const MIN_HEIGHT: f64 = 480.0;
const MAX_EDGE: f64 = 10_000.0;

static READY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for WindowSize {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            maximized: false,
        }
    }
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILENAME)
}

pub fn mark_ready() {
    READY.store(true, Ordering::SeqCst);
}

pub fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

pub fn clamp(size: WindowSize) -> WindowSize {
    WindowSize {
        width: clamp_edge(size.width, MIN_WIDTH),
        height: clamp_edge(size.height, MIN_HEIGHT),
        maximized: size.maximized,
    }
}

pub fn from_physical(width: u32, height: u32, scale: f64, maximized: bool) -> WindowSize {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    clamp(WindowSize {
        width: f64::from(width) / scale,
        height: f64::from(height) / scale,
        maximized,
    })
}

/// A maximized or fullscreen frame must not overwrite the last restored size.
pub fn snapshot(
    width: u32,
    height: u32,
    scale: f64,
    maximized: bool,
    previous: &WindowSize,
) -> WindowSize {
    if maximized {
        WindowSize {
            width: previous.width,
            height: previous.height,
            maximized: true,
        }
    } else {
        from_physical(width, height, scale, false)
    }
}

pub fn load(dir: &Path) -> WindowSize {
    let text = match fs::read_to_string(path(dir)) {
        Ok(text) => text,
        Err(_) => return WindowSize::default(),
    };
    match serde_json::from_str::<WindowSize>(&text) {
        Ok(size) if size.width.is_finite() && size.height.is_finite() => clamp(size),
        _ => WindowSize::default(),
    }
}

pub fn save(dir: &Path, size: &WindowSize) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let body = serde_json::to_vec_pretty(size)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
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
        let dir = std::env::temp_dir().join(format!(
            "real-bot-window-state-{}-{}",
            std::process::id(),
            name
        ));
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
        let size = WindowSize {
            width: 1440.0,
            height: 900.0,
            maximized: true,
        };
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
        let tiny = clamp(WindowSize {
            width: 10.0,
            height: 10.0,
            maximized: false,
        });
        assert_eq!(tiny.width, MIN_WIDTH);
        assert_eq!(tiny.height, MIN_HEIGHT);
        let huge = clamp(WindowSize {
            width: 99_999.0,
            height: f64::INFINITY,
            maximized: true,
        });
        assert_eq!(huge.width, MAX_EDGE);
        assert_eq!(huge.height, MIN_HEIGHT);
        assert!(huge.maximized);
    }

    #[test]
    fn from_physical_stores_logical_points() {
        let size = from_physical(2200, 1520, 2.0, false);
        assert_eq!(size.width, 1100.0);
        assert_eq!(size.height, 760.0);
        assert!(!size.maximized);
        let fallback = from_physical(1100, 760, 0.0, true);
        assert_eq!(fallback.width, 1100.0);
        assert_eq!(fallback.height, 760.0);
        assert!(fallback.maximized);
    }

    #[test]
    fn snapshot_keeps_last_restored_size_while_maximized() {
        let previous = WindowSize {
            width: 1440.0,
            height: 900.0,
            maximized: false,
        };
        let zoomed = snapshot(3024, 1964, 2.0, true, &previous);
        assert_eq!(zoomed.width, 1440.0);
        assert_eq!(zoomed.height, 900.0);
        assert!(zoomed.maximized);
        let restored = snapshot(2880, 1800, 2.0, false, &previous);
        assert_eq!(restored.width, 1440.0);
        assert_eq!(restored.height, 900.0);
        assert!(!restored.maximized);
    }
}
