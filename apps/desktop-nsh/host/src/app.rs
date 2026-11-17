//! The application: its delegate, the menu bar, the menu bar extra (tray) and the dev loop's
//! bundle watcher. A tray app: closing the last window keeps it running, like the 0.4.0 shell.

use std::cell::OnceCell;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2::{AllocAnyThread, Message};
use objc2_app_kit::{
    NSAlert, NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate, NSControlStateValueOn, NSEventMask,
    NSEventModifierFlags, NSEventType, NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem, NSWorkspace,
};
use objc2_foundation::{NSBundle, NSNotification, NSString, NSURL};

use crate::config::Config;

thread_local! {
    static CONFIG: OnceCell<Config> = const { OnceCell::new() };
    static DELEGATE: OnceCell<Retained<Delegate>> = const { OnceCell::new() };
    static TRAY: OnceCell<Retained<NSStatusItem>> = const { OnceCell::new() };
    /// The menu bar extra's menu: opened by a right click (or a control-click), a left click
    /// showing the window instead, as in the 0.4.0 tray.
    static TRAY_MENU: OnceCell<Retained<NSMenu>> = const { OnceCell::new() };
}

/// The menu bar's workbench commands, by the ids the app runs them by (`workbench-commands.ts`
/// `MENU_COMMANDS`, `shell-workbench`'s `runMenuCommand`); an item's tag is its index here. They go
/// to the window in front, as the 0.4.0 menu's did.
const PANE_COMMANDS: &[&str] = &["view-spend", "pane-split-right", "pane-split-down", "pane-close", "pane-equalise", "pane-reset", "pane-close-tab"];

fn pane_command_tag(id: &str) -> isize {
    PANE_COMMANDS.iter().position(|c| *c == id).expect("a known pane command") as isize
}

