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
                entry.view.stop();
                log::info!("window {} closed", entry.id);
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
    crate::host_calls::install(&host, id);
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
