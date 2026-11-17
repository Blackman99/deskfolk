//! The app's icon in the notification area: on Windows what the menu bar extra is on macOS
//! (`app.rs`'s `tray`), where the 0.4.0 app's tray is too. It wears the app's icon and its name on
//! hover; a click brings the window forward, a right click opens its menu: what is used of your
//! plans, the macOS menu's lines word for word and icon for icon (`usage_tray.rs`, asked of the
//! runtime once a minute), then "Show Deskfolk Dev" and "Quit Deskfolk Dev". A line's click brings
//! the window forward; "查看全部用量…" opens the usage tab too (the messenger's `pane-command`
//! `view-usage`, as on macOS). "Stop Everything" stops the Bots' work (`stop_all.rs`). Quit asks the
//! app to quit, which closes the window and ends the run here (`win.rs`): the window's close button
//! only puts it away, as the 0.4.0 app's did. The Windows shell has one window, so there is no "New
//! Window".
//!
//! NSH runs its window and message loop on a UI thread of its own, so the icon has a thread of its
//! own too, with a hidden window: it takes the icon's messages, hears `TaskbarCreated` (Explorer
//! restarted and forgot every icon) and owns the menu while it is open (`TrackPopupMenuEx`, after
//! `SetForegroundWindow`, so that a click elsewhere closes it). The menu is made each time it opens:
//! it has the latest lines, and their icons are the small icon's size on the screen it opens on,
//! made as NSH makes its menus' (`menu_icon::canvas`, a premultiplied bitmap).
//!
//! NSH ends the process as soon as its window is gone (`run_app` exits), and an icon whose process
//! ended without taking it off stays in the notification area until the pointer passes over it. So
//! the icon goes with the window: a `WH_CALLWNDPROC` hook on NSH's UI thread (which `win_wheel.rs`
//! hooks for the wheel too) sees the window's `WM_DESTROY` and takes it off then. The same moment
//! stops the runtime the shell looks after, as NSH ends the process right after it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

use nsh_core::desktop::menu_icon;
use nsh_engine::HostChannel;
use serde_json::json;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateDIBSection, DIB_RGB_COLORS, DeleteObject, HBITMAP,
    MONITOR_DEFAULTTONEAREST, MonitorFromPoint,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForMonitor, GetDpiForWindow, GetSystemMetricsForDpi,
    MDT_EFFECTIVE_DPI, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_SETVERSION, NIN_SELECT, NOTIFY_ICON_MESSAGE,
    NOTIFYICON_VERSION_4, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CWPSTRUCT, CallNextHookEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
    DispatchMessageW, GetMessageW, GetSystemMetrics, GetWindowThreadProcessId, HICON, IDI_APPLICATION, IMAGE_ICON,
    IsIconic, KillTimer, LR_LOADFROMFILE, LoadIconW, LoadImageW, MENUITEMINFOW, MF_GRAYED, MF_SEPARATOR, MF_STRING, MIIM_BITMAP,
    MSG, PostMessageW, RegisterClassExW, RegisterWindowMessageW, SM_CXSMICON, SM_MENUDROPALIGNMENT, SW_RESTORE,
    SW_SHOW, SetForegroundWindow, SetMenuItemInfoW, SetTimer, SetWindowsHookExW, ShowWindowAsync, TPM_BOTTOMALIGN,
    TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTALIGN, TPM_RIGHTBUTTON, TrackPopupMenuEx, TranslateMessage, WH_CALLWNDPROC,
    WM_APP, WM_CONTEXTMENU, WM_DESTROY, WM_NULL, WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_POPUP,
};
use windows::core::{HSTRING, PCWSTR, w};

use crate::usage_tray::{Entry, ICON_PX, POLL, fetch, icon_rgba, text_of, usage_entries};

const LOG: &str = "deskfolk::tray";
const CLASS: PCWSTR = w!("DeskfolkTray");
/// What the icon sends the hidden window.
const WM_TRAY: u32 = WM_APP + 1;
/// The icon's id among the hidden window's (it has one).
const UID: u32 = 1;
/// Enter or Space on the focused icon (`NINF_KEY | NIN_SELECT`).
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;
/// The hidden window's timer that looks for NSH's window until it is there, and how often.
const LOOK: usize = 1;
const LOOK_EVERY_MS: u32 = 100;

// The menu's commands; every usage line but the last brings the window forward.
const SHOW: usize = 1;
const ALL_USAGE: usize = 2;
const QUIT: usize = 3;
const STOP_ALL: usize = 4;

