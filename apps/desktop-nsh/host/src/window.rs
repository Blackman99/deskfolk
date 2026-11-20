//! The shell's windows. Each runs its own engine and talks to the runtime itself, as every 0.4.0
//! window ran its own page; nothing is shared in memory.
//!
//! NSH's window model (since longbridge/nsh#2307): an app's root is a host that never shows, and
//! the app's windows are ones NSH opens. A TSX root that returns its view, as this app's does, gets
//! one window (`main`) around it. So each engine's `AppView` sits in a window of ours that is never
//! ordered in (`Entry::host_window`, kept at the app's window's frame: NSH reports the host's size
//! and scale as the surface's, `windowSize()`, so they stay the window's, live in a resize), and
//! the window the person sees is the one NSH opens, given its look before it is made (`launch`:
//! the title bar hidden with the content under it, the sidebar's material behind the app, the
//! smallest size, the last size): the look the Tauri window had
//! (`v0.5.1:apps/desktop/src-tauri/tauri.macos.conf.json`: sidebar effect, hidden title, the content
//! under the title bar). Once NSH has made it, it is found (`find`) and given what the shell adds:
//! the traffic lights where the 0.4.0 window had them, the material active in an inactive window
//! too, the app's look, the remembered size, and the close that stops its engine.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use nsh_engine::HostChannel;
use nsh_platform_macos::{AppOptions, AppView, AssetBase, Bundle, Limits};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceName, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSApplication, NSBackingStoreType, NSScreen, NSVisualEffectState, NSVisualEffectView, NSWindow,
    NSWindowCollectionBehavior, NSWindowDidChangeScreenNotification, NSWindowDidEndLiveResizeNotification,
    NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification, NSWindowDidResizeNotification,
    NSWindowOrderingMode, NSWindowStyleMask, NSWindowWillCloseNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName, NSPoint, NSRect, NSSize, NSString};

use crate::config::Config;

struct Entry {
    id: u32,
    /// The engine's host: the window around its `AppView`, never ordered in.
    host_window: Retained<NSWindow>,
    /// The window NSH opened for the app, once found (`find`); `None` while it is being made.
    window: Option<Retained<NSWindow>>,
    /// The engine a reload replaces: it keeps its window on screen until this one's is ready to take
    /// its place (`hand_over`).
    replacing: Option<Replaced>,
    /// Where the window a reload replaces was, for the one that comes in its place.
    kept: Option<Kept>,
    /// The app's look (`shell.appearance`), kept for a window found later.
    look: Option<String>,
    /// NSH made no window in time (the bundle failed before it mounted): the engine is no longer
    /// waited for, so the Dock and the tray open a window again.
    unseen: bool,
    view: Rc<AppView>,
    host: HostChannel,
}

/// A window's place and state, carried over to the window a reload opens in its place.
#[derive(Clone, Copy)]
struct Kept {
    frame: NSRect,
    visible: bool,
    key: bool,
    miniaturized: bool,
    zoomed: bool,
}

/// The engine a reload replaces, running on until the new one's window takes its place.
struct Replaced {
    view: Rc<AppView>,
    host_window: Retained<NSWindow>,
    window: Option<Retained<NSWindow>>,
    host: HostChannel,
}

thread_local! {
    static WINDOWS: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
    static OBSERVER: RefCell<Option<Retained<Observer>>> = const { RefCell::new(None) };
    /// Where the windows' last size is kept (`window_state.rs`): set as the first window opens.
    static SIZE_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    /// Engines whose window the person closed, stopped once NSH has handled the close.
    static STOPPING: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
    /// Whether the shell runs beside the person's own work (`--background`).
    static BACKGROUND: Cell<bool> = const { Cell::new(false) };
    /// The windows still to reload, one at a time (`reload_all`), and whether one is under way.
    static RELOADS: RefCell<std::collections::VecDeque<u32>> = const { RefCell::new(std::collections::VecDeque::new()) };
    static RELOADING: Cell<bool> = const { Cell::new(false) };
}

/// How long a window NSH is making is looked for, and how often.
const FIND_FOR: Duration = Duration::from_secs(20);
const FIND_EVERY: Duration = Duration::from_millis(16);
/// How long a reload's window is given to draw, unseen, before it takes the old one's place: NSH
/// shows a window with its first frame or after 250 ms at the latest.
const HAND_OVER_AFTER: Duration = Duration::from_millis(300);

/// Runs `f` on the main thread after `delay`.
fn later(delay: Duration, f: impl FnOnce(MainThreadMarker) + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        dispatch2::DispatchQueue::main().exec_async(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                f(mtm);
            }
        });
    });
}

