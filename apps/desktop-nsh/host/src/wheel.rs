//! The mouse wheel, the trackpad's two-finger scroll and its pinch, forwarded to the app of the
//! window they happen in. NSH 0.4's views hear none of them (only its own scroll views do), so
//! a view that zooms or scrolls itself (the trace, a picture, the terminal's history) listens to
//! `host.on("shell.wheel")` through `app/src/platform/wheel.ts`.
//!
//! The event is the DOM's `WheelEvent` in spirit, so the messenger's handlers port unchanged:
//! `x`, `y` in the window's points from its top left (`ViewRef.measure()`'s page coordinates),
//! `dx`, `dy` in points with positive meaning down and right, and a trackpad pinch as Chromium
//! sends one: `ctrl` with `dy = -100·ln(scale)`. The event goes on to AppKit untouched.

use std::ptr::NonNull;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventPhase, NSEventType};
use serde_json::{Value, json};

/// Points a wheel notch of a mouse without precise deltas scrolls (WebKit's `pixelsPerLineStep`).
const LINE: f64 = 40.0;

pub fn install(mtm: MainThreadMarker) {
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event for the duration of the call.
        let e = unsafe { event.as_ref() };
        if let Some(window) = e.window(mtm) {
            if let Some(data) = payload(e, window.contentView().map_or(0.0, |v| v.frame().size.height)) {
                crate::window::send_event(&window, "shell.wheel", data);
            }
        }
        event.as_ptr()
    });
    // SAFETY: the block returns the event it was given, as a local monitor must.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel | NSEventMask::Magnify, &block)
    };
    // The monitor lives as long as the app.
    std::mem::forget(monitor);
}

fn phase(p: NSEventPhase) -> Option<&'static str> {
    if p.contains(NSEventPhase::Began) {
        Some("began")
    } else if p.contains(NSEventPhase::Changed) {
        Some("changed")
    } else if p.contains(NSEventPhase::Ended) {
        Some("ended")
    } else if p.contains(NSEventPhase::Cancelled) {
        Some("cancelled")
    } else if p.contains(NSEventPhase::MayBegin) {
        Some("mayBegin")
    } else {
        None
    }
}

fn payload(e: &NSEvent, height: f64) -> Option<Value> {
    let at = e.locationInWindow();
    let flags = e.modifierFlags();
    let (dx, dy, ctrl) = match e.r#type() {
        NSEventType::ScrollWheel => {
            let scale = if e.hasPreciseScrollingDeltas() { 1.0 } else { LINE };
            (-e.scrollingDeltaX() * scale, -e.scrollingDeltaY() * scale, flags.contains(NSEventModifierFlags::Control))
        }
        NSEventType::Magnify => (0.0, pinch_delta(e.magnification()), true),
        _ => return None,
    };
    Some(json!({
        "x": at.x,
        "y": height - at.y,
        "dx": dx,
        "dy": dy,
        "ctrl": ctrl,
        "meta": flags.contains(NSEventModifierFlags::Command),
        "shift": flags.contains(NSEventModifierFlags::Shift),
        "alt": flags.contains(NSEventModifierFlags::Option),
        "pinch": e.r#type() == NSEventType::Magnify,
        "phase": phase(e.phase()),
        "momentum": phase(e.momentumPhase()),
    }))
}

/// A pinch's step as a ctrl-wheel's `deltaY`: Chromium's `-100·ln(scale)`, so `exp(-dy / 100)` is
/// the step's zoom factor again.
pub fn pinch_delta(magnification: f64) -> f64 {
    -100.0 * (1.0 + magnification).max(0.01).ln()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pinch_comes_back_as_its_zoom_factor() {
        for m in [0.1, -0.1, 0.5, -0.5] {
            assert!(((-pinch_delta(m) / 100.0).exp() - (1.0 + m)).abs() < 1e-9);
        }
        assert!(pinch_delta(0.2) < 0.0, "spreading the fingers zooms in, as a wheel turned up");
    }
}