/// What the icon needs from the shell, set once before its thread starts.
struct Setup {
    name: String,
    icon: Option<PathBuf>,
    host: HostChannel,
}

static SETUP: OnceLock<Setup> = OnceLock::new();
/// The hidden window the icon belongs to; 0 until it is made.
static WINDOW: AtomicIsize = AtomicIsize::new(0);
/// NSH's window, once it is there; 0 until then.
static MAIN: AtomicIsize = AtomicIsize::new(0);
/// The icon's image; 0 until it is loaded.
static ICON: AtomicIsize = AtomicIsize::new(0);
/// The icon is in the notification area.
static ADDED: AtomicBool = AtomicBool::new(false);
/// The usage lines the menu opens with, the latest the runtime gave.
static ENTRIES: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

/// Puts the app's icon in the notification area: `name` on hover, the image of the `.ico` file at
/// `icon` (the system's application icon without one). Its menu's usage lines are asked of the
/// runtime whose descriptor is in `data_dir`; "查看全部用量…" goes to `host`'s app. Called before
/// `run_app`, once.
pub fn install(name: String, icon: Option<PathBuf>, host: HostChannel, data_dir: PathBuf) {
    if SETUP.set(Setup { name, icon, host }).is_err() {
        return;
    }
    if let Err(why) = std::thread::Builder::new().name("deskfolk-tray".into()).spawn(run) {
        log::warn!(target: LOG, "no icon in the notification area: {why}");
        return;
    }
    if let Err(why) = std::thread::Builder::new().name("deskfolk-usage".into()).spawn(move || poll(&data_dir)) {
        log::warn!(target: LOG, "no usage lines in the tray menu: {why}");
    }
}

/// Asks the runtime whose descriptor is in `data_dir` for the usage lines, now and once a minute,
/// as the macOS menu does (`usage_tray::start`): the descriptor each time (a restarted runtime has
/// a new token); a failed ask keeps the lines there are; no descriptor, no lines.
fn poll(data_dir: &Path) {
    loop {
        let entries = match crate::endpoint::read(data_dir) {
            Ok(endpoint) => fetch(&endpoint).map(|usage| usage_entries(&usage)),
            Err(_) => Some(Vec::new()),
        };
        if let Some(entries) = entries {
            let mut shown = ENTRIES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if *shown != entries {
                let texts: Vec<&str> = entries.iter().map(text_of).collect();
                log::info!(target: LOG, "usage lines in the tray menu: {texts:?}");
                *shown = entries;
            }
        }
        std::thread::sleep(POLL);
    }
}

/// The icon's thread: its hidden window, the icon, then the window's messages for the process.
fn run() {
    // SAFETY: this thread's windows are made per-monitor aware, as NSH's are: the icon and the
    // menu's icons are sized in the screen's pixels.
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let Some(window) = make_window() else {
        return;
    };
    WINDOW.store(window.0 as isize, Ordering::SeqCst);
    load_icon(window);
    add();
    // SAFETY: a timer of this thread's own window.
    unsafe { SetTimer(Some(window), LOOK, LOOK_EVERY_MS, None) };
    let mut msg = MSG::default();
    // SAFETY: the message loop of this thread's window.
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// A window never shown, top-level so that `TaskbarCreated` reaches it, and out of the taskbar
/// and Alt+Tab (`WS_EX_TOOLWINDOW`).
fn make_window() -> Option<HWND> {
    let name = SETUP.get().map_or("Deskfolk", |setup| setup.name.as_str());
    // SAFETY: the class and the window are this module's; the procedure lives for the program.
    let made = unsafe {
        GetModuleHandleW(None).and_then(|instance| {
            let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: instance.into(),
                lpszClassName: CLASS,
                ..Default::default()
            };
            RegisterClassExW(&class);
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                CLASS,
                &HSTRING::from(name),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance.into()),
                None,
            )
        })
    };
    made.map_err(|why| log::warn!(target: LOG, "no icon in the notification area: {why}")).ok()
}