define_class!(
    /// Hears the app's windows close, resize and change screens (NSH is their delegate).
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskfolkNshWindowObserver"]
    struct Observer;

    unsafe impl NSObjectProtocol for Observer {}

    impl Observer {
        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, notification: &NSNotification) {
            let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) else { return };
            unobserve(&window);
            crate::traffic_lights::release(MainThreadMarker::from(self), &window);
            closed(&window);
        }

        #[unsafe(method(windowDidResize:))]
        fn window_did_resize(&self, notification: &NSNotification) {
            if let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
                crate::traffic_lights::place(&window);
                host_follows(&window);
                // Mid-drag AppKit cannot be asked whether the window is zoomed: answering it moves
                // the window off the pointer. The drag's end asks.
                remember_size(&window, !window.inLiveResize());
            }
        }

        #[unsafe(method(windowDidEndLiveResize:))]
        fn window_did_end_live_resize(&self, notification: &NSNotification) {
            if let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
                remember_size(&window, true);
            }
        }

        #[unsafe(method(windowDidEnterFullScreen:))]
        fn window_did_enter_full_screen(&self, notification: &NSNotification) {
            if let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
                remember_size(&window, true);
            }
        }

        // AppKit lays the title bar out anew on the way out of full screen.
        #[unsafe(method(windowDidExitFullScreen:))]
        fn window_did_exit_full_screen(&self, notification: &NSNotification) {
            if let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
                crate::traffic_lights::keep(MainThreadMarker::from(self), &window);
                remember_size(&window, true);
            }
        }

        #[unsafe(method(windowDidChangeScreen:))]
        fn window_did_change_screen(&self, notification: &NSNotification) {
            if let Some(window) = notification.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
                host_follows(&window);
            }
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

/// What the observer hears of a window, by selector.
fn notifications() -> [(objc2::runtime::Sel, &'static NSNotificationName); 6] {
    // SAFETY: immutable AppKit constants.
    unsafe {
        [
            (sel!(windowWillClose:), NSWindowWillCloseNotification),
            (sel!(windowDidResize:), NSWindowDidResizeNotification),
            (sel!(windowDidEndLiveResize:), NSWindowDidEndLiveResizeNotification),
            (sel!(windowDidEnterFullScreen:), NSWindowDidEnterFullScreenNotification),
            (sel!(windowDidExitFullScreen:), NSWindowDidExitFullScreenNotification),
            (sel!(windowDidChangeScreen:), NSWindowDidChangeScreenNotification),
        ]
    }
}

fn observe(mtm: MainThreadMarker, window: &NSWindow) {
    let observer = observer(mtm);
    let center = NSNotificationCenter::defaultCenter();
    let object: &AnyObject = window;
    for (selector, name) in notifications() {
        // SAFETY: the observer is ours and lives as long as the app; each selector takes the
        // notification; it is removed when the window closes (`unobserve`).
        unsafe { center.addObserver_selector_name_object(&observer, selector, Some(name), Some(object)) };
    }
}

fn unobserve(window: &NSWindow) {
    let Some(observer) = OBSERVER.with_borrow(|o| o.clone()) else { return };
    let center = NSNotificationCenter::defaultCenter();
    let object: &AnyObject = window;
    for (_, name) in notifications() {
        // SAFETY: as in `observe`.
        unsafe { center.removeObserver_name_object(&observer, Some(name), Some(object)) };
    }
}

/// Keeps `window`'s size for the next window (`window_state.rs`), unless it is in the Dock. `ask` is
/// false while an edge is being dragged: the maximized flag then stays what it was.
fn remember_size(window: &NSWindow, ask: bool) {
    if window.isMiniaturized() {
        return;
    }
    let Some(dir) = SIZE_DIR.with_borrow(|d| d.clone()) else { return };
    let content = window.contentRectForFrameRect(window.frame()).size;
    let zoomed = ask.then(|| window.isZoomed() || window.styleMask().contains(NSWindowStyleMask::FullScreen));
    let previous = crate::window_state::load(&dir);
    let size = crate::window_state::snapshot(content.width, content.height, zoomed, &previous);
    if size != previous {
        if let Err(why) = crate::window_state::save(&dir, &size) {
            log::warn!("cannot keep the window's size: {why}");
        }
    }
}

/// Keeps the newest window's size: the app is quitting, and its windows close without telling.
pub fn remember_newest_size() {
    if let Some(window) = newest_window() {
        remember_size(&window, true);
    }
}

/// The Tauri app's app data directory, where its `window-size.json` is (`window_state.rs`).
fn tauri_size_dir(config: &Config) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join("Library").join("Application Support").join(&config.bundle_id))
}

/// The window NSH opens for the app (`nsh.json` `"window"`'s shape, given to the bundle): the title
/// bar hidden with the content under it, the sidebar's material behind the app, no smaller than the
/// 0.4.0 window went, at `size` and zoomed if it was. `activate`: it takes the keyboard and brings
/// the app forward as it shows (never beside the person's work, nor when a reload makes it again).
fn launch(name: &str, size: &crate::window_state::WindowSize, activate: bool) -> serde_json::Value {
    let mut window = serde_json::json!({
        "title": name,
        "titleBar": { "style": "hidden" },
        "backdrop": "sidebar",
        "minSize": { "width": crate::window_state::MIN_WIDTH, "height": crate::window_state::MIN_HEIGHT },
        "defaultSize": { "width": size.width, "height": size.height },
        "activate": activate,
    });
    if size.maximized {
        window["defaultMode"] = serde_json::json!("maximized");
    }
    window
}

