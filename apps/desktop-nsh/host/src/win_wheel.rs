//! The mouse wheel and the touchpad's scroll on Windows, forwarded to the window's app as on macOS
//! (`wheel.rs`): NSH's views hear no wheel (only its own scroll views do), so the views that zoom
//! or scroll themselves (the task map, the trace, a picture, the terminal's history) listen to
//! `host.on("shell.wheel")` through `app/src/platform/wheel.ts`. Without it they did not move.
//!
//! NSH makes the window and runs its message loop on a UI thread of its own, so the wheel is read
//! where every message of that thread passes: a `WH_GETMESSAGE` hook on it, which sees a message as
//! the loop takes it and leaves it to NSH untouched. The thread is known once its first window is
//! made: a thread of ours waits for that window and hooks the thread it belongs to (a hook on a
//! thread of the same process needs no module), then stays, as the hook lives as long as it does. The event has the macOS shell's shape: `x`, `y` in the window's points from
//! its top left (`ViewRef.measure()`'s page coordinates), `dx`, `dy` in points with positive
//! meaning down and right. A notch is `LINE` points as there; a precision touchpad sends parts of
//! one. Its pinch reaches the app as Ctrl + wheel, which is what the app takes a pinch for (`ctrl`
//! with a zoom step in `dy`), so it needs nothing of its own.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use nsh_engine::HostChannel;
use serde_json::{Value, json};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GA_ROOT, GWL_STYLE, GetAncestor, GetWindowLongW, GetWindowThreadProcessId, MSG,
    PM_REMOVE, SetWindowsHookExW, WH_GETMESSAGE, WM_MOUSEHWHEEL, WM_MOUSEWHEEL, WS_POPUP,
};
use windows::core::BOOL;

/// Points a wheel notch scrolls (WebKit's `pixelsPerLineStep`, as the macOS shell's `LINE`).
const LINE: f64 = 40.0;
/// What `WM_MOUSEWHEEL` counts a notch as.
const NOTCH: f64 = 120.0;
const MK_SHIFT: usize = 0x0004;
const MK_CONTROL: usize = 0x0008;

/// The app the wheel goes to (`send` takes any thread).
static HOST: OnceLock<HostChannel> = OnceLock::new();
/// How long the window may take to be made before the wheel is given up.
const WAIT: Duration = Duration::from_secs(60);