/// Whether the Apple event being handled is the system's at login: a login item's open (`oapp`),
/// or its reopen (`rapp`) of a copy already running, carries `keyAELaunchedAsLogInItem` (`'lgit'`)
/// as its `keyAEPropData`. `SMAppService` cannot pass the 0.4.0 app's `--hidden`, so this is how a
/// login launch keeps to the menu bar here.
fn launched_at_login() -> bool {
    const OPEN_APPLICATION: u32 = u32::from_be_bytes(*b"oapp");
    const REOPEN_APPLICATION: u32 = u32::from_be_bytes(*b"rapp");
    const PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
    const LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");
    let manager = objc2_foundation::NSAppleEventManager::sharedAppleEventManager();
    let Some(event) = manager.currentAppleEvent() else { return false };
    // SAFETY: plain getters of a descriptor AppKit handed out; the codes are FourCharCodes (u32).
    // (Sent by name: objc2-foundation types these through CoreServices, which this crate leaves out.)
    unsafe {
        let id: u32 = msg_send![&*event, eventID];
        if id != OPEN_APPLICATION && id != REOPEN_APPLICATION {
            return false;
        }
        let param: Option<Retained<objc2_foundation::NSAppleEventDescriptor>> = msg_send![&*event, paramDescriptorForKeyword: PROP_DATA];
        param.is_some_and(|param| {
            let code: u32 = msg_send![&*param, enumCodeValue];
            code == LAUNCHED_AS_LOGIN_ITEM
        })
    }
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
            // A login launch (`--hidden`, or the system's login item) keeps to the menu bar until
            // the Dock or the menu asks.
            let at_login = launched_at_login();
            if at_login {
                log::info!("launched at login: keeping to the menu bar");
            }
            if !at_login && !CONFIG.with(|c| c.get().is_some_and(|config| config.hidden)) {
                new_window(mtm);
            }
            crate::wheel::install(mtm);
            crate::press::install(mtm);
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
            // A release looks after the daemon inside it from here on (a dev build's does nothing).
            if let Some(data_dir) = CONFIG.with(|c| c.get().map(|config| config.data_dir.clone())) {
                crate::runtime::supervise(data_dir);
            }
        }

        #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
        fn keep_running(&self, _app: &NSApplication) -> bool {
            false
        }

        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn reopen(&self, _app: &NSApplication, visible: bool) -> bool {
            // A second login item (the 0.4.0 app's, if it is still among the login items) reaches
            // a running copy as a reopen: that one keeps to the menu bar too.
            if !visible && !launched_at_login() {
                show(self.mtm());
            }
            true
        }

        #[unsafe(method(applicationWillTerminate:))]
        fn will_terminate(&self, _notification: &NSNotification) {
            crate::notification_loop::state().stop();
            crate::window::remember_newest_size();
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

        /// The menu bar menu's "Stop Everything" (`stop_all.rs`).
        #[unsafe(method(stopAll:))]
        fn stop_all_action(&self, _sender: Option<&AnyObject>) {
            crate::stop_all::request();
        }

        /// The menu bar's workbench commands (`PANE_COMMANDS`, by the item's tag), to the window in
        /// front. Close Tab (⌘W) closes the tab in front of you, and once there is none left the app
        /// hides the window; a window that is not the app's (the About panel) just closes.
        #[unsafe(method(paneCommand:))]
        fn pane_command_action(&self, sender: Option<&AnyObject>) {
            let tag = sender.and_then(|s| s.downcast_ref::<NSMenuItem>()).map(|item| item.tag());
            let Some(id) = tag.and_then(|t| usize::try_from(t).ok()).and_then(|t| PANE_COMMANDS.get(t)) else { return };
            run_pane_command(self.mtm(), id);
        }

        /// The menu bar extra: a left click shows the window, a right click (or a control-click)
        /// opens the menu, as the 0.4.0 tray did.
        #[unsafe(method(trayClicked:))]
        fn tray_clicked(&self, _sender: Option<&AnyObject>) {
            let mtm = self.mtm();
            let event = NSApplication::sharedApplication(mtm).currentEvent();
            let wants_menu = event.is_some_and(|event| {
                event.r#type() == NSEventType::RightMouseUp || event.modifierFlags().contains(NSEventModifierFlags::Control)
            });
            if wants_menu {
                open_tray_menu(mtm);
            } else {
                show(mtm);
            }
        }

        /// "Stop Everything" can be chosen while the runtime answers, as in the 0.4.0 tray.
        #[unsafe(method(validateMenuItem:))]
        fn validate_menu_item(&self, item: &NSMenuItem) -> objc2::runtime::Bool {
            let enabled = item.action() != Some(sel!(stopAll:)) || crate::stop_all::available();
            objc2::runtime::Bool::new(enabled)
        }

        /// The menu bar menu's "查看全部用量…": a window forward, and its usage tab open. The app
        /// keeps an event until it listens, so a window opened just now gets it too.
        #[unsafe(method(showUsage:))]
        fn show_usage_action(&self, _sender: Option<&AnyObject>) {
            show(self.mtm());
            crate::window::send_to_newest("shell.event.pane-command", serde_json::json!("view-usage"));
        }
    }
);

/// Text as light as the messenger's. Its CSS sets `-webkit-font-smoothing: antialiased`, which turns
/// off macOS's font smoothing, the stem darkening CoreText adds by default; NSH draws with that
/// default, about 18% more ink on the same text (WebKit's `auto` and `antialiased` match CoreText
/// with smoothing on and off exactly). CoreGraphics takes its default from the app's own
/// `AppleFontSmoothing` preference: a launch argument or a registered default does not reach it,
/// so the app's domain holds 0, written before anything is drawn.
fn text_like_the_messenger() {
    use objc2_core_foundation::{CFNumber, CFPreferencesAppSynchronize, CFPreferencesSetAppValue, CFString, kCFPreferencesCurrentApplication};
    let key = CFString::from_static_str("AppleFontSmoothing");
    let off = CFNumber::new_i32(0);
    // SAFETY: the preference holds a number, and a CFNumber is a property list; the application id
    // is CoreFoundation's own constant.
    unsafe {
        CFPreferencesSetAppValue(&key, Some(&**off), kCFPreferencesCurrentApplication);
        CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication);
    }
}

