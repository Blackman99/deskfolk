//! The shell's windows: each an AppKit window with the system's sidebar material behind one NSH
//! `AppView`, the same look the Tauri window had (`tauri.macos.conf.json`: sidebar effect, hidden
//! title, the content under the title bar). Every window runs its own engine and talks to the
//! runtime itself, as every Tauri window ran its own page; nothing is shared in memory.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;

use nsh_engine::HostChannel;
use nsh_platform_macos::{AppOptions, AppView, AssetBase, Bundle, Limits};
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSBackingStoreType, NSScreen, NSVisualEffectBlendingMode,
    NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowCollectionBehavior,
    NSWindowDelegate, NSWindowStyleMask, NSWindowTitleVisibility,
};
use objc2_foundation::{NSNotification, NSPoint, NSRect, NSSize, NSString};

use crate::config::Config;

struct Entry {
    id: u32,
    window: Retained<NSWindow>,
    view: Rc<AppView>,
    host: HostChannel,
}

thread_local! {
    static WINDOWS: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
    static DELEGATE: RefCell<Option<Retained<Delegate>>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskfolkNshWindowDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl NSWindowDelegate for Delegate {
        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, notification: &NSNotification) {
            let Some(object) = notification.object() else { return };
            let closing = Retained::as_ptr(&object).cast::<NSWindow>();
            let gone = WINDOWS.with_borrow_mut(|windows| {
                let at = windows.iter().position(|e| Retained::as_ptr(&e.window) == closing)?;
                Some(windows.remove(at))
            });
            if let Some(entry) = gone {
                crate::traffic_lights::release(MainThreadMarker::from(self), &entry.window);
                entry.view.stop();
                log::info!("window {} closed", entry.id);
            }
        }

        #[unsafe(method(windowDidResize:))]
        fn window_did_resize(&self, notification: &NSNotification) {
            if let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
                crate::traffic_lights::place(&window);
            }
        }

        // AppKit lays the title bar out anew on the way out of full screen.
        #[unsafe(method(windowDidExitFullScreen:))]
        fn window_did_exit_full_screen(&self, notification: &NSNotification) {
            if let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
                crate::traffic_lights::keep(MainThreadMarker::from(self), &window);
            }
        }
    }
);

impl Delegate {
    fn shared(mtm: MainThreadMarker) -> Retained<Delegate> {
        DELEGATE.with_borrow_mut(|slot| {
            slot.get_or_insert_with(|| {
                let this = Delegate::alloc(mtm).set_ivars(());
                unsafe { msg_send![super(this), init] }
            })
            .clone()
        })
    }
}

/// Opens a window running the current bundle; returns its id.
pub fn open(mtm: MainThreadMarker, config: &Config) -> Option<u32> {
    let id = NEXT_ID.with(|n| {
        let id = n.get();
        n.set(id + 1);
        id
    });
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1100.0, 760.0));
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(&config.app_name));
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    window.setTitlebarAppearsTransparent(true);
    window.setMinSize(NSSize::new(720.0, 480.0));

    // The material: what the Tauri window got from `windowEffects: ["sidebar"]`.
    let material = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), frame);
    material.setMaterial(NSVisualEffectMaterial::Sidebar);
    material.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    material.setState(NSVisualEffectState::Active);
    material.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    window.setContentView(Some(&material));

    let (view, host) = make_view(mtm, config, id);
    let content = view.view();
    content.setFrame(material.bounds());
    material.addSubview(&content);
    if !load_bundle(&view, &config.bundle) {
        return None;
    }

    window.setDelegate(Some(ProtocolObject::from_ref(&*Delegate::shared(mtm))));
    // Where the Tauri window had them, beside the sidebar's mark (`traffic_lights.rs`).
    crate::traffic_lights::keep(mtm, &window);
    // Cascade from the newest window, like any document app.
    let newest = WINDOWS.with_borrow(|w| w.last().map(|e| e.window.frame().origin));
    match newest {
        Some(origin) => {
            window.setFrameOrigin(NSPoint::new(origin.x + 28.0, origin.y - 28.0));
        }
        None => window.center(),
    }
    if config.background {
        // Beside the person's own work: out of Stage Manager's strip (which would shrink it to a
        // thumbnail nothing can capture), on a secondary display when there is one.
        window.setCollectionBehavior(NSWindowCollectionBehavior::Auxiliary);
        let screens = NSScreen::screens(mtm);
        if screens.count() > 1 && newest.is_none() {
            let area = screens.objectAtIndex(1).visibleFrame();
            let size = window.frame().size;
            window.setFrameOrigin(NSPoint::new(
                area.origin.x + (area.size.width - size.width) / 2.0,
                area.origin.y + (area.size.height - size.height) / 2.0,
            ));
        }
        window.orderFrontRegardless();
    } else {
        window.makeKeyAndOrderFront(None);
    }
    WINDOWS.with_borrow_mut(|w| w.push(Entry { id, window, view, host }));
    Some(id)
}