/// The icon's image: the app's `.ico` at the small icon's size, else the system's application icon.
fn load_icon(window: HWND) {
    // SAFETY: plain queries and loads; the icon is kept for the process.
    let icon = unsafe {
        let side = GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForWindow(window));
        SETUP
            .get()
            .and_then(|setup| setup.icon.as_ref())
            .and_then(|path| {
                LoadImageW(None, &HSTRING::from(path.as_os_str()), IMAGE_ICON, side, side, LR_LOADFROMFILE)
                    .map_err(|why| log::warn!(target: LOG, "the app's icon {}: {why}", path.display()))
                    .ok()
            })
            .map(|handle| HICON(handle.0))
            .or_else(|| LoadIconW(None, IDI_APPLICATION).ok())
    };
    ICON.store(icon.map_or(0, |icon| icon.0 as isize), Ordering::SeqCst);
}

fn data() -> NOTIFYICONDATAW {
    NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: HWND(WINDOW.load(Ordering::SeqCst) as _),
        uID: UID,
        ..Default::default()
    }
}

fn notify(message: NOTIFY_ICON_MESSAGE, data: &NOTIFYICONDATAW) -> bool {
    // SAFETY: a complete structure of its own size.
    unsafe { Shell_NotifyIconW(message, data) }.as_bool()
}

/// Puts the icon in the notification area, with its version-4 messages (`NIN_SELECT` for a click,
/// `WM_CONTEXTMENU` for a right click, each with where the icon is). A taskbar not there yet, at
/// login, takes it with `TaskbarCreated`.
fn add() {
    let mut data = data();
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    data.uCallbackMessage = WM_TRAY;
    data.hIcon = HICON(ICON.load(Ordering::SeqCst) as _);
    let tip = SETUP.get().map_or("", |setup| setup.name.as_str());
    let room = data.szTip.len() - 1;
    for (to, from) in data.szTip.iter_mut().zip(tip.encode_utf16().take(room)) {
        *to = from;
    }
    if notify(NIM_ADD, &data) {
        data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
        notify(NIM_SETVERSION, &data);
        ADDED.store(true, Ordering::SeqCst);
        log::info!(target: LOG, "icon in the notification area");
    } else {
        log::info!(target: LOG, "the notification area took no icon yet; it does when the taskbar comes");
    }
}

/// Takes the icon off the notification area, once. Any thread.
pub fn remove_icon() {
    remove();
}

fn remove() {
    if ADDED.swap(false, Ordering::SeqCst) {
        notify(NIM_DELETE, &data());
        log::info!(target: LOG, "icon off the notification area");
    }
}

/// The message Explorer broadcasts when it makes the taskbar, which has forgotten every icon.
fn taskbar_created() -> u32 {
    static MESSAGE: OnceLock<u32> = OnceLock::new();
    // SAFETY: a valid string.
    *MESSAGE.get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) })
}

unsafe extern "system" fn window_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_TRAY => {
            // Where the icon is on the screen, in pixels.
            let at = POINT { x: i32::from(wparam.0 as u16 as i16), y: i32::from((wparam.0 >> 16) as u16 as i16) };
            match (lparam.0 as u32) & 0xFFFF {
                NIN_SELECT | NIN_KEYSELECT => show_window(),
                WM_CONTEXTMENU => open_menu(window, at),
                _ => {}
            }
            LRESULT(0)
        }
        WM_TIMER if wparam.0 == LOOK => {
            if follow_main() {
                // SAFETY: this thread's own timer.
                let _ = unsafe { KillTimer(Some(window), LOOK) };
            }
            LRESULT(0)
        }
        _ if message == taskbar_created() => {
            ADDED.store(false, Ordering::SeqCst);
            add();
            LRESULT(0)
        }
        // SAFETY: what this window does not handle, as Windows handles it.
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

/// Once NSH has made its window: remembers it and hooks its thread, for the icon to go with it.
/// False until then.
fn follow_main() -> bool {
    let Some(main) = crate::win::nsh_window() else {
        return false;
    };
    MAIN.store(main.0 as isize, Ordering::SeqCst);
    // SAFETY: a plain query.
    let thread = unsafe { GetWindowThreadProcessId(main, None) };
    // SAFETY: a hook on a thread of this process (which needs no module), with a procedure that
    // passes every message on. It stays while this thread does, which is as long as the process.
    if let Err(why) = unsafe { SetWindowsHookExW(WH_CALLWNDPROC, Some(call_window_proc), None, thread) } {
        log::warn!(target: LOG, "the icon may stay a moment after the app ends: {why}");
    }
    true
}