pub fn run(config: Config) -> std::process::ExitCode {
    let mtm = MainThreadMarker::new().expect("the shell starts on the main thread");
    text_like_the_messenger();
    let watch = config.watch.then(|| config.bundle.clone());
    let snapshots = config.snapshots.clone();
    // A packaged build's login item follows the setting (`login_item.rs`); a dev build's never.
    crate::login_item::sync_on_launch(&crate::dev_build::Identity::from_config(&config), config.endpoint.clone());
    CONFIG.with(|c| {
        let _ = c.set(config);
    });

    // Once, before the first view: what the app's TSX may import, NSH's and the app's own crate.
    nsh_platform_macos::set_ui_sets(vec![nsh_base::registry(), deskfolk_app_native::registry()]);
    // The shell's own application class: keys typed while an input method composes reach it (`ime_keys.rs`).
    let app = crate::ime_keys::application(mtm);
    // Input methods' candidates under the caret when the text view cannot tell where (`ime_rect.rs`).
    crate::ime_rect::install();
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    dock_icon(&app);
    let delegate: Retained<Delegate> = {
        let this = Delegate::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    };
    app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    app.setMainMenu(Some(&main_menu(mtm, &delegate)));
    let data_dir = CONFIG.with(|c| c.get().map(|config| config.data_dir.clone()));
    crate::stop_all::watch();
    TRAY.with(|t| {
        let _ = t.set(tray(mtm, &delegate, data_dir));
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
    // A login launch stays in the background (`applicationDidFinishLaunching` tells); a window
    // that opens activates the app itself (`new_window`).
    app.run();
    std::process::ExitCode::SUCCESS
}

/// A release that cannot start says why in a dialog of its own: opened from Finder, nothing else
/// would show it.
pub fn alert(title: &str, text: &str) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.activate();
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(text));
    alert.runModal();
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

/// The app's icon in the Dock and the app switcher, from the bundle's own (`scripts/dev.ts` and
/// `scripts/package.ts` put it there). Launch Services keeps the icon it read when it first saw a
/// bundle, so a dev app it met without one would stay blank; set here, the Dock shows it anyway.
/// A bare binary (the smoke check) has none and keeps the system's.
fn dock_icon(app: &NSApplication) {
    let path = NSBundle::mainBundle().pathForResource_ofType(Some(&NSString::from_str("icon")), Some(&NSString::from_str("icns")));
    let image = path.and_then(|path| NSImage::initWithContentsOfFile(NSImage::alloc(), &path));
    match image {
        Some(image) => {
            // SAFETY: the main thread, before the run loop; AppKit keeps its own reference.
            unsafe { app.setApplicationIconImage(Some(&image)) };
            log::info!("dock icon from the bundle's icon.icns");
        }
        None => log::info!("no icon.icns in the bundle; the Dock shows the system's"),
    }
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
    let name = crate::config::APP_NAME;
    let hide_others = item(mtm, "Hide Others", Some(sel!(hideOtherApplications:)), "h");
    hide_others.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Option);
    submenu(mtm, &bar, name, &[
        item(mtm, &format!("About {name}"), Some(sel!(orderFrontStandardAboutPanel:)), ""),
        NSMenuItem::separatorItem(mtm),
        item(mtm, &format!("Hide {name}"), Some(sel!(hide:)), "h"),
        hide_others,
        NSMenuItem::separatorItem(mtm),
        item(mtm, &format!("Quit {name}"), Some(sel!(terminate:)), "q"),
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
    // The View menu, as 0.4.0 had it: the workbench's commands, with ⌘\ and ⌘⇧\ for the splits.
    let command = |title: &str, id: &str, key: &str| {
        let it = targeted(mtm, title, sel!(paneCommand:), key, delegate);
        it.setTag(pane_command_tag(id));
        it
    };
    let split_down = command("Split Down", "pane-split-down", "\\");
    split_down.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Shift);
    submenu(mtm, &bar, "View", &[
        command("Spend", "view-spend", ""),
        NSMenuItem::separatorItem(mtm),
        command("Split Right", "pane-split-right", "\\"),
        split_down,
        NSMenuItem::separatorItem(mtm),
        command("Close Pane", "pane-close", ""),
        command("Equalise", "pane-equalise", ""),
        command("Reset Layout", "pane-reset", ""),
    ]);
    // ⌘W closes the tab in front of you; the window hides once there is none left (the app asks,
    // `hide_main_window`), as in the 0.4.0 app. Closing the whole window is its close button.
    submenu(mtm, &bar, "Window", &[
        item(mtm, "Minimize", Some(sel!(performMiniaturize:)), "m"),
        NSMenuItem::separatorItem(mtm),
        command("Close Tab", "pane-close-tab", "w"),
    ]);
    bar
}

/// The menu bar extra: what is used of your plans (`usage_tray.rs`), show, a new window, quit.
/// It wears the 0.4.0 app's mark, tinted by the menu bar like its own items.
fn tray(mtm: MainThreadMarker, delegate: &Delegate, data_dir: Option<PathBuf>) -> Retained<NSStatusItem> {
    // NSVariableStatusItemLength.
    let status = NSStatusBar::systemStatusBar().statusItemWithLength(-1.0);
    if let Some(button) = status.button(mtm) {
        match crate::usage_tray::image_of(crate::usage_tray::MARK, crate::usage_tray::MARK_PX, crate::usage_tray::MARK_PT) {
            Some(image) => {
                image.setTemplate(true);
                image.setAccessibilityDescription(Some(&NSString::from_str(crate::config::APP_NAME)));
                button.setImage(Some(&image));
            }
            None => button.setTitle(&NSString::from_str("DF")),
        }
    }
    let menu = NSMenu::new(mtm);
    let name = crate::config::APP_NAME;
    menu.addItem(&targeted(mtm, &format!("Show {name}"), sel!(showWindow:), "", delegate));
    menu.addItem(&targeted(mtm, "New Window", sel!(newWindow:), "", delegate));
    menu.addItem(&targeted(mtm, "Stop Everything", sel!(stopAll:), "", delegate));
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&item(mtm, &format!("Quit {name}"), Some(sel!(terminate:)), ""));
    // No menu on the item itself: a left click shows the window, a right click opens this one
    // (`trayClicked:`).
    if let Some(button) = status.button(mtm) {
        unsafe {
            button.setTarget(Some(delegate));
            button.setAction(Some(sel!(trayClicked:)));
        }
        button.sendActionOn(NSEventMask::LeftMouseUp | NSEventMask::RightMouseUp);
    }
    TRAY_MENU.with(|m| {
        let _ = m.set(menu.clone());
    });
    if let Some(data_dir) = data_dir {
        let target: Retained<NSObject> = Retained::into_super(delegate.retain());
        crate::usage_tray::start(menu.clone(), target, data_dir);
    }
    match status.button(mtm).and_then(|b| b.window().map(|w| (b.image().is_some(), w.frame()))) {
        Some((image, frame)) => log::info!(
            "tray item in the menu bar at {:.0},{:.0} ({:.0}x{:.0}), symbol {image}, visible {}",
            frame.origin.x, frame.origin.y, frame.size.width, frame.size.height, status.isVisible()
        ),
        None => log::warn!("tray item has no button window"),
    }
    status
}

