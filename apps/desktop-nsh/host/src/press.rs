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
//!
//! A press also tells whether it may take the keyboard from a text field (`unfocus`). NSH leaves the
//! focus in a field that edits when a click lands elsewhere, as AppKit apps do; the messenger's
//! fields lose it, as a page's do on a `mousedown` outside them, and the app's code (blur commits,
//! the message box's focus look, keys that act once no field edits) is the messenger's. So a
//! primary press on the app's own views (not on a hosted AppKit view: a field, a scroller) while a
//! text view edits carries its number, and the app, unless the press is somewhere it keeps the
//! focus (lists that pick for the field: the messenger's `preventDefault` places), asks
//! `shell.blur` with it ([`blur`]). The field goes only if that press is still the latest, its
//! button is still down and the same field still has the keyboard: a press that moved the focus on
//! meanwhile keeps it where it went, and once the button is up the app's own press handlers (which
//! run on the release, and may focus that very field: quoting a line into the message box) have
//! had their say, so a late answer changes nothing (the answer takes well under a millisecond, a
//! click about a tenth of a second). A window has one field editor for all its single-line fields,
//! so the field is the editor and the field it edits (its delegate).
//!
//! Some views draw their own text and type through a hidden field (a sink): the message box and
//! the code editor (nsh/base's `RichEditor`, `Editor`), `TimeField`, the terminal, the remote
//! screen's keyboard. A press anywhere in such a view is a press in the field: a sink (a field a
//! point or two wide or tall, or fully transparent) keeps the keyboard for presses inside the view
//! that holds it ([`sink_owner`]).

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2::rc::{Retained, Weak};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSTextInputClient, NSTextView, NSView, NSWindow};
use serde_json::{Value, json};

/// The field a press may unfocus: the text view with the keyboard, and the field it edits (a
/// single-line field's editor is the window's one field editor; the delegate tells them apart).
struct Field {
    view: Weak<NSTextView>,
    edits: usize,
}

thread_local! {
    /// The number of the latest press and, when it may unfocus one, the field that edited then.
    static LATEST: RefCell<(u64, Option<Field>)> = const { RefCell::new((0, None)) };
    static COUNT: Cell<u64> = const { Cell::new(0) };
    /// The number of the latest press whose primary button came up.
    static RELEASED: Cell<u64> = const { Cell::new(0) };
}

/// NSH's own views (`nsh-platform-macos` `view.rs`): the root's `hitTest:` returns one of these for
/// a press on the app's views, a hosted AppKit view (a field's pad, a scroller) otherwise.
const NSH_VIEWS: [&str; 2] = ["NshView", "NshContainer"];

pub fn install(mtm: MainThreadMarker) {
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event for the duration of the call.
        let e = unsafe { event.as_ref() };
        if e.r#type() == NSEventType::LeftMouseUp {
            RELEASED.with(|r| r.set(COUNT.with(Cell::get)));
            return event.as_ptr();
        }
        if let Some(window) = e.window(mtm) {
            let height = window.contentView().map_or(0.0, |v| v.frame().size.height);
            let at = e.locationInWindow();
            let button = match e.r#type() {
                NSEventType::LeftMouseDown if e.modifierFlags().contains(NSEventModifierFlags::Control) => 2,
                NSEventType::LeftMouseDown => 0,
                NSEventType::RightMouseDown => 2,
                _ => 1,
            };
            let number = COUNT.with(|c| {
                c.set(c.get() + 1);
                c.get()
            });
            let field = if button == 0 { editing_elsewhere(&window, e) } else { None };
            let unfocus = field.as_ref().map_or(Value::Null, |_| json!(number));
            LATEST.with_borrow_mut(|latest| {
                *latest = (number, field.as_deref().map(|view| Field { view: Weak::from(view), edits: edited_by(view) }));
            });
            crate::window::send_event(
                &window,
                "shell.press",
                json!({ "x": at.x, "y": height - at.y, "button": button, "unfocus": unfocus }),
            );
        }
        event.as_ptr()
    });
    // SAFETY: the block returns the event it was given, as a local monitor must.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown,
            &block,
        )
    };
    // The monitor lives as long as the app.
    std::mem::forget(monitor);
}