/// Opens a window running the current bundle; returns its id. The window itself comes once NSH has
/// made it (`find`).
pub fn open(mtm: MainThreadMarker, config: &Config) -> Option<u32> {
    let id = NEXT_ID.with(|n| {
        let id = n.get();
        n.set(id + 1);
        id
    });
    BACKGROUND.set(config.background);
    // The last window's size, the 0.4.0 app's before there is one of ours (`window_state.rs`).
    let size_dir = crate::config::nsh_data_dir(&config.data_dir);
    let size = crate::window_state::load_or_import(&size_dir, tauri_size_dir(config).as_deref());
    SIZE_DIR.with_borrow_mut(|d| *d = Some(size_dir));

    // The host: the size the window opens at, so what the app reads of the surface before its window
    // shows is that size; on the screen the window opens on, for the scale it is drawn at.
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size.width, size.height));
    let host_window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Titled | NSWindowStyleMask::FullSizeContentView,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { host_window.setReleasedWhenClosed(false) };
    host_window.center();
    let made = make_view(mtm, config, id, &size);
    let content = made.view.view();
    content.setFrame(frame);
    host_window.setContentView(Some(&content));
    WINDOWS.with_borrow_mut(|w| {
        w.push(Entry { id, host_window, window: None, replacing: None, kept: None, look: None, unseen: false, view: made.view.clone(), host: made.host.clone() })
    });
    let json = launch(&config.app_name, &size, !config.background).to_string();
    if !load_bundle(&made.view, &config.bundle, &json) {
        WINDOWS.with_borrow_mut(|w| w.retain(|e| e.id != id));
        return None;
    }
    find_soon(id);
    Some(id)
}

/// An engine with the shell's own native components and its host channel.
struct Made {
    view: Rc<AppView>,
    host: HostChannel,
}

