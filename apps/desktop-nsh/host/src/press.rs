//! Every mouse button going down in a window, forwarded to the window's app as `shell.press`
//! (`app/src/platform/press.ts`). NSH 0.4 on macOS tells an overlay about a press outside it
//! (`onPressOutside`, a `Popover` closing) only for presses that reach its own views: a press in a
//! hosted text view (the `RichEditor` of the message box) or on a `windowDrag` region (the
//! sidebar's empty space) never does, so a picker stayed open over such a click. The app closes
//! its menus from these instead, as the messenger's `pointerdown` listeners do. After 0.4.0 NSH
//! reports a click on a `windowDrag` region as a press (longbridge/nsh#901, in nightly), which
//! should cover the sidebar's case (not checked here); the message box's was not pinned down.
//!
//! `x`, `y` are the window's points from its top left (`ViewRef.measure()`'s page coordinates, as
//! `shell.wheel`'s); `button` is 0 for the primary button, 2 for the secondary one (a right click
//! or a control-click), 1 for any other. The event goes on to AppKit untouched.

use std::ptr::NonNull;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
use serde_json::json;

pub fn install(mtm: MainThreadMarker) {
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event for the duration of the call.
        let e = unsafe { event.as_ref() };
        if let Some(window) = e.window(mtm) {
            let height = window.contentView().map_or(0.0, |v| v.frame().size.height);
            let at = e.locationInWindow();
            let button = match e.r#type() {
                NSEventType::LeftMouseDown if e.modifierFlags().contains(NSEventModifierFlags::Control) => 2,
                NSEventType::LeftMouseDown => 0,
                NSEventType::RightMouseDown => 2,
                _ => 1,
            };
            crate::window::send_event(&window, "shell.press", json!({ "x": at.x, "y": height - at.y, "button": button }));
        }
        event.as_ptr()
    });
    // SAFETY: the block returns the event it was given, as a local monitor must.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown,
            &block,
        )
    };
    // The monitor lives as long as the app.
    std::mem::forget(monitor);
}