/// Forwards the wheel of the app's main window to `host`'s app, once NSH has made it. Called before
/// `run_app`, once.
pub fn install(host: HostChannel) {
    if HOST.set(host).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new().name("deskfolk-wheel".into()).spawn(|| {
        let start = Instant::now();
        let thread = loop {
            if let Some(thread) = ui_thread() {
                break thread;
            }
            if start.elapsed() > WAIT {
                log::warn!(target: "deskfolk::wheel", "no window came: the app's views get no wheel");
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        // SAFETY: a hook on a thread of this process, with a procedure that passes every message on.
        if let Err(why) = unsafe { SetWindowsHookExW(WH_GETMESSAGE, Some(get_message), None, thread) } {
            log::warn!(target: "deskfolk::wheel", "no wheel for the app's views: {why}");
            return;
        }
        // The hook is this thread's: it stays while the thread does.
        loop {
            std::thread::park();
        }
    });
    if let Err(why) = spawned {
        log::warn!(target: "deskfolk::wheel", "no wheel for the app's views: {why}");
    }
}

/// The thread of the first top-level window of this process: NSH's UI thread.
fn ui_thread() -> Option<u32> {
    unsafe extern "system" fn each(window: HWND, found: LPARAM) -> BOOL {
        let mut pid = 0;
        // SAFETY: plain queries; `found` is the `Option<u32>` below, alive for the enumeration.
        unsafe {
            let thread = GetWindowThreadProcessId(window, Some(&mut pid));
            if pid == GetCurrentProcessId() && thread != 0 {
                *(found.0 as *mut Option<u32>) = Some(thread);
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    let mut found: Option<u32> = None;
    // SAFETY: the callback only writes `found`, which outlives the call. Stopping early reads as an
    // error, so the result says nothing.
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut found as *mut Option<u32> as isize)) };
    found
}

unsafe extern "system" fn get_message(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // A message taken off the queue (not one only peeked at), as the hook is given it.
    if code >= 0 && wparam.0 == PM_REMOVE.0 as usize {
        // SAFETY: for `WH_GETMESSAGE`, `lparam` points at the message being taken.
        let msg = unsafe { &*(lparam.0 as *const MSG) };
        if msg.message == WM_MOUSEWHEEL || msg.message == WM_MOUSEHWHEEL {
            forward(msg);
        }
    }
    // SAFETY: the next hook gets what this one was given.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn forward(msg: &MSG) {
    // SAFETY: plain queries on the window the message is for (it may be a child: a web view).
    let window = unsafe { GetAncestor(msg.hwnd, GA_ROOT) };
    if window.is_invalid() {
        return;
    }
    // A menu or a tooltip is a popup window of its own: its wheel is not the app's.
    // SAFETY: as above.
    if unsafe { GetWindowLongW(window, GWL_STYLE) } as u32 & WS_POPUP.0 != 0 {
        return;
    }
    // The wheel's position is on the screen, in pixels.
    let mut at = POINT { x: (msg.lParam.0 & 0xFFFF) as i16 as i32, y: ((msg.lParam.0 >> 16) & 0xFFFF) as i16 as i32 };
    // SAFETY: as above.
    if !unsafe { ScreenToClient(window, &mut at) }.as_bool() {
        return;
    }
    // SAFETY: as above.
    let dpi = unsafe { GetDpiForWindow(window) };
    let scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
    // SAFETY: the keyboard state of this thread.
    let alt = unsafe { GetKeyState(i32::from(VK_MENU.0)) } < 0;
    let wheel = Wheel {
        x: f64::from(at.x) / scale,
        y: f64::from(at.y) / scale,
        delta: ((msg.wParam.0 >> 16) & 0xFFFF) as i16,
        horizontal: msg.message == WM_MOUSEHWHEEL,
        keys: msg.wParam.0 & 0xFFFF,
        alt,
    };
    if let Some(host) = HOST.get() {
        let _ = host.send("shell.wheel", payload(&wheel));
    }
}

/// A wheel message as read: where (in points), its delta and the keys held.
struct Wheel {
    x: f64,
    y: f64,
    /// `WM_MOUSEWHEEL`'s: positive away from the person (up), `WM_MOUSEHWHEEL`'s: positive right.
    delta: i16,
    horizontal: bool,
    /// The `MK_*` flags of the message.
    keys: usize,
    alt: bool,
}

fn payload(w: &Wheel) -> Value {
    let points = f64::from(w.delta) / NOTCH * LINE;
    let shift = w.keys & MK_SHIFT != 0;
    let precise = i32::from(w.delta) % NOTCH as i32 != 0;
    let (mut dx, mut dy) = if w.horizontal { (points, 0.0) } else { (0.0, -points) };
    // Shift turns a mouse's wheel sideways, as on macOS (where the system does it) and as NSH's
    // own scroll views take it.
    if shift && !precise && dx == 0.0 {
        (dx, dy) = (dy, 0.0);
    }
    json!({
        "x": w.x,
        "y": w.y,
        "dx": dx,
        "dy": dy,
        "ctrl": w.keys & MK_CONTROL != 0,
        "meta": false,
        "shift": shift,
        "alt": w.alt,
        "pinch": false,
        "phase": null,
        "momentum": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wheel(delta: i16, horizontal: bool, keys: usize) -> Value {
        payload(&Wheel { x: 10.0, y: 20.0, delta, horizontal, keys, alt: false })
    }

    #[test]
    fn a_notch_up_scrolls_up_by_a_line() {
        let up = wheel(120, false, 0);
        assert_eq!(up["dy"], -LINE);
        assert_eq!(up["dx"], 0.0);
        assert_eq!((up["x"].as_f64(), up["y"].as_f64()), (Some(10.0), Some(20.0)));
        assert_eq!(wheel(-240, false, 0)["dy"], 2.0 * LINE);
    }

    #[test]
    fn a_tilt_right_scrolls_right() {
        assert_eq!(wheel(120, true, 0)["dx"], LINE);
    }

    #[test]
    fn ctrl_zooms_as_a_pinch_does_and_shift_turns_a_notch_sideways() {
        let zoom = wheel(120, false, MK_CONTROL);
        assert_eq!(zoom["ctrl"], true);
        assert_eq!(zoom["dy"], -LINE);
        let sideways = wheel(-120, false, MK_SHIFT);
        assert_eq!((sideways["dx"].as_f64(), sideways["dy"].as_f64()), (Some(LINE), Some(0.0)));
        // A touchpad's part of a notch keeps its axis.
        assert_eq!(wheel(30, false, MK_SHIFT)["dy"], -10.0);
    }
}