/// The text view that edits in `window` when `event` lands on the app's own views, not in a hosted
/// AppKit view (the field itself, another field, a scroller) nor in the view a sink types for: the
/// field such a press may unfocus.
fn editing_elsewhere(window: &NSWindow, event: &NSEvent) -> Option<Retained<NSTextView>> {
    let field = window.firstResponder()?.downcast::<NSTextView>().ok()?;
    let at = event.locationInWindow();
    // The window's frame view hit tests as AppKit does for the press: it takes window coordinates.
    let frame = superview(&*window.contentView()?)?;
    let hit = frame.hitTest(at)?;
    let name = hit.class().name().to_str().unwrap_or_default();
    if !NSH_VIEWS.contains(&name) {
        return None;
    }
    if let Some(owner) = sink_owner(&field) {
        let r = owner.convertRect_toView(owner.bounds(), None);
        let inside = at.x >= r.origin.x && at.y >= r.origin.y && at.x < r.origin.x + r.size.width && at.y < r.origin.y + r.size.height;
        if inside {
            return None;
        }
    }
    Some(field)
}

/// When `field` is a sink (its NSH input view a point or two wide or tall, or transparent), the
/// NSH view holding that input: the view the sink types for.
fn sink_owner(field: &NSTextView) -> Option<Retained<NSView>> {
    // The text view sits in the input's pad (`NshInputPad`), the pad in the input's NSH view.
    let mut at = superview(field);
    while let Some(view) = at.take() {
        if view.class().name().to_str() == Ok("NshInputPad") {
            let input = superview(&view)?;
            let size = input.frame().size;
            let clear = input.layer().is_some_and(|layer| layer.opacity() == 0.0);
            if size.width <= 2.0 || size.height <= 2.0 || clear {
                return superview(&input);
            }
            return None;
        }
        at = superview(&view);
    }
    None
}

/// The field `view` edits: its delegate's address (the text field for a field editor).
fn edited_by(view: &NSTextView) -> usize {
    // SAFETY: NSText's `delegate`, read on the main thread.
    let delegate: Option<Retained<objc2::runtime::AnyObject>> = unsafe { objc2::msg_send![view, delegate] };
    delegate.map_or(0, |d| Retained::as_ptr(&d) as usize)
}

/// `shell.blur` with press `number`: the field that edited at that press gives up the keyboard to
/// NSH's root, as NSH's own `blur()` does, if that press is still the latest, its button is still
/// down and the same field still has the keyboard.
pub fn blur(number: u64) {
    if RELEASED.with(Cell::get) >= number {
        return;
    }
    let field = LATEST.with_borrow(|(latest, field)| {
        (*latest == number).then(|| field.as_ref().and_then(|f| Some((f.view.load()?, f.edits)))).flatten()
    });
    let Some((field, edits)) = field else { return };
    let Some(window) = field.window() else { return };
    let same_view = window.firstResponder().is_some_and(|r| std::ptr::eq(Retained::as_ptr(&r).cast::<NSTextView>(), Retained::as_ptr(&field)));
    if !same_view || edited_by(&field) != edits {
        return;
    }
    // NSH's root: the outermost of its views around the field.
    let mut root: Option<Retained<NSView>> = None;
    let mut at = superview(&field);
    while let Some(view) = at {
        if view.class().name().to_str() == Ok(NSH_VIEWS[0]) {
            root = Some(view.clone());
        }
        at = superview(&view);
    }
    commit_marked(&field);
    window.makeFirstResponder(None);
    if let Some(root) = root {
        window.makeFirstResponder(Some(&root));
    }
}

/// An input method's composition, committed before its field lets the keyboard go. NSH 0.4.0 does
/// not: AppKit unmarks the text as the editor resigns, and the input heard that out of order (a
/// press away from the message box mid-pinyin lost the character before the pinyin). NSH commits
/// it itself after 0.4.0 (longbridge/nsh#1507, its `commit_marked`), the same way as here: the
/// input method's session dropped, the marked text inserted as its commit would be.
fn commit_marked(view: &NSTextView) {
    if !view.hasMarkedText() {
        return;
    }
    let range = view.markedRange();
    let composed = view.string().substringWithRange(range);
    if let Some(context) = view.inputContext() {
        context.discardMarkedText();
    }
    // SAFETY: an NSString over the marked range, which is in the text.
    unsafe { view.insertText_replacementRange(&composed, range) };
}

fn superview(view: &NSView) -> Option<Retained<NSView>> {
    // SAFETY: read on the main thread, between AppKit's own changes to the hierarchy.
    unsafe { view.superview() }
}
