//! `real-bot-rtc display-hold`: the Mac's main display at a lower resolution for as long as this
//! process lives. The remote screen's smooth mode asks for it: Screen Sharing sends every pixel of
//! the framebuffer, and a Retina screen at "More Space" is 4112×2658 of them, several megabytes
//! for every window switch, which the phone then decodes in JavaScript.
//!
//! The mode is set app-scoped (`kCGConfigureForAppOnly`), so macOS puts the user's own mode back
//! when this process ends, however it ends: the daemon closing stdin, the daemon dying, a crash. On
//! a clean end it restores first and says so, so the daemon knows the screen is back before the
//! phone connects again.

use std::io::{Read, Write};

use serde::Serialize;

use crate::protocol::{self, Failure, State, TYPE_CLOSE, TYPE_ERROR, TYPE_STATE};

/// helper → daemon: what the display became.
pub const TYPE_DISPLAY: u8 = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModeInfo {
    pub width: usize,
    pub height: usize,
    pub pixel_width: usize,
    pub pixel_height: usize,
    pub refresh: f64,
    pub usable: bool,
}

#[derive(Debug, Serialize)]
struct Lowered {
    width: usize,
    height: usize,
    from_width: usize,
    from_height: usize,
}

/// The mode to switch to, as an index into `modes`: one pixel per point, the current mode's shape,
/// and at least its size in points so no window has to shrink to fit; the smallest such, at the
/// current refresh rate when that is offered. It must also have fewer pixels than now.
pub fn lower_mode(current: &ModeInfo, modes: &[ModeInfo]) -> Result<usize, &'static str> {
    if current.pixel_width <= current.width {
        return Err("already_low");
    }
    let aspect = current.width as f64 / current.height as f64;
    let pixels = current.pixel_width * current.pixel_height;
    let fits = |mode: &ModeInfo| {
        mode.usable
            && mode.pixel_width == mode.width
            && mode.pixel_height == mode.height
            && (mode.width as f64 / mode.height as f64 - aspect).abs() < 0.01
            && mode.width >= current.width
            && mode.height >= current.height
            && mode.pixel_width * mode.pixel_height < pixels
    };
    let same_rate = |mode: &ModeInfo| (mode.refresh - current.refresh).abs() < 0.5;
    let pick = |filter: &dyn Fn(&ModeInfo) -> bool| {
        modes
            .iter()
            .enumerate()
            .filter(|(_, mode)| fits(mode) && filter(mode))
            .min_by(|(_, a), (_, b)| {
                (a.width * a.height)
                    .cmp(&(b.width * b.height))
                    .then(b.refresh.total_cmp(&a.refresh))
            })
            .map(|(index, _)| index)
    };
    pick(&same_rate)
        .or_else(|| pick(&|_| true))
        .ok_or("no_lower_mode")
}

fn send<T: Serialize>(frame_type: u8, value: &T) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(&protocol::encode(frame_type, value));
    let _ = stdout.flush();
}

/// Blocks until the daemon closes stdin or sends a close frame.
fn wait_for_close() {
    let mut stdin = std::io::stdin().lock();
    let mut header = [0u8; 5];
    loop {
        if stdin.read_exact(&mut header).is_err() {
            return;
        }
        let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if header[0] == TYPE_CLOSE || len > protocol::MAX_FRAME_PAYLOAD {
            return;
        }
        let mut payload = vec![0u8; len];
        if stdin.read_exact(&mut payload).is_err() {
            return;
        }
    }
}

/// The subcommand: switch, report, hold until told, restore. Returns the process's exit code.
pub fn hold() -> i32 {
    let held = match graphics::lower() {
        Ok(lowered) => lowered,
        Err((code, message)) => {
            send(TYPE_ERROR, &Failure { code, message });
            return 1;
        }
    };
    send(TYPE_DISPLAY, &held);
    wait_for_close();
    graphics::restore();
    send(TYPE_STATE, &State { state: "restored" });
    0
}