unsafe extern "system" fn call_window_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: for `WH_CALLWNDPROC`, `lparam` points at the message being sent.
        let sent = unsafe { &*(lparam.0 as *const CWPSTRUCT) };
        if sent.message == WM_DESTROY && sent.hwnd.0 as isize == MAIN.load(Ordering::SeqCst) {
            remove();
            // NSH's `run_app` ends the process itself once the window is gone and never returns to
            // `win::run`, so this is the last moment the shell has: the runtime it looks after is
            // stopped here, on the way out (`runtime::stop`).
            crate::runtime::stop();
        }
    }
    // SAFETY: the next hook gets what this one was given.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Brings NSH's window forward, restored if it was minimized. A click on the icon lets this
/// process take the foreground.
fn show_window() {
    let Some(main) = crate::win::nsh_window() else {
        log::warn!(target: LOG, "no window to show");
        return;
    };
    // SAFETY: plain calls on a window of this process; the asynchronous one does not wait for its
    // thread.
    unsafe {
        let _ = ShowWindowAsync(main, if IsIconic(main).as_bool() { SW_RESTORE } else { SW_SHOW });
        let _ = SetForegroundWindow(main);
    }
}

/// The usage tab, in the window brought forward (the app keeps the event until it listens).
fn show_usage() {
    show_window();
    if let Some(setup) = SETUP.get() {
        let _ = setup.host.send("shell.event.pane-command", json!("view-usage"));
    }
}

/// Quits the app: its close button only puts the window away now (`app/src/platform/window-life.ts`),
/// so the app is asked to quit (`Application.quit`), which closes the window and ends the run
/// (the runtime stops as the window is destroyed, `hook`). An app that does not answer within a few
/// seconds (its engine stuck) is ended here, after stopping the runtime, as the run would have.
fn quit() {
    if let Some(setup) = SETUP.get() {
        let _ = setup.host.send("shell.quit", json!(null));
    }
    std::thread::spawn(|| {
        // The run normally ends well before this (its runtime given up to five seconds to stop).
        std::thread::sleep(std::time::Duration::from_secs(12));
        log::warn!(target: LOG, "the app did not quit when asked; ending it");
        remove_icon();
        crate::runtime::stop();
        std::process::exit(0);
    });
}

/// The menu, opened at `at` (the icon) until something is chosen or it is dismissed.
fn open_menu(window: HWND, at: POINT) {
    let entries = ENTRIES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let name = SETUP.get().map_or("Deskfolk", |setup| setup.name.as_str());
    let side = small_icon_side(at);
    // SAFETY: a menu of this thread's, destroyed below with the bitmaps it shows.
    let Ok(menu) = (unsafe { CreatePopupMenu() }) else {
        return;
    };
    let mut bitmaps = Vec::new();
    let item = |command: usize, text: &str| {
        // SAFETY: as above; the text is copied.
        let _ = unsafe { AppendMenuW(menu, MF_STRING, command, &HSTRING::from(menu_text(text))) };
    };
    for (position, entry) in entries.iter().enumerate() {
        item(if *entry == Entry::All { ALL_USAGE } else { SHOW }, text_of(entry));
        if let Some(bitmap) = icon_rgba(entry).and_then(|rgba| bitmap_of(&rgba, side)) {
            let info = MENUITEMINFOW {
                cbSize: size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_BITMAP,
                hbmpItem: bitmap,
                ..Default::default()
            };
            // SAFETY: the item just added; `bitmaps` keeps the bitmap as long as the menu.
            let _ = unsafe { SetMenuItemInfoW(menu, position as u32, true, &info) };
            bitmaps.push(bitmap);
        }
    }
    let separator = || {
        // SAFETY: as above.
        let _ = unsafe { AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null()) };
    };
    if !entries.is_empty() {
        separator();
    }
    item(SHOW, &format!("Show {name}"));
    // "Stop Everything" (`stop_all.rs`), greyed while the runtime does not answer, as in the 0.4.0 tray.
    let stop_flags = if crate::stop_all::available() { MF_STRING } else { MF_STRING | MF_GRAYED };
    // SAFETY: as above; the text is copied.
    let _ = unsafe { AppendMenuW(menu, stop_flags, STOP_ALL, &HSTRING::from("Stop Everything")) };
    separator();
    item(QUIT, &format!("Quit {name}"));
    // SAFETY: a plain query.
    let align = if unsafe { GetSystemMetrics(SM_MENUDROPALIGNMENT) } != 0 { TPM_RIGHTALIGN } else { TPM_LEFTALIGN };
    let flags = TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | align;
    // SAFETY: this thread's window and menu. In front, or a click elsewhere would not close the
    // menu; the message posted after is the documented companion of that.
    let chosen = unsafe {
        let _ = SetForegroundWindow(window);
        let chosen = TrackPopupMenuEx(menu, flags.0, at.x, at.y, window, None);
        let _ = PostMessageW(Some(window), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        for bitmap in bitmaps {
            let _ = DeleteObject(bitmap.into());
        }
        chosen.0 as usize
    };
    match chosen {
        SHOW => show_window(),
        ALL_USAGE => show_usage(),
        QUIT => quit(),
        STOP_ALL => crate::stop_all::request(),
        _ => {}
    }
}