/// Development checks: `tray` logs the menu bar menu's items, each with whether it wears an icon;
/// `tray <title>` then picks the first item whose title starts with `title`, as a click would. The
/// menu is never opened on the screen.
/// Menu command `id` to the window in front: the key window when it is the app's; a panel in front
/// (the About window) is closed by Close Tab and leaves the rest to the newest window; with no
/// window of the app's open, one comes forward for any command but Close Tab (the app keeps an
/// event until it listens, so a window opened just now gets it).
fn run_pane_command(mtm: MainThreadMarker, id: &str) {
    let key = NSApplication::sharedApplication(mtm).keyWindow();
    match key {
        Some(window) if crate::window::is_ours(&window) => {
            crate::window::send_event(&window, "shell.event.pane-command", serde_json::json!(id));
        }
        Some(window) if id == "pane-close-tab" => window.performClose(None),
        _ if crate::window::any_open() => crate::window::send_to_newest("shell.event.pane-command", serde_json::json!(id)),
        _ if id == "pane-close-tab" => {}
        _ => {
            show(mtm);
            crate::window::send_to_newest("shell.event.pane-command", serde_json::json!(id));
        }
    }
}

/// Development checks: `menu <title>` picks the menu bar item whose title starts with `title`, in
/// any of its menus, as a click would (`tray` does the same for the menu bar extra).
fn menu_request(mtm: MainThreadMarker, title: &str) {
    let Some(bar) = NSApplication::sharedApplication(mtm).mainMenu() else { return };
    for top in bar.itemArray().iter() {
        let Some(menu) = top.submenu() else { continue };
        let items = menu.itemArray();
        if let Some(index) = items.iter().position(|item| !title.is_empty() && item.title().to_string().starts_with(title)) {
            log::info!("menu: {} › {}", top.title(), items.objectAtIndex(index).title());
            menu.performActionForItemAtIndex(index as isize);
            return;
        }
    }
    log::warn!("menu: no item starts with {title}");
}