#[cfg(target_os = "macos")]
mod graphics {
    use std::ffi::c_void;

    use super::{Lowered, ModeInfo, lower_mode};

    type CGDirectDisplayID = u32;
    type CGDisplayModeRef = *mut c_void;
    type CGDisplayConfigRef = *mut c_void;
    type CFTypeRef = *const c_void;
    /// `kCGConfigureForAppOnly`: reverted when the process ends.
    const FOR_APP_ONLY: u32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        static kCGDisplayShowDuplicateLowResolutionModes: CFTypeRef;
        fn CGMainDisplayID() -> CGDirectDisplayID;
        fn CGDisplayCopyDisplayMode(display: CGDirectDisplayID) -> CGDisplayModeRef;
        fn CGDisplayCopyAllDisplayModes(display: CGDirectDisplayID, options: CFTypeRef) -> CFTypeRef;
        fn CGDisplayModeGetWidth(mode: CGDisplayModeRef) -> usize;
        fn CGDisplayModeGetHeight(mode: CGDisplayModeRef) -> usize;
        fn CGDisplayModeGetPixelWidth(mode: CGDisplayModeRef) -> usize;
        fn CGDisplayModeGetPixelHeight(mode: CGDisplayModeRef) -> usize;
        fn CGDisplayModeGetRefreshRate(mode: CGDisplayModeRef) -> f64;
        fn CGDisplayModeIsUsableForDesktopGUI(mode: CGDisplayModeRef) -> bool;
        fn CGDisplayModeRelease(mode: CGDisplayModeRef);
        fn CGBeginDisplayConfiguration(config: *mut CGDisplayConfigRef) -> i32;
        fn CGConfigureDisplayWithDisplayMode(config: CGDisplayConfigRef, display: CGDirectDisplayID, mode: CGDisplayModeRef, options: CFTypeRef) -> i32;
        fn CGCompleteDisplayConfiguration(config: CGDisplayConfigRef, option: u32) -> i32;
        fn CGCancelDisplayConfiguration(config: CGDisplayConfigRef) -> i32;
        fn CGRestorePermanentDisplayConfiguration();
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDictionaryCreate(allocator: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> CFTypeRef;
        fn CFArrayGetCount(array: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
        fn CFRelease(value: CFTypeRef);
    }

    fn info(mode: CGDisplayModeRef) -> ModeInfo {
        unsafe {
            ModeInfo {
                width: CGDisplayModeGetWidth(mode),
                height: CGDisplayModeGetHeight(mode),
                pixel_width: CGDisplayModeGetPixelWidth(mode),
                pixel_height: CGDisplayModeGetPixelHeight(mode),
                refresh: CGDisplayModeGetRefreshRate(mode),
                usable: CGDisplayModeIsUsableForDesktopGUI(mode),
            }
        }
    }

    pub fn lower() -> Result<Lowered, (&'static str, String)> {
        unsafe {
            let display = CGMainDisplayID();
            let current_ref = CGDisplayCopyDisplayMode(display);
            if current_ref.is_null() {
                return Err(("display_unreadable", "no current display mode".into()));
            }
            let current = info(current_ref);
            CGDisplayModeRelease(current_ref);
            // Non-Retina modes are left out of the list unless asked for.
            let keys = [kCGDisplayShowDuplicateLowResolutionModes];
            let values = [kCFBooleanTrue];
            let options = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
            let list = CGDisplayCopyAllDisplayModes(display, options);
            CFRelease(options);
            if list.is_null() {
                return Err(("display_unreadable", "no display modes".into()));
            }
            let refs: Vec<CGDisplayModeRef> = (0..CFArrayGetCount(list))
                .map(|index| CFArrayGetValueAtIndex(list, index) as CGDisplayModeRef)
                .collect();
            let modes: Vec<ModeInfo> = refs.iter().map(|mode| info(*mode)).collect();
            let result = match lower_mode(&current, &modes) {
                Err(code) => Err((code, format!("{}x{} at {}x{}", current.width, current.height, current.pixel_width, current.pixel_height))),
                Ok(index) => {
                    let mut config: CGDisplayConfigRef = std::ptr::null_mut();
                    let mut error = CGBeginDisplayConfiguration(&mut config);
                    if error == 0 {
                        error = CGConfigureDisplayWithDisplayMode(config, display, refs[index], std::ptr::null());
                        error = if error == 0 { CGCompleteDisplayConfiguration(config, FOR_APP_ONLY) } else { CGCancelDisplayConfiguration(config); error };
                    }
                    if error != 0 {
                        Err(("display_config_failed", format!("CGError {error}")))
                    } else {
                        let mode = modes[index];
                        Ok(Lowered { width: mode.pixel_width, height: mode.pixel_height, from_width: current.pixel_width, from_height: current.pixel_height })
                    }
                }
            };
            CFRelease(list);
            result
        }
    }

    pub fn restore() {
        unsafe { CGRestorePermanentDisplayConfiguration() }
    }
}

#[cfg(not(target_os = "macos"))]
mod graphics {
    use super::Lowered;