/// A menu item's text as Windows shows it: `&` marks the next letter as the item's key, so one
/// meant as itself is doubled.
fn menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

/// The small icon's side, in pixels, on the screen at `at`: what the menu's icons are drawn at.
fn small_icon_side(at: POINT) -> u32 {
    let (mut x, mut y) = (96, 96);
    // SAFETY: plain queries with locals; the nearest screen always answers.
    unsafe {
        let _ = GetDpiForMonitor(MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST), MDT_EFFECTIVE_DPI, &mut x, &mut y);
        GetSystemMetricsForDpi(SM_CXSMICON, x).max(1) as u32
    }
}

/// Straight-alpha RGBA as premultiplied BGRA, a DIB's 32-bit pixels.
fn premultiplied_bgra(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|pixel| {
            let alpha = u32::from(pixel[3]);
            let times = |c: u8| ((u32::from(c) * alpha + 127) / 255) as u8;
            [times(pixel[2]), times(pixel[1]), times(pixel[0]), pixel[3]]
        })
        .collect()
}

/// A line's icon (`ICON_PX` square RGBA) as a menu item's bitmap, `side` pixels square: a 32-bit
/// premultiplied DIB, which Windows blends, scaled and laid out bottom-up as NSH's menus' are.
fn bitmap_of(rgba: &[u8], side: u32) -> Option<HBITMAP> {
    if rgba.len() != ICON_PX * ICON_PX * 4 {
        return None;
    }
    let pixels = menu_icon::canvas(&premultiplied_bgra(rgba), ICON_PX as u32, ICON_PX as u32, side);
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: side as i32,
            biHeight: side as i32,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    // SAFETY: the header describes a DIB section of `side` rows of `side` 32-bit pixels, which it
    // allocates; the rows copied into it are that long.
    unsafe {
        let bitmap = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        if bits.is_null() {
            let _ = DeleteObject(bitmap.into());
            return None;
        }
        let stride = side as usize * 4;
        let out = std::slice::from_raw_parts_mut(bits.cast::<u8>(), stride * side as usize);
        for (to, from) in out.chunks_exact_mut(stride).zip(pixels.chunks_exact(stride).rev()) {
            to.copy_from_slice(from);
        }
        Some(bitmap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_tray::Level;

    #[test]
    fn pixels_are_premultiplied_and_turned_to_bgra() {
        assert_eq!(premultiplied_bgra(&[255, 128, 0, 255]), [0, 128, 255, 255]);
        assert_eq!(premultiplied_bgra(&[200, 100, 50, 128]), [25, 50, 100, 128]);
        assert_eq!(premultiplied_bgra(&[9, 9, 9, 0]), [0, 0, 0, 0]);
    }

    #[test]
    fn an_ampersand_in_a_line_stays_an_ampersand() {
        assert_eq!(menu_text("Codex · R&D　5h 10%"), "Codex · R&&D　5h 10%");
        assert_eq!(menu_text("查看全部用量…"), "查看全部用量…");
    }

    #[test]
    fn a_line_icon_becomes_a_bitmap_of_the_small_icon_size() {
        let entry = Entry::Line { text: String::new(), used: 40.0, level: Level::Warn, runner: "codex".into() };
        let rgba = icon_rgba(&entry).expect("a line wears an icon");
        for side in [16, 20, 24, 32] {
            let bitmap = bitmap_of(&rgba, side).expect("a bitmap");
            // SAFETY: the bitmap just made, deleted once.
            let _ = unsafe { DeleteObject(bitmap.into()) };
        }
        assert!(bitmap_of(&rgba[..rgba.len() - 4], 16).is_none());
    }

    #[test]
    fn the_small_icon_is_a_size_the_menu_can_show() {
        let side = small_icon_side(POINT { x: 0, y: 0 });
        assert!((16..=64).contains(&side), "{side}");
    }
}
