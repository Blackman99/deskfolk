//! The traffic lights where the Tauri window had them (`tauri.macos.conf.json`'s
//! `trafficLightPosition`, x 18, y 28): the close button 18 points in, the three centred on the
//! sidebar's brand row, 26 points down. The page's mac chrome (`window-chrome.ts`) leaves them that
//! room: the brand row starts 84 points in, the folded rail 40 points down. Left where AppKit puts
//! them (about 9 points in, 16 down) they sat on the mark, apart from the row they head.
//!
//! Placed as tao places them for Tauri (`inset_traffic_lights`): the strip they sit in made
//! `y` + a button's height tall, each button moved along at AppKit's own pitch. AppKit lays the
//! title bar out again on its own (a resize, leaving full screen), so every move of a button or of
//! the strip puts them back (`NSViewFrameDidChangeNotification`, posted inside that layout, before
//! the frame is drawn). Full screen keeps AppKit's own title bar.

use std::cell::Cell;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSButton, NSView, NSViewFrameDidChangeNotification, NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSPoint, NSRect, NSSize};

/// tao's `trafficLightPosition`: the close button's left edge, and how much taller than a button
/// the strip they sit in is made.
const X: f64 = 18.0;
const Y: f64 = 28.0;
/// Where that put the buttons' middle on this macOS (measured on the Tauri window: a 14-point
/// button 19 points down), the middle of the 46-point brand row that starts 6 points down.
const CENTRE: f64 = 26.0;

thread_local! {
    /// The buttons' pitch as AppKit lays them out (23 points on macOS 26 and later, 20 before),
    /// read before they are first moved: read later it could come from a row half moved back.
    static PITCH: Cell<Option<f64>> = const { Cell::new(None) };
    /// Set while they are being placed: each move posts the notification that places them.
    static PLACING: Cell<bool> = const { Cell::new(false) };
    static OBSERVER: std::cell::RefCell<Option<Retained<Observer>>> = const { std::cell::RefCell::new(None) };
}

define_class!(
    /// Hears a button or the strip move and puts the lights of that window back.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskfolkNshTrafficLights"]
    struct Observer;

    unsafe impl NSObjectProtocol for Observer {}

    impl Observer {
        #[unsafe(method(moved:))]
        fn moved(&self, notification: &NSNotification) {
            let Some(object) = notification.object() else { return };
            let Some(window) = object.downcast_ref::<NSView>().and_then(|view| view.window()) else { return };
            place(&window);
        }
    }
);

fn observer(mtm: MainThreadMarker) -> Retained<Observer> {
    OBSERVER.with_borrow_mut(|slot| {
        slot.get_or_insert_with(|| {
            let this = Observer::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        })
        .clone()
    })
}

fn buttons(window: &NSWindow) -> Option<[Retained<NSButton>; 3]> {
    Some([
        window.standardWindowButton(NSWindowButton::CloseButton)?,
        window.standardWindowButton(NSWindowButton::MiniaturizeButton)?,
        window.standardWindowButton(NSWindowButton::ZoomButton)?,
    ])
}

/// The strip the buttons sit in (the title bar's container); its height sets how far down they go.
fn strip(close: &NSButton) -> Option<Retained<NSView>> {
    // SAFETY: a view's superview, read on the main thread.
    unsafe { close.superview()?.superview() }
}

/// The views whose moves put the lights back: the three buttons and their strip.
fn watched(window: &NSWindow) -> Vec<Retained<NSView>> {
    let Some([close, mini, zoom]) = buttons(window) else { return Vec::new() };
    let mut views: Vec<Retained<NSView>> = vec![Retained::into_super(Retained::into_super(close.clone()))];
    views.push(Retained::into_super(Retained::into_super(mini)));
    views.push(Retained::into_super(Retained::into_super(zoom)));
    views.extend(strip(&close));
    views
}

/// Puts window `window`'s lights where the Tauri window had them; nothing in full screen.
pub fn place(window: &NSWindow) {
    if PLACING.get() || window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let Some([close, mini, zoom]) = buttons(window) else { return };
    let Some(strip) = strip(&close) else { return };
    let pitch = match PITCH.get() {
        Some(pitch) => pitch,
        None => {
            let pitch = mini.frame().origin.x - close.frame().origin.x;
            PITCH.set(Some(pitch));
            pitch
        }
    };
    PLACING.set(true);
    let button_height = close.frame().size.height;
    let height = button_height + Y;
    let window_height = window.frame().size.height;
    let frame = strip.frame();
    if frame.size.height != height || frame.origin.y != window_height - height {
        strip.setFrame(NSRect::new(NSPoint::new(frame.origin.x, window_height - height), NSSize::new(frame.size.width, height)));
    }
    // Each button where the Tauri window's was, set in the window's coordinates (from its bottom
    // left) and taken into its superview's: tao's taller strip alone held them down only until
    // AppKit laid the bar out again (a resize), which centres them in a bar of its own height.
    let width = close.frame().size.width;
    let bottom = window_height - CENTRE - button_height / 2.0;
    for (i, button) in [&close, &mini, &zoom].into_iter().enumerate() {
        // SAFETY: a view's superview, read on the main thread.
        let Some(superview) = (unsafe { button.superview() }) else { continue };
        let at = NSRect::new(NSPoint::new(X + i as f64 * pitch, bottom), NSSize::new(width, button_height));
        let want = superview.convertRect_fromView(at, None).origin;
        let origin = button.frame().origin;
        if origin.x != want.x || origin.y != want.y {
            button.setFrameOrigin(want);
        }
    }
    PLACING.set(false);
}

/// Places window `window`'s lights and keeps them there; again after full screen, where AppKit may
/// have made the buttons anew.
pub fn keep(mtm: MainThreadMarker, window: &NSWindow) {
    place(window);
    let observer = observer(mtm);
    let center = NSNotificationCenter::defaultCenter();
    for view in watched(window) {
        view.setPostsFrameChangedNotifications(true);
        let object: &AnyObject = &view;
        // SAFETY: the observer is ours and lives as long as the app; its `moved:` takes the
        // notification; the object is the view whose frame changes are wanted. Removed first, so
        // keeping a window twice does not hear each move twice.
        unsafe {
            center.removeObserver_name_object(&observer, Some(NSViewFrameDidChangeNotification), Some(object));
            center.addObserver_selector_name_object(&observer, sel!(moved:), Some(NSViewFrameDidChangeNotification), Some(object));
        }
    }
    if let Some([close, _, zoom]) = buttons(window) {
        let c = close.convertRect_toView(close.bounds(), None);
        let z = zoom.convertRect_toView(zoom.bounds(), None);
        let top = window.frame().size.height - (c.origin.y + c.size.height);
        log::info!("traffic lights at x {}..{}, {top}..{} from the top", c.origin.x, z.origin.x + z.size.width, top + c.size.height);
    }
}

/// Stops listening to window `window`'s buttons (it is closing).
pub fn release(mtm: MainThreadMarker, window: &NSWindow) {
    let observer = observer(mtm);
    let center = NSNotificationCenter::defaultCenter();
    for view in watched(window) {
        let object: &AnyObject = &view;
        // SAFETY: as in `keep`.
        unsafe { center.removeObserver_name_object(&observer, Some(NSViewFrameDidChangeNotification), Some(object)) };
    }
}
