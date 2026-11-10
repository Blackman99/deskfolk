//! Where an input method opens its candidates, when the text view cannot tell.
//!
//! NSH 0.4.0's `RichEditor` (the message box) takes typed text in a "sink": an invisible multiline
//! text view one point wide, kept at the caret. It keeps the text committed into it until it holds
//! 256 bytes, so after the first commit the next composition starts past it. One point wide, every
//! character is a line of its own; the view grows downwards while only the line at the caret shows.
//! For a marked range past the first lines AppKit's `firstRectForCharacterRange:actualRange:`
//! answered `{0, 0, 0, 0}`, and the input method opened its candidates at the screen's bottom-left
//! corner: the first composition after a focus showed them under the caret, every later one there.
//!
//! The shell wraps `NSTextView`'s method: when AppKit's rect has no height, it answers the top line
//! of what the view shows instead, in screen coordinates. For the sink that is the line at the
//! caret, which is what the first composition got. A rect AppKit can tell is passed on untouched.
//! Remove this when an NSH release no longer keeps committed text in the sink (no upstream change
//! for it yet).

use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ClassType, sel};
use objc2_app_kit::{NSTextView, NSView};
use objc2_foundation::{NSPoint, NSRange, NSRect, NSSize};

/// `firstRectForCharacterRange:actualRange:`'s implementation.
type FirstRect = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSRange, *mut NSRange) -> NSRect;

/// AppKit's own implementation, called first.
static APPKIT: OnceLock<FirstRect> = OnceLock::new();

/// At most this tall, the line the candidates open under (the sink's is 16).
const LINE: f64 = 20.0;

pub fn install() {
    let class: &AnyClass = NSTextView::class();
    let name = sel!(firstRectForCharacterRange:actualRange:);
    let Some(method) = class.instance_method(name) else {
        log::warn!("ime_rect: NSTextView has no firstRectForCharacterRange:actualRange:");
        return;
    };
    // SAFETY: the method's implementation has the method's signature, which `FirstRect` spells out
    // (self, _cmd, an NSRange, an NSRangePointer; an NSRect back).
    let appkit = unsafe { std::mem::transmute::<Imp, FirstRect>(method.implementation()) };
    if APPKIT.set(appkit).is_err() {
        return;
    }
    // SAFETY: `first_rect` has the same signature; `class_replaceMethod` adds it to NSTextView
    // itself, with the method's own type encoding, whether NSTextView defines it or inherits it.
    unsafe {
        let types = objc2::ffi::method_getTypeEncoding(method);
        let ours = std::mem::transmute::<FirstRect, Imp>(first_rect);
        objc2::ffi::class_replaceMethod(class as *const AnyClass as *mut AnyClass, name, ours, types);
    }
}

unsafe extern "C-unwind" fn first_rect(this: *mut AnyObject, cmd: Sel, range: NSRange, actual: *mut NSRange) -> NSRect {
    let Some(appkit) = APPKIT.get() else { return NSRect::ZERO };
    // SAFETY: AppKit's implementation, with the arguments it was asked with.
    let rect = unsafe { appkit(this, cmd, range, actual) };
    if rect.size.height > 0.0 || this.is_null() {
        return rect;
    }
    // SAFETY: the method is NSTextView's, so `this` is an NSTextView, which is an NSView.
    let view = unsafe { &*(this as *const NSView) };
    let Some(window) = view.window() else { return rect };
    let shown = view.convertRect_toView(view.visibleRect(), None);
    if shown.size.height <= 0.0 {
        return rect;
    }
    let height = shown.size.height.min(LINE);
    // Window coordinates go up: the top line starts `height` below the shown rect's top.
    let line = NSRect::new(NSPoint::new(shown.origin.x, shown.origin.y + shown.size.height - height), NSSize::new(1.0, height));
    if !actual.is_null() {
        // SAFETY: the caller's NSRangePointer, non-null.
        unsafe { *actual = range };
    }
    window.convertRectToScreen(line)
}