fn make_view(mtm: MainThreadMarker, config: &Config, id: u32) -> (Rc<AppView>, HostChannel) {
    let host = crate::launch::channel(config, id);
    crate::host_calls::install(&host, id, &crate::dev_build::Identity::from_config(config));
    let events = host.clone();

    let view = AppView::new(
        mtm,
        AppOptions {
            app_id: config.bundle_id.clone(),
            title: config.app_name.clone(),
            size: (1100, 760),
            limits: Limits::standalone(),
            data_dir: Some(config.data_dir.join("nsh")),
            asset_base: config.bundle.parent().map(|dir| AssetBase::Directory(dir.join("assets"))),
            host,
            fps: config.fps,
            ..AppOptions::default()
        },
    );
    deskfolk_native_terminal::register(
        &view,
        mtm,
        deskfolk_native_terminal::Endpoint { port: config.endpoint.port, token: config.endpoint.token.clone() },
    );
    deskfolk_native_pdf::register(&view, mtm);
    (view, events)
}

fn load_bundle(view: &AppView, path: &Path) -> bool {
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    match unsafe { Bundle::read_trusted(path) } {
        Ok(bundle) => {
            view.load(bundle.into());
            true
        }
        Err(error) => {
            log::error!("cannot read bundle {}: {error}", path.display());
            false
        }
    }
}

/// Loads the bundle again in every window (the dev loop's rebuild).
pub fn reload_all(path: &Path) {
    WINDOWS.with_borrow(|windows| {
        for entry in windows {
            load_bundle(&entry.view, path);
        }
    });
    log::info!("reloaded {}", path.display());
}

/// Brings the newest window forward; false when there is none.
pub fn focus_newest() -> bool {
    WINDOWS.with_borrow(|w| match w.last() {
        Some(entry) => {
            entry.window.makeKeyAndOrderFront(None);
            true
        }
        None => false,
    })
}

/// What the system says of window `id`: `(visible, key window, miniaturized)`; `None` once it is
/// gone. Main thread.
pub fn facts(id: u32) -> Option<(bool, bool, bool)> {
    WINDOWS.with_borrow(|windows| {
        let window = &windows.iter().find(|e| e.id == id)?.window;
        Some((window.isVisible(), window.isKeyWindow(), window.isMiniaturized()))
    })
}

/// Sends event `name` to the app in `window` (`host.on(name)`), if it is one of ours.
pub fn send_event(window: &NSWindow, name: &str, data: serde_json::Value) {
    WINDOWS.with_borrow(|windows| {
        if let Some(entry) = windows.iter().find(|e| std::ptr::eq(&*e.window, window)) {
            let _ = entry.host.send(name, data);
        }
    });
}