/// Opens the menu bar extra's menu under its item, as a click on an item with a menu would.
fn open_tray_menu(mtm: MainThreadMarker) {
    TRAY.with(|t| {
        let Some(status) = t.get() else { return };
        let Some(menu) = TRAY_MENU.with(|m| m.get().cloned()) else { return };
        // The documented way to open a status item's menu from its action: lend it the menu for
        // the click, then take it back so the next left click is the item's own again.
        status.setMenu(Some(&menu));
        if let Some(button) = status.button(mtm) {
            // SAFETY: the item's own button, on the main thread.
            unsafe { button.performClick(None) };
        }
        status.setMenu(None);
    });
}

fn tray_request(_mtm: MainThreadMarker, title: &str) {
    TRAY.with(|_| {
        let Some(menu) = TRAY_MENU.with(|m| m.get().cloned()) else {
            log::warn!("tray: no menu");
            return;
        };
        let items = menu.itemArray();
        for (index, item) in items.iter().enumerate() {
            let icon = item.state() == NSControlStateValueOn && item.onStateImage().is_some();
            let shown = if item.isSeparatorItem() { "—".to_string() } else { item.title().to_string() };
            log::info!("tray item {index}: {shown}{}", if icon { " [icon]" } else { "" });
        }
        if title.is_empty() {
            return;
        }
        match items.iter().position(|item| item.title().to_string().starts_with(title)) {
            Some(index) => menu.performActionForItemAtIndex(index as isize),
            None => log::warn!("tray: no item starts with {title}"),
        }
    });
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
/// `wheel <x> <y> <dy> [ctrl]`, `resize <w> <h> [steps] [ms]`, `drag <x0> <y0> <x1> <y1> [steps] [ms]`,
/// `keys <text>`, `chord <keystroke>`, `compose [text]`, `commit <text>`, `tray [title]`, `menu <title>`,
/// `quit`.
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
                    ("chord", keystroke) => crate::window::chord_first(keystroke, mtm),
                    ("compose", text) => crate::window::compose_first(text, false),
                    ("commit", text) => crate::window::compose_first(text, true),
                    ("tray", title) => tray_request(mtm, title),
                    ("menu", title) => menu_request(mtm, title),
                    // Quits as the menu's Quit does, so `applicationWillTerminate` stops the runtime
                    // (`scripts/package.ts --smoke`).
                    ("quit", _) => NSApplication::sharedApplication(mtm).terminate(None),
                    ("notify", body) => {
                        if let Err(why) = crate::notify::post("dev-check", crate::config::APP_NAME, body) {
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