fn make_view(mtm: MainThreadMarker, config: &Config, id: u32, size: &crate::window_state::WindowSize) -> Made {
    let host = crate::launch::channel(config, id);
    crate::host_calls::install(&host, id, &crate::dev_build::Identity::from_config(config));
    let events = host.clone();

    let view = AppView::new(
        mtm,
        AppOptions {
            app_id: config.bundle_id.clone(),
            title: config.app_name.clone(),
            size: (size.width.round() as i32, size.height.round() as i32),
            limits: Limits::standalone(),
            data_dir: Some(crate::config::nsh_data_dir(&config.data_dir)),
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
    Made { view, host: events }
}

/// Loads the bundle at `path` into `view`, its window opened as `window` (the JSON of `launch`).
fn load_bundle(view: &AppView, path: &Path, window: &str) -> bool {
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    match unsafe { Bundle::read_trusted(path) } {
        Ok(bundle) => {
            view.load(bundle.with_main_window(Some(window)).into());
            true
        }
        Err(error) => {
            log::error!("cannot read bundle {}: {error}", path.display());
            false
        }
    }
}

/// Looks for the window NSH is making for engine `id` every frame until it is there.
fn find_soon(id: u32) {
    std::thread::spawn(move || {
        let tries = (FIND_FOR.as_millis() / FIND_EVERY.as_millis()).max(1);
        for _ in 0..tries {
            std::thread::sleep(FIND_EVERY);
            let (tx, rx) = std::sync::mpsc::channel();
            dispatch2::DispatchQueue::main().exec_async(move || {
                let done = MainThreadMarker::new().map_or(true, |mtm| find(mtm, id));
                let _ = tx.send(done);
            });
            if rx.recv().unwrap_or(true) {
                return;
            }
        }
        log::warn!("window {id}: NSH opened no window");
        dispatch2::DispatchQueue::main().exec_async(move || {
            let Some(mtm) = MainThreadMarker::new() else { return };
            // A reload whose bundle never mounted: the window before it stays, with its engine.
            if give_up_reload(mtm, id) {
                return;
            }
            WINDOWS.with_borrow_mut(|entries| {
                if let Some(entry) = entries.iter_mut().find(|e| e.id == id && e.window.is_none()) {
                    entry.unseen = true;
                }
            });
        });
    });
}

/// A window of NSH's (an `NshWindow`, titled, not a child) that is no engine's yet.
fn unclaimed(mtm: MainThreadMarker) -> Option<Retained<NSWindow>> {
    // AppKit watches NSH's windows (key-value observing), so their class is a subclass made for that.
    let nsh = objc2::runtime::AnyClass::get(c"NshWindow")?;
    let windows = NSApplication::sharedApplication(mtm).windows();
    windows.iter().find(|window| {
        window.isKindOfClass(nsh)
            && window.styleMask().contains(NSWindowStyleMask::Titled)
            && window.parentWindow().is_none()
            && !WINDOWS.with_borrow(|entries| {
                entries.iter().any(|e| {
                    e.window.as_deref().is_some_and(|w| std::ptr::eq(w, &**window))
                        || e.replacing.as_ref().and_then(|r| r.window.as_deref()).is_some_and(|w| std::ptr::eq(w, &**window))
                })
            })
    })
}

/// Takes the window NSH made for engine `id`, once there: true when the looking is over (found, or
/// the engine is gone).
fn find(mtm: MainThreadMarker, id: u32) -> bool {
    let waiting = WINDOWS.with_borrow(|w| w.iter().find(|e| e.id == id).map(|e| e.window.is_none()));
    match waiting {
        None => return true,
        Some(false) => return true,
        Some(true) => {}
    }
    // Engines are made one at a time (`opening`), so the first window no engine has is this one's.
    let Some(window) = unclaimed(mtm) else { return false };
    adopt(mtm, id, &window);
    true
}

/// Gives the window NSH made for engine `id` what the shell adds to it.
fn adopt(mtm: MainThreadMarker, id: u32, window: &Retained<NSWindow>) {
    let (kept, look, host_window, earlier) = WINDOWS.with_borrow_mut(|entries| {
        let earlier = entries.iter().filter(|e| e.id != id).filter_map(|e| e.window.as_ref().map(|w| w.frame().origin)).last();
        let Some(entry) = entries.iter_mut().find(|e| e.id == id) else { return (None, None, None, None) };
        entry.window = Some(window.clone());
        entry.unseen = false;
        (entry.kept.take(), entry.look.clone(), Some(entry.host_window.clone()), earlier)
    });
    observe(mtm, window);
    // The material stays lit in an inactive window too, as the 0.4.0 window's did (NSH's follows the
    // window's state).
    if let Some(content) = window.contentView() {
        for view in content.subviews().iter() {
            if let Ok(effect) = view.downcast::<NSVisualEffectView>() {
                effect.setState(NSVisualEffectState::Active);
                log::info!("window {id}: material {:?}, active, under the app", effect.material());
            }
        }
    }
    if let Some(look) = look {
        window.setAppearance(appearance_name(Some(&look)).and_then(NSAppearance::appearanceNamed).as_deref());
    }
    // Where the 0.4.0 window had them, beside the sidebar's mark (`traffic_lights.rs`).
    crate::traffic_lights::keep(mtm, window);
    match kept {
        // A reload's window: unseen (the app put it away as it rendered, `host.params.reloaded`),
        // at the place of the one it replaces, which it takes once it has drawn (`hand_over`).
        Some(kept) => {
            window.setFrame_display(kept.frame, false);
            later(HAND_OVER_AFTER, move |mtm| hand_over(mtm, id, kept));
        }
        None => {
            // Cascaded from the newest window, like any document app.
            match earlier {
                Some(origin) => window.setFrameOrigin(NSPoint::new(origin.x + 28.0, origin.y - 28.0)),
                None => window.center(),
            }
            if BACKGROUND.get() {
                // Beside the person's own work: out of Stage Manager's strip (which would shrink it
                // to a thumbnail nothing can capture), on a secondary display when there is one.
                window.setCollectionBehavior(NSWindowCollectionBehavior::Auxiliary);
                let screens = NSScreen::screens(mtm);
                if screens.count() > 1 && earlier.is_none() {
                    let area = screens.objectAtIndex(1).visibleFrame();
                    let size = window.frame().size;
                    window.setFrameOrigin(NSPoint::new(
                        area.origin.x + (area.size.width - size.width) / 2.0,
                        area.origin.y + (area.size.height - size.height) / 2.0,
                    ));
                }
            }
        }
    }
    if let Some(host_window) = &host_window {
        follow(host_window, window);
    }
    log::info!(
        "window {id} is NSH's window {} at scale {} (its host's {}), the app {}",
        window.windowNumber(),
        window.backingScaleFactor(),
        host_window.map_or(0.0, |h| h.backingScaleFactor()),
        if NSApplication::sharedApplication(mtm).isActive() { "active" } else { "in the background" }
    );
}

/// The host takes `window`'s frame: what NSH reports of the surface (`windowSize()`, its scale)
/// is then the window's, as when the app was drawn in the host itself.
fn follow(host_window: &NSWindow, window: &NSWindow) {
    let frame = window.frame();
    if host_window.frame() != frame {
        host_window.setFrame_display(frame, false);
    }
}

/// The host of the engine whose window is `window` follows it (a resize, another screen).
fn host_follows(window: &NSWindow) {
    let host = WINDOWS.with_borrow(|entries| {
        entries.iter().find(|e| e.window.as_deref().is_some_and(|w| std::ptr::eq(w, window))).map(|e| e.host_window.clone())
    });
    if let Some(host) = host {
        follow(&host, window);
    }
}

/// A window of the app's closed: one a reload replaced is let go; the person's close (its close
/// button) stops its engine, as closing a 0.4.0 window ended its page.
fn closed(window: &NSWindow) {
    let gone = WINDOWS.with_borrow_mut(|entries| {
        let at = entries.iter().position(|e| e.window.as_deref().is_some_and(|w| std::ptr::eq(w, window)))?;
        Some(entries.remove(at))
    });
    if let Some(entry) = gone {
        remember_size(window, true);
        log::info!("window {} closed", entry.id);
        // Stopped after NSH's own handling of the close.
        STOPPING.with_borrow_mut(|s| s.push(entry));
        dispatch2::DispatchQueue::main().exec_async(|| {
            for entry in STOPPING.with_borrow_mut(std::mem::take) {
                entry.view.stop();
                entry.host_window.close();
            }
        });
    }
}

/// Loads the bundle again in every window (the dev loop's rebuild), one window at a time.
///
/// A new engine runs the bundle beside the old one, its window unseen (`host.params.reloaded`: the
/// app puts it away as it first renders) at the old window's place. Once it has drawn it takes the
/// old window's place in the stack, its key state too, and only then does the old engine stop
/// (`hand_over`): a save elsewhere never blinks the window, raises it over another app or takes the
/// keyboard. NSH would close the window with the engine it belongs to (its window model), and a
/// new one would open in front of every other app's. A bundle that opens no window leaves the old
/// one running (`give_up_reload`).
pub fn reload_all(mtm: MainThreadMarker) {
    let ids: Vec<u32> = WINDOWS.with_borrow(|entries| entries.iter().map(|e| e.id).collect());
    RELOADS.with_borrow_mut(|queue| {
        for id in ids {
            if !queue.contains(&id) {
                queue.push_back(id);
            }
        }
    });
    if !RELOADING.get() {
        reload_next(mtm);
    }
}

fn reload_next(mtm: MainThreadMarker) {
    let Some(id) = RELOADS.with_borrow_mut(|queue| queue.pop_front()) else {
        RELOADING.set(false);
        return;
    };
    RELOADING.set(true);
    let started = crate::app::with_config(|config| reload(mtm, config, id)).unwrap_or(false);
    if !started {
        reload_next(mtm);
    }
}

/// Starts engine `id` again on the bundle; false when there was nothing to reload.
fn reload(mtm: MainThreadMarker, config: &Config, id: u32) -> bool {
    let Some(old) = WINDOWS.with_borrow_mut(|entries| {
        let at = entries.iter().position(|e| e.id == id && e.replacing.is_none())?;
        Some(entries.remove(at))
    }) else {
        return false;
    };
    let mut size = SIZE_DIR.with_borrow(|d| d.as_deref().map(crate::window_state::load)).unwrap_or_default();
    let kept = old.window.as_ref().map(|window| {
        let content = window.contentRectForFrameRect(window.frame()).size;
        size.width = content.width;
        size.height = content.height;
        size.maximized = false;
        Kept {
            frame: window.frame(),
            visible: window.isVisible(),
            key: window.isKeyWindow(),
            miniaturized: window.isMiniaturized(),
            zoomed: window.isZoomed(),
        }
    });
    let frame = old.host_window.frame();
    let host_window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Titled | NSWindowStyleMask::FullSizeContentView,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { host_window.setReleasedWhenClosed(false) };
    host_window.setFrame_display(frame, false);
    let made = make_view(mtm, config, id, &size);
    // The app puts a reload's window away as it first renders (`platform/window-life.ts`).
    let mut params = crate::launch::params(config, id);
    params.insert("reloaded".into(), kept.is_some().into());
    made.host.set_params(params);
    let content = made.view.view();
    content.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
    host_window.setContentView(Some(&content));
    let look = old.look.clone();
    let replaced = Replaced { view: old.view, host_window: old.host_window, window: old.window, host: old.host };
    WINDOWS.with_borrow_mut(|entries| {
        entries.push(Entry {
            id,
            host_window,
            window: None,
            replacing: Some(replaced),
            kept,
            look,
            unseen: false,
            view: made.view.clone(),
            host: made.host.clone(),
        })
    });
    // Back in its place in the list, so the newest window stays the newest.
    WINDOWS.with_borrow_mut(|entries| entries.sort_by_key(|e| e.id));
    if !load_bundle(&made.view, &config.bundle, &launch(&config.app_name, &size, false).to_string()) {
        give_up_reload(mtm, id);
        return true;
    }
    find_soon(id);
    log::info!("window {id}: reloading {}", config.bundle.display());
    true
}

/// The reload's window takes the old one's place: in the stack just above it (or minimized, or
/// left unseen as it was), the keyboard if it had it while the app is in front, zoomed if it was;
/// then the old engine stops and its window goes.
fn hand_over(mtm: MainThreadMarker, id: u32, kept: Kept) {
    let Some((window, replaced)) = WINDOWS.with_borrow_mut(|entries| {
        let entry = entries.iter_mut().find(|e| e.id == id)?;
        Some((entry.window.clone()?, entry.replacing.take()?))
    }) else {
        return;
    };
    if kept.zoomed && !window.isZoomed() {
        window.zoom(None);
    }
    if kept.miniaturized {
        window.miniaturize(None);
    } else if kept.visible {
        match &replaced.window {
            Some(old) => window.orderWindow_relativeTo(NSWindowOrderingMode::Above, old.windowNumber()),
            None => window.orderFront(None),
        }
        if kept.key && NSApplication::sharedApplication(mtm).isActive() {
            window.makeKeyWindow();
        }
    }
    retire(replaced);
    log::info!("window {id}: the reload's window took the old one's place");
    reload_next(mtm);
}

/// A reload's engine opened no window: it stops, and the engine it was to replace stays.
fn give_up_reload(mtm: MainThreadMarker, id: u32) -> bool {
    let Some((new, replaced)) = WINDOWS.with_borrow_mut(|entries| {
        let at = entries.iter().position(|e| e.id == id && e.replacing.is_some() && e.window.is_none())?;
        let mut entry = entries.remove(at);
        let replaced = entry.replacing.take()?;
        Some((entry, replaced))
    }) else {
        return false;
    };
    WINDOWS.with_borrow_mut(|entries| {
        entries.push(Entry {
            id,
            host_window: replaced.host_window,
            window: replaced.window,
            replacing: None,
            kept: None,
            look: new.look.clone(),
            unseen: false,
            view: replaced.view,
            host: replaced.host,
        });
        entries.sort_by_key(|e| e.id);
    });
    log::warn!("window {id}: the reloaded bundle opened no window; the one before it stays");
    retire(Replaced { view: new.view, host_window: new.host_window, window: None, host: new.host });
    reload_next(mtm);
    true
}

/// Stops an engine a reload replaced, its window first.
fn retire(replaced: Replaced) {
    if let Some(window) = &replaced.window {
        unobserve(window);
        crate::traffic_lights::release(MainThreadMarker::from(&**window), window);
        window.orderOut(None);
    }
    replaced.view.stop();
    replaced.host_window.close();
}

/// The newest window that is there (not one still being made).
fn newest_window() -> Option<Retained<NSWindow>> {
    WINDOWS.with_borrow(|w| w.iter().rev().find_map(|e| e.window.clone()))
}

/// The first window that is there, and its engine's channel (development checks).
fn first_window() -> Option<(Retained<NSWindow>, HostChannel)> {
    WINDOWS.with_borrow(|w| w.iter().find_map(|e| e.window.clone().map(|window| (window, e.host.clone()))))
}

/// Whether an engine is still waiting for its window: another one is not made meanwhile, so the
/// window NSH makes next is surely its (`find`), and a click on the Dock then opens nothing more.
pub fn opening() -> bool {
    WINDOWS.with_borrow(|w| w.iter().any(|e| e.window.is_none() && !e.unseen))
}

/// Brings the newest window forward; false when there is none (one still being made counts: it
/// comes forward as it shows).
pub fn focus_newest() -> bool {
    if opening() {
        return true;
    }
    match newest_window() {
        Some(window) => {
            if window.isMiniaturized() {
                window.deminiaturize(None);
            }
            window.makeKeyAndOrderFront(None);
            true
        }
        None => false,
    }
}

/// Window `id` in the app's look (`shell.appearance`): `"light"`, `"dark"`, or the system's for
/// anything else. NSH puts the look the app sets (`setColorScheme`) on its own views, not on the
/// window it is embedded in, so the material under the app and the traffic lights kept the
/// system's: with the system in Dark, the light app's grey ink lay on dark glass.
pub fn set_appearance(id: u32, look: Option<&str>) {
    let appearance = appearance_name(look).and_then(NSAppearance::appearanceNamed);
    WINDOWS.with_borrow_mut(|windows| {
        if let Some(entry) = windows.iter_mut().find(|e| e.id == id) {
            // Kept for the window a reload makes, and for one NSH is still making.
            entry.look = look.map(str::to_owned);
            if let Some(window) = &entry.window {
                window.setAppearance(appearance.as_deref());
            }
            log::info!("window {id} look {}", look.unwrap_or("system"));
        }
    });
}

/// AppKit's name for `look`; `None` follows the system.
fn appearance_name(look: Option<&str>) -> Option<&'static NSAppearanceName> {
    // SAFETY: immutable AppKit constants.
    match look {
        Some("light") => Some(unsafe { NSAppearanceNameAqua }),
        Some("dark") => Some(unsafe { NSAppearanceNameDarkAqua }),
        _ => None,
    }
}

/// What the system says of window `id`: `(visible, key window, miniaturized)`; `None` once it is
/// gone, and not yet seen while NSH makes it. Main thread.
pub fn facts(id: u32) -> Option<(bool, bool, bool)> {
    WINDOWS.with_borrow(|windows| {
        let entry = windows.iter().find(|e| e.id == id)?;
        Some(entry.window.as_ref().map_or((false, false, false), |w| (w.isVisible(), w.isKeyWindow(), w.isMiniaturized())))
    })
}

/// Sends event `name` to the app in the newest window, the one `focus_newest` brings forward.
pub fn send_to_newest(name: &str, data: serde_json::Value) {
    WINDOWS.with_borrow(|windows| {
        if let Some(entry) = windows.last() {
            let _ = entry.host.send(name, data);
        }
    });
}

/// Whether a window of the app's is open.
pub fn any_open() -> bool {
    WINDOWS.with_borrow(|windows| !windows.is_empty())
}

/// Whether `window` is one of the app's (not a panel, an alert or the About window).
pub fn is_ours(window: &NSWindow) -> bool {
    channel_of(window).is_some()
}

/// The channel of the engine `window` is the app's window of: during a reload the old window stays
/// its old engine's until the new one takes its place.
fn channel_of(window: &NSWindow) -> Option<HostChannel> {
    WINDOWS.with_borrow(|windows| {
        windows.iter().find_map(|e| {
            if e.window.as_deref().is_some_and(|w| std::ptr::eq(w, window)) {
                return Some(e.host.clone());
            }
            let replaced = e.replacing.as_ref()?;
            replaced.window.as_deref().is_some_and(|w| std::ptr::eq(w, window)).then(|| replaced.host.clone())
        })
    })
}

/// Sends event `name` to the app in `window` (`host.on(name)`), if it is one of ours.
pub fn send_event(window: &NSWindow, name: &str, data: serde_json::Value) {
    if let Some(host) = channel_of(window) {
        let _ = host.send(name, data);
    }
}

/// A wheel event in the first window, as `wheel <x> <y> <dy> [ctrl]` asks (development checks:
/// the same path as a real one from `wheel.rs`, without touching the person's pointer).
pub fn wheel_first(args: &str) {
    let mut parts = args.split_whitespace();
    let mut num = || parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let (x, y, dy) = (num(), num(), num());
    let ctrl = args.contains("ctrl");
    if let Some((_, host)) = first_window() {
        let data = serde_json::json!({
            "x": x, "y": y, "dx": 0.0, "dy": dy, "ctrl": ctrl, "meta": false, "shift": false,
            "alt": false, "pinch": false, "phase": null, "momentum": null,
        });
        let _ = host.send("shell.wheel", data);
    }
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
    let Some((w0, h0)) = first_window().map(|(window, _)| {
        let size = window.contentRectForFrameRect(window.frame()).size;
        (size.width, size.height)
    }) else {
        return;
    };
    std::thread::spawn(move || {
        for i in 1..=steps {
            let t = f64::from(i) / f64::from(steps);
            let size = NSSize::new(w0 + (w - w0) * t, h0 + (h - h0) * t);
            dispatch2::DispatchQueue::main().exec_async(move || {
                if let Some((window, _)) = first_window() {
                    window.setContentSize(size);
                }
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
            {
                let Some((window, _)) = first_window() else { return };
                let height = window.frame().size.height;
                let at = NSPoint::new(x, height - y);
                let uptime = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
                let number = window.windowNumber();
                // SAFETY: NSEvent's class method with its declared argument types (NSUInteger type and
                // flags, NSTimeInterval, NSInteger window and event numbers, a null graphics context).
                let event: Option<Retained<objc2_app_kit::NSEvent>> = unsafe {
                    msg_send![<objc2_app_kit::NSEvent as objc2::ClassType>::class(), mouseEventWithType: kind, location: at, modifierFlags: 0usize, timestamp: uptime, windowNumber: number, context: std::ptr::null::<objc2::runtime::AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1.0f32]
                };
                if let Some(event) = event {
                    window.sendEvent(&event);
                }
            }
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
            {
                let Some((window, _)) = first_window() else { return };
                let (chars, code): (String, u16) = match ch {
                    '\n' => ("\r".into(), 36),
                    '\t' => ("\t".into(), 48),
                    '\u{8}' => ("\u{7f}".into(), 51),
                    other => (other.to_string(), 0),
                };
                let chars = NSString::from_str(&chars);
                let uptime = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
                let number = window.windowNumber();
                // SAFETY: NSEvent's class method with its declared argument types (NSUInteger type and
                // flags, NSTimeInterval, NSInteger window number, a null graphics context, NSString
                // characters, BOOL repeat, unsigned short key code).
                let event: Option<Retained<objc2_app_kit::NSEvent>> = unsafe {
                    msg_send![<objc2_app_kit::NSEvent as objc2::ClassType>::class(), keyEventWithType: kind, location: NSPoint::new(0.0, 0.0), modifierFlags: 0usize, timestamp: uptime, windowNumber: number, context: std::ptr::null::<objc2::runtime::AnyObject>(), characters: &*chars, charactersIgnoringModifiers: &*chars, isARepeat: false, keyCode: code]
                };
                if let Some(event) = event {
                    window.sendEvent(&event);
                }
            }
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

/// One key with modifiers in the first window, as `chord <keystroke>` asks (development checks):
/// `cmd+backspace`, `alt+left`, `escape`, `ctrl+c`. Posted to the app's event queue like a key from
/// the keyboard, so the app's key monitors (NSH's keymap) see it before the window does; `keys`
/// sends straight to the window, past them.
pub fn chord_first(args: &str, mtm: MainThreadMarker) {
    let Some((flags, code, chars)) = chord(args) else {
        log::warn!("chord: want [cmd+][alt+][ctrl+][shift+]<backspace|delete|escape|enter|tab|left|right|up|down|home|end|a-z>, not {args:?}");
        return;
    };
    {
        let Some((window, _)) = first_window() else { return };
        let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
        let chars = NSString::from_str(&chars);
        let number = window.windowNumber();
        // NSEventType: key down 10, up 11.
        for kind in [10usize, 11] {
            let uptime = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
            // SAFETY: as in `keys_first`; `postEvent:atStart:` takes the event and a BOOL.
            unsafe {
                let event: Option<Retained<objc2_app_kit::NSEvent>> = msg_send![<objc2_app_kit::NSEvent as objc2::ClassType>::class(), keyEventWithType: kind, location: NSPoint::new(0.0, 0.0), modifierFlags: flags, timestamp: uptime, windowNumber: number, context: std::ptr::null::<objc2::runtime::AnyObject>(), characters: &*chars, charactersIgnoringModifiers: &*chars, isARepeat: false, keyCode: code];
                if let Some(event) = event {
                    let _: () = msg_send![&*app, postEvent: &*event, atStart: false];
                }
            }
        }
    }
    log::info!("chord {args}");
}

/// A chord's modifier flags, virtual key code and characters (`chord_first`).
fn chord(keystroke: &str) -> Option<(usize, u16, String)> {
    let parts: Vec<&str> = keystroke.trim().split('+').collect();
    let (key, modifiers) = parts.split_last()?;
    let mut flags = 0usize;
    for modifier in modifiers {
        // NSEventModifierFlags: Shift, Control, Option, Command.
        flags |= match modifier.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" => 1 << 20,
            "alt" | "option" | "opt" => 1 << 19,
            "ctrl" | "control" => 1 << 18,
            "shift" => 1 << 17,
            _ => return None,
        };
    }
    // The arrows and the keys around them carry the function key's flag, the arrows also the
    // numeric pad's, as from a keyboard; their characters are AppKit's function-key characters.
    const FUNCTION: usize = 1 << 23;
    const ARROW: usize = FUNCTION | 1 << 21;
    let (code, chars, extra): (u16, String, usize) = match key.to_ascii_lowercase().as_str() {
        "backspace" => (51, "\u{7f}".into(), 0),
        "delete" => (117, "\u{f728}".into(), FUNCTION),
        "escape" => (53, "\u{1b}".into(), 0),
        "enter" | "return" => (36, "\r".into(), 0),
        "tab" => (48, "\t".into(), 0),
        "left" => (123, "\u{f702}".into(), ARROW),
        "right" => (124, "\u{f703}".into(), ARROW),
        "down" => (125, "\u{f701}".into(), ARROW),
        "up" => (126, "\u{f700}".into(), ARROW),
        "home" => (115, "\u{f729}".into(), FUNCTION),
        "end" => (119, "\u{f72b}".into(), FUNCTION),
        letter if letter.len() == 1 && letter.as_bytes()[0].is_ascii_lowercase() => {
            // The US layout's virtual key codes of a to z.
            const CODES: [u16; 26] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];
            (CODES[(letter.as_bytes()[0] - b'a') as usize], letter.into(), 0)
        }
        _ => return None,
    };
    Some((flags | extra, code, chars))
}

/// An input method's composition in the first window's focused text input, as `compose <text>`
/// (marked text; empty ends it without committing anything) and `commit <text>` (inserts the text,
/// ending the composition) ask (development checks): the field editor's `NSTextInputClient`
/// methods, called as an input method calls them. Logs where the candidate window would open
/// (`firstRectForCharacterRange:`), from the window's top-left.
pub fn compose_first(args: &str, commit: bool) {
    {
        let Some((window, _)) = first_window() else { return };
        let Some(responder) = window.firstResponder() else {
            log::warn!("compose: nothing has the keyboard focus");
            return;
        };
        if !responder.respondsToSelector(objc2::sel!(setMarkedText:selectedRange:replacementRange:)) {
            log::warn!("compose: the keyboard focus is not in a text input");
            return;
        }
        let text = NSString::from_str(args);
        let nowhere = objc2_foundation::NSRange::new(objc2_foundation::NSNotFound as usize, 0);
        // SAFETY: NSTextInputClient's methods, which the responder answers (checked above), with
        // their declared argument types (an NSString for `id`, NSRanges, a null NSRangePointer).
        let rect: NSRect = unsafe {
            if commit {
                let _: () = msg_send![&*responder, insertText: &*text, replacementRange: nowhere];
            } else {
                let caret = objc2_foundation::NSRange::new(text.length(), 0);
                let _: () = msg_send![&*responder, setMarkedText: &*text, selectedRange: caret, replacementRange: nowhere];
            }
            // What an input method asks: the composition's place (the caret's with none).
            let marked: objc2_foundation::NSRange = msg_send![&*responder, markedRange];
            let at = if marked.location == objc2_foundation::NSNotFound as usize {
                let selected: objc2_foundation::NSRange = msg_send![&*responder, selectedRange];
                objc2_foundation::NSRange::new(selected.location, 0)
            } else {
                marked
            };
            msg_send![&*responder, firstRectForCharacterRange: at, actualRange: std::ptr::null_mut::<objc2_foundation::NSRange>()]
        };
        let frame = window.frame();
        let x = rect.origin.x - frame.origin.x;
        let y = frame.origin.y + frame.size.height - (rect.origin.y + rect.size.height);
        let what = if commit { "commit" } else { "compose" };
        log::info!("{what} {args:?}: candidates at {x:.0},{y:.0} ({:.0}×{:.0}) from the window's top-left", rect.size.width, rect.size.height);
    }
}

/// Closes the first window as its close button does (development checks: `close`).
pub fn close_first() {
    if let Some((window, _)) = first_window() {
        window.performClose(None);
    }
}

/// Puts window `id` away, as its close button does (the messenger's `hide_main_window`: ⌘W with
/// no tab left hides rather than quits).
pub fn hide(id: u32) {
    WINDOWS.with_borrow(|windows| {
        if let Some(window) = windows.iter().find(|e| e.id == id).and_then(|e| e.window.as_ref()) {
            window.orderOut(None);
            log::info!("window {id} hidden: no tab left to close");
        }
    });
}

/// Every window draws itself into `dir/window-<id>.png` (development checks).
pub fn snapshot_all(dir: &Path) {
    WINDOWS.with_borrow(|windows| {
        for entry in windows {
            let Some(window) = &entry.window else { continue };
            let path = dir.join(format!("window-{}.png", entry.id));
            match crate::snapshot::write(window, &path) {
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

#[cfg(test)]
mod tests {
    use super::appearance_name;

    #[test]
    fn a_look_names_its_appearance_and_anything_else_follows_the_system() {
        let name = |look| appearance_name(look).map(|n| n.to_string());
        assert_eq!(name(Some("light")).as_deref(), Some("NSAppearanceNameAqua"));
        assert_eq!(name(Some("dark")).as_deref(), Some("NSAppearanceNameDarkAqua"));
        assert_eq!(name(Some("system")), None);
        assert_eq!(name(None), None);
    }
}
