//! Keys pressed while an input method composes go to it, past NSH's keymap.
//!
//! NSH 0.4.0's keymap is a local key monitor that matches every key down before AppKit dispatches
//! it, and a focused `RichEditor` (the message box) binds Backspace, Delete, Return, Escape, Tab and
//! the arrows `When::Always`. So while pinyin was being composed, Backspace ran the editor's command
//! (which does nothing during a composition) and never reached the input method: the pinyin could
//! not be shortened, only Space got out of it. Return and the arrows were taken the same way.
//!
//! NSH fixed this after 0.4.0 (longbridge/nsh#1387): its monitor leaves every key alone while the
//! focused text view has marked text. Until a release with it, the app's `NSApplication` subclass
//! does the same ahead of every monitor: its `sendEvent:` hands such a key straight to its window,
//! as AppKit would after the monitors, so NSH's never sees it. (A monitor of our own can't do it:
//! AppKit calls local monitors in no fixed order, so it ran after NSH's about half the time.) Keys
//! with Command or Control go on as before: the menus' key equivalents are AppKit's to try first.
//! Remove this with an NSH release past 0.4.0.

use objc2::rc::Retained;
use objc2::runtime::NSObjectProtocol;
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSResponder, NSTextInputClient, NSTextView};

define_class!(
    #[unsafe(super(NSApplication, NSResponder, objc2_foundation::NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskfolkNshApplication"]
    struct Application;

    unsafe impl NSObjectProtocol for Application {}

    impl Application {
        #[unsafe(method(sendEvent:))]
        fn send_event(&self, event: &NSEvent) {
            if !to_input_method(event, self.mtm()) {
                // SAFETY: NSApplication's own `sendEvent:`, with the event it was given.
                let _: () = unsafe { msg_send![super(self), sendEvent: event] };
            }
        }
    }
);

/// The app, made as [`Application`] (on the main thread, before anything else asks for `NSApp`).
pub fn application(_mtm: MainThreadMarker) -> Retained<NSApplication> {
    // SAFETY: `+sharedApplication` on an NSApplication subclass makes `NSApp` of that class (or
    // returns the one there is), as NSApplicationMain does with a principal class.
    let app: Retained<NSApplication> = unsafe { msg_send![Application::class(), sharedApplication] };
    if !app.isKindOfClass(Application::class()) {
        log::warn!("NSApp was made before the shell's application class: keys typed while an input method composes may not reach it");
    }
    app
}

/// Delivers key-down `event` to its window when the window's focused text view has marked text (an
/// input method is composing) and no Command or Control is held. True if it did.
fn to_input_method(event: &NSEvent, mtm: MainThreadMarker) -> bool {
    if event.r#type() != NSEventType::KeyDown {
        return false;
    }
    if event.modifierFlags().intersects(NSEventModifierFlags::Command | NSEventModifierFlags::Control) {
        return false;
    }
    let Some(window) = event.window(mtm) else {
        return false;
    };
    let composing = window
        .firstResponder()
        .and_then(|r| r.downcast::<NSTextView>().ok())
        .is_some_and(|t| t.hasMarkedText());
    if !composing {
        return false;
    }
    window.sendEvent(event);
    true
}