/// A wheel event in the first window, as `wheel <x> <y> <dy> [ctrl]` asks (development checks:
/// the same path as a real one from `wheel.rs`, without touching the person's pointer).
pub fn wheel_first(args: &str) {
    let mut parts = args.split_whitespace();
    let mut num = || parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let (x, y, dy) = (num(), num(), num());
    let ctrl = args.contains("ctrl");
    WINDOWS.with_borrow(|windows| {
        if let Some(entry) = windows.first() {
            let data = serde_json::json!({
                "x": x, "y": y, "dx": 0.0, "dy": dy, "ctrl": ctrl, "meta": false, "shift": false,
                "alt": false, "pinch": false, "phase": null, "momentum": null,
            });
            let _ = entry.host.send("shell.wheel", data);
        }
    });
}

/// Resizes the first window's content to `w` x `h` points in `steps` steps, one every `ms`
/// milliseconds, as `resize <w> <h> [steps] [ms]` asks (development checks: a live resize, as a
/// drag of the window's edge makes, without touching the person's pointer; read it with `--fps`).
pub fn resize_first(args: &str) {
    let nums: Vec<f64> = args.split_whitespace().filter_map(|v| v.parse().ok()).collect();
    let (Some(&w), Some(&h)) = (nums.first(), nums.get(1)) else {
        log::warn!("resize: want <w> <h> [steps] [ms]");
        return;
    };
    let steps = nums.get(2).copied().unwrap_or(1.0).max(1.0) as u32;
    let every = std::time::Duration::from_millis(nums.get(3).copied().unwrap_or(16.0).max(1.0) as u64);
    let Some((w0, h0)) = WINDOWS.with_borrow(|windows| {
        windows.first().map(|e| {
            let size = e.window.contentRectForFrameRect(e.window.frame()).size;
            (size.width, size.height)
        })
    }) else {
        return;
    };
    std::thread::spawn(move || {
        for i in 1..=steps {
            let t = f64::from(i) / f64::from(steps);
            let size = NSSize::new(w0 + (w - w0) * t, h0 + (h - h0) * t);
            dispatch2::DispatchQueue::main().exec_async(move || {
                WINDOWS.with_borrow(|windows| {
                    if let Some(entry) = windows.first() {
                        entry.window.setContentSize(size);
                    }
                });
            });
            std::thread::sleep(every);
        }
        log::info!("resize done: {w}x{h} in {steps} steps");
    });
}

