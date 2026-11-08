//! The application: its delegate, the menu bar, the menu bar extra (tray) and the dev loop's
//! bundle watcher. A tray app: closing the last window keeps it running, like the Tauri shell.

use std::cell::OnceCell;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate, NSEventModifierFlags, NSImage,
    NSMenu, NSMenuItem, NSStatusBar, NSStatusItem, NSWorkspace,
};
use objc2_foundation::{NSNotification, NSString, NSURL};

use crate::config::Config;

thread_local! {
    static CONFIG: OnceCell<Config> = const { OnceCell::new() };
    static DELEGATE: OnceCell<Retained<Delegate>> = const { OnceCell::new() };
    static TRAY: OnceCell<Retained<NSStatusItem>> = const { OnceCell::new() };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskfolkNshAppDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl NSApplicationDelegate for Delegate {
        #[unsafe(method(applicationDidFinishLaunching:))]
        fn did_finish_launching(&self, _notification: &NSNotification) {
            let mtm = self.mtm();
            new_window(mtm);
            crate::wheel::install(mtm);
            crate::notify::setup(|click_ref| {
                // A click brings the newest window forward and leaves the intent for the messenger.
                let state = crate::notification_loop::state();
                crate::notification_loop::on_click(state, &click_ref, || {
                    DispatchQueue::main().exec_async(|| {
                        if let Some(mtm) = MainThreadMarker::new() {
                            show(mtm);
                        }
                    });
                });
            });
            if let Some(endpoint) = CONFIG.with(|c| c.get().map(|config| config.endpoint.clone())) {
                crate::notification_loop::start(endpoint);
            }
        }

        #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
        fn keep_running(&self, _app: &NSApplication) -> bool {
            false
        }

        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn reopen(&self, _app: &NSApplication, visible: bool) -> bool {
            if !visible {
                show(self.mtm());
            }
            true
        }

        #[unsafe(method(applicationWillTerminate:))]
        fn will_terminate(&self, _notification: &NSNotification) {
            crate::notification_loop::state().stop();
            crate::window::stop_all();
            crate::remote_native::stop_helper();
            crate::runtime::stop();
        }
    }

    impl Delegate {
        #[unsafe(method(newWindow:))]
        fn new_window_action(&self, _sender: Option<&AnyObject>) {
            new_window(self.mtm());
        }

        #[unsafe(method(showWindow:))]
        fn show_window_action(&self, _sender: Option<&AnyObject>) {
            show(self.mtm());
        }
    }
);

pub fn run(config: Config) -> std::process::ExitCode {
    let mtm = MainThreadMarker::new().expect("the shell starts on the main thread");
    let watch = config.watch.then(|| config.bundle.clone());
    let snapshots = config.snapshots.clone();
    // A packaged build joins the login items on launch (`register_login_item`); a dev build never.
    crate::login_item::register_on_launch(&crate::dev_build::Identity::from_config(&config));
    CONFIG.with(|c| {
        let _ = c.set(config);
    });

    // Once, before the first view: what the app's TSX may import, NSH's and the app's own crate.
    nsh_platform_macos::set_ui_sets(vec![nsh_base::registry(), deskfolk_app_native::registry()]);
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let delegate: Retained<Delegate> = {
        let this = Delegate::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    };
    app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    app.setMainMenu(Some(&main_menu(mtm, &delegate)));
    TRAY.with(|t| {
        let _ = t.set(tray(mtm, &delegate));
    });
    DELEGATE.with(|d| {
        let _ = d.set(delegate);
    });
    if let Some(path) = watch {
        watch_bundle(path);
    }
    if let Some(dir) = snapshots {
        watch_snapshot_requests(dir);
    }
    if !background() {
        app.activate();
    }
    app.run();
    std::process::ExitCode::SUCCESS
}

pub fn new_window(mtm: MainThreadMarker) {
    CONFIG.with(|c| {
        if let Some(config) = c.get() {
            crate::window::open(mtm, config);
        }
    });
    if !background() {
        NSApplication::sharedApplication(mtm).activate();
    }
}

fn background() -> bool {
    CONFIG.with(|c| c.get().is_some_and(|config| config.background))
}

fn show(mtm: MainThreadMarker) {
    if !crate::window::focus_newest() {
        new_window(mtm);
    }
    NSApplication::sharedApplication(mtm).activate();
}

pub fn open_url(url: &str) {
    if let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) {
        NSWorkspace::sharedWorkspace().openURL(&url);
    }
}

fn item(mtm: MainThreadMarker, title: &str, action: Option<Sel>, key: &str) -> Retained<NSMenuItem> {
    unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            action,
            &NSString::from_str(key),
        )
    }
}

fn targeted(mtm: MainThreadMarker, title: &str, action: Sel, key: &str, target: &Delegate) -> Retained<NSMenuItem> {
    let it = item(mtm, title, Some(action), key);
    unsafe { it.setTarget(Some(target)) };
    it
}

fn submenu(mtm: MainThreadMarker, bar: &NSMenu, title: &str, items: &[Retained<NSMenuItem>]) {
    let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
    for it in items {
        menu.addItem(it);
    }
    let holder = item(mtm, title, None, "");
    holder.setSubmenu(Some(&menu));
    bar.addItem(&holder);
}