    pub fn lower() -> Result<Lowered, (&'static str, String)> {
        Err(("unsupported", "only macOS".into()))
    }

    pub fn restore() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(width: usize, height: usize, scale: usize, refresh: f64) -> ModeInfo {
        ModeInfo { width, height, pixel_width: width * scale, pixel_height: height * scale, refresh, usable: true }
    }

    /// This MacBook Pro's list (16", 120 Hz), trimmed: its scaled modes and the 1x ones beside them.
    fn macbook() -> Vec<ModeInfo> {
        vec![
            mode(1728, 1117, 2, 120.0),
            mode(2056, 1329, 2, 120.0),
            mode(1920, 1200, 1, 120.0),
            mode(2336, 1510, 1, 60.0),
            mode(2336, 1510, 1, 120.0),
            mode(2336, 1460, 1, 120.0),
            mode(3456, 2234, 1, 120.0),
        ]
    }

    #[test]
    fn picks_the_smallest_one_to_one_mode_that_keeps_the_shape_and_room() {
        let modes = macbook();
        // "More Space": 2056×1329 points on 4112×2658 pixels → 2336×1510 at one pixel a point.
        assert_eq!(lower_mode(&mode(2056, 1329, 2, 120.0), &modes), Ok(4));
        // "Default": 1728×1117 points → the same 2336×1510, still the smallest with room.
        assert_eq!(lower_mode(&mode(1728, 1117, 2, 120.0), &modes), Ok(4));
    }

    #[test]
    fn prefers_the_current_refresh_rate_but_takes_another() {
        let modes = vec![mode(2336, 1510, 1, 60.0)];
        assert_eq!(lower_mode(&mode(2056, 1329, 2, 120.0), &modes), Ok(0));
    }

    #[test]
    fn refuses_when_already_one_to_one_or_nothing_fits() {
        assert_eq!(lower_mode(&mode(1920, 1200, 1, 60.0), &macbook()), Err("already_low"));
        // Only smaller or differently shaped 1x modes: windows would have to shrink.
        let modes = vec![mode(1920, 1200, 1, 120.0), mode(1600, 900, 1, 60.0)];
        assert_eq!(lower_mode(&mode(2056, 1329, 2, 120.0), &modes), Err("no_lower_mode"));
        let unusable = vec![ModeInfo { usable: false, ..mode(2336, 1510, 1, 120.0) }];
        assert_eq!(lower_mode(&mode(2056, 1329, 2, 120.0), &unusable), Err("no_lower_mode"));
    }

    #[test]
    fn reports_pixel_sizes() {
        let bytes = protocol::encode(TYPE_DISPLAY, &Lowered { width: 2336, height: 1510, from_width: 4112, from_height: 2658 });
        assert_eq!(bytes[0], TYPE_DISPLAY);
        assert_eq!(&bytes[5..], br#"{"width":2336,"height":1510,"from_width":4112,"from_height":2658}"#);
    }
}