/// A left-button drag through the first window from `(x0, y0)` to `(x1, y1)` (points from its
/// top left) in `steps` moves, one every `ms` milliseconds, as `drag <x0> <y0> <x1> <y1> [steps]
/// [ms]` asks (development checks: a divider or a crossing dragged as the pointer would, posted to
/// this window alone, so the person's pointer stays where it is). Each event's posting time is
/// logged as wall-clock milliseconds, to set beside when the app saw it.
pub fn drag_first(args: &str) {
    let nums: Vec<f64> = args.split_whitespace().filter_map(|v| v.parse().ok()).collect();
    let (Some(&x0), Some(&y0), Some(&x1), Some(&y1)) = (nums.first(), nums.get(1), nums.get(2), nums.get(3)) else {
        log::warn!("drag: want <x0> <y0> <x1> <y1> [steps] [ms]");
        return;
    };
    let steps = nums.get(4).copied().unwrap_or(30.0).max(1.0) as u32;
    let every = std::time::Duration::from_millis(nums.get(5).copied().unwrap_or(8.0).max(1.0) as u64);
    // NSEventType: left mouse down 1, up 2, dragged 6.
    let post = |kind: usize, x: f64, y: f64| {
        dispatch2::DispatchQueue::main().exec_async(move || {
            WINDOWS.with_borrow(|windows| {
                let Some(entry) = windows.first() else { return };
                let height = entry.window.frame().size.height;
                let at = NSPoint::new(x, height - y);
                let uptime = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
                let number = entry.window.windowNumber();
                // SAFETY: NSEvent's class method with its declared argument types (NSUInteger type and
                // flags, NSTimeInterval, NSInteger window and event numbers, a null graphics context).
                let event: Option<Retained<objc2_app_kit::NSEvent>> = unsafe {
                    msg_send![<objc2_app_kit::NSEvent as objc2::ClassType>::class(), mouseEventWithType: kind, location: at, modifierFlags: 0usize, timestamp: uptime, windowNumber: number, context: std::ptr::null::<objc2::runtime::AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1.0f32]
                };
                if let Some(event) = event {
                    entry.window.sendEvent(&event);
                }
            });
        });
    };
    std::thread::spawn(move || {
        let wall = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        log::info!("drag down {} at {:.0},{:.0}", wall(), x0, y0);
        post(1, x0, y0);
        std::thread::sleep(every);
        for i in 1..=steps {
            let t = f64::from(i) / f64::from(steps);
            post(6, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
            std::thread::sleep(every);
        }
        log::info!("drag up {} at {:.0},{:.0}", wall(), x1, y1);
        post(2, x1, y1);
    });
}

/// Keys typed into the first window, as `keys <text>` asks (development checks): each character a
/// key down and up sent to the window, so its first responder takes them as a person's typing
/// would, without touching the person's keyboard. `\n` is Return, `\b` Backspace, `\t` Tab.
pub fn keys_first(args: &str) {
    let text = args.replace("\\n", "\n").replace("\\b", "\u{8}").replace("\\t", "\t");
    // NSEventType: key down 10, up 11. Key codes: Return 36, Tab 48, Backspace 51; a character's
    // own code does not matter to text input, which reads the characters.
    let post = |kind: usize, ch: char| {
        dispatch2::DispatchQueue::main().exec_async(move || {
            WINDOWS.with_borrow(|windows| {
                let Some(entry) = windows.first() else { return };
                let (chars, code): (String, u16) = match ch {
                    '\n' => ("\r".into(), 36),
                    '\t' => ("\t".into(), 48),
                    '\u{8}' => ("\u{7f}".into(), 51),
                    other => (other.to_string(), 0),
                };
                let chars = NSString::from_str(&chars);
                let uptime = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
                let number = entry.window.windowNumber();
                // SAFETY: NSEvent's class method with its declared argument types (NSUInteger type and
                // flags, NSTimeInterval, NSInteger window number, a null graphics context, NSString
                // characters, BOOL repeat, unsigned short key code).
                let event: Option<Retained<objc2_app_kit::NSEvent>> = unsafe {
                    msg_send![<objc2_app_kit::NSEvent as objc2::ClassType>::class(), keyEventWithType: kind, location: NSPoint::new(0.0, 0.0), modifierFlags: 0usize, timestamp: uptime, windowNumber: number, context: std::ptr::null::<objc2::runtime::AnyObject>(), characters: &*chars, charactersIgnoringModifiers: &*chars, isARepeat: false, keyCode: code]
                };
                if let Some(event) = event {
                    entry.window.sendEvent(&event);
                }
            });
        });
    };
    std::thread::spawn(move || {
        log::info!("keys {text:?}");
        for ch in text.chars() {
            post(10, ch);
            std::thread::sleep(std::time::Duration::from_millis(30));
            post(11, ch);
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    });
}

/// Puts window `id` away, as its close button does (the messenger's `hide_main_window`: ⌘W with
/// no tab left hides rather than quits).
pub fn hide(id: u32) {
    WINDOWS.with_borrow(|windows| {
        if let Some(entry) = windows.iter().find(|e| e.id == id) {
            entry.window.orderOut(None);
        }
    });
}

/// Every window draws itself into `dir/window-<id>.png` (development checks).
pub fn snapshot_all(dir: &Path) {
    WINDOWS.with_borrow(|windows| {
        for entry in windows {
            let path = dir.join(format!("window-{}.png", entry.id));
            match crate::snapshot::write(&entry.window, &path) {
                Ok(()) => log::info!("snapshot {}", path.display()),
                Err(why) => log::warn!("snapshot of window {} failed: {why}", entry.id),
            }
        }
    });
}

pub fn stop_all() {
    WINDOWS.with_borrow_mut(|windows| {
        for entry in windows.drain(..) {
            entry.view.stop();
        }
    });
}