/// The menu bar. Edit's items go to the first responder, where NSH's text views take them.
fn main_menu(mtm: MainThreadMarker, delegate: &Delegate) -> Retained<NSMenu> {
    let bar = NSMenu::new(mtm);
    let redo = item(mtm, "Redo", Some(sel!(redo:)), "z");
    redo.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Shift);
    submenu(mtm, &bar, "Deskfolk Dev", &[
        item(mtm, "Hide Deskfolk Dev", Some(sel!(hide:)), "h"),
        NSMenuItem::separatorItem(mtm),
        item(mtm, "Quit Deskfolk Dev", Some(sel!(terminate:)), "q"),
    ]);
    submenu(mtm, &bar, "File", &[targeted(mtm, "New Window", sel!(newWindow:), "n", delegate)]);
    submenu(mtm, &bar, "Edit", &[
        item(mtm, "Undo", Some(sel!(undo:)), "z"),
        redo,
        NSMenuItem::separatorItem(mtm),
        item(mtm, "Cut", Some(sel!(cut:)), "x"),
        item(mtm, "Copy", Some(sel!(copy:)), "c"),
        item(mtm, "Paste", Some(sel!(paste:)), "v"),
        item(mtm, "Select All", Some(sel!(selectAll:)), "a"),
    ]);
    submenu(mtm, &bar, "Window", &[
        item(mtm, "Minimize", Some(sel!(performMiniaturize:)), "m"),
        item(mtm, "Close", Some(sel!(performClose:)), "w"),
    ]);
    bar
}

/// The menu bar extra: show, a new window, quit.
fn tray(mtm: MainThreadMarker, delegate: &Delegate) -> Retained<NSStatusItem> {
    // NSVariableStatusItemLength.
    let status = NSStatusBar::systemStatusBar().statusItemWithLength(-1.0);
    if let Some(button) = status.button(mtm) {
        let symbol = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str("person.2.fill"),
            Some(&NSString::from_str("Deskfolk Dev")),
        );
        match symbol {
            Some(image) => {
                image.setTemplate(true);
                button.setImage(Some(&image));
            }
            None => button.setTitle(&NSString::from_str("DF")),
        }
    }
    let menu = NSMenu::new(mtm);
    menu.addItem(&targeted(mtm, "Show Deskfolk Dev", sel!(showWindow:), "", delegate));
    menu.addItem(&targeted(mtm, "New Window", sel!(newWindow:), "", delegate));
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&item(mtm, "Quit Deskfolk Dev", Some(sel!(terminate:)), ""));
    status.setMenu(Some(&menu));
    match status.button(mtm).and_then(|b| b.window().map(|w| (b.image().is_some(), w.frame()))) {
        Some((image, frame)) => log::info!(
            "tray item in the menu bar at {:.0},{:.0} ({:.0}x{:.0}), symbol {image}, visible {}",
            frame.origin.x, frame.origin.y, frame.size.width, frame.size.height, status.isVisible()
        ),
        None => log::warn!("tray item has no button window"),
    }
    status
}

/// The dev loop: `scripts/dev.ts` rebuilds the bundle on save; every window loads it again.
fn watch_bundle(path: PathBuf) {
    std::thread::spawn(move || {
        let modified = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let mut last: Option<SystemTime> = modified(&path);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let now = modified(&path);
            if now.is_some() && now != last {
                last = now;
                let path = path.clone();
                DispatchQueue::main().exec_async(move || crate::window::reload_all(&path));
            }
        }
    });
}

/// Development checks: `<dir>/request` asks the shell for something, by its first line: empty for
/// a picture of every window, `new-window`, `badge <label>` (empty clears), `notify <text>`,
/// `wheel <x> <y> <dy> [ctrl]`, `resize <w> <h> [steps] [ms]`, `drag <x0> <y0> <x1> <y1> [steps] [ms]`.
fn watch_snapshot_requests(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    std::thread::spawn(move || {
        let request = crate::snapshot::request_path(&dir);
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let Ok(text) = std::fs::read_to_string(&request) else { continue };
            if std::fs::remove_file(&request).is_err() {
                continue;
            }
            let line = text.lines().next().unwrap_or_default().trim().to_owned();
            let dir = dir.clone();
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                match line.split_once(' ').unwrap_or((line.as_str(), "")) {
                    ("", _) => crate::window::snapshot_all(&dir),
                    ("new-window", _) => new_window(mtm),
                    ("badge", label) => crate::notify::set_badge(mtm, Some(label)),
                    ("wheel", args) => crate::window::wheel_first(args),
                    ("resize", args) => crate::window::resize_first(args),
                    ("drag", args) => crate::window::drag_first(args),
                    ("keys", args) => crate::window::keys_first(args),
                    ("notify", body) => {
                        if let Err(why) = crate::notify::post("dev-check", "Deskfolk Dev", body) {
                            log::warn!("notify: {why}");
                        }
                    }
                    (other, _) => log::warn!("unknown request {other}"),
                }
                log::info!("request done: {line}");
            });
        }
    });
}
