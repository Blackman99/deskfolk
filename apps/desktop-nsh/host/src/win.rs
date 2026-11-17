//! The Windows shell: NSH's own standalone window (`run_app`), running the same bundle and the same
//! launch parameters as on macOS. NSH makes the window, so the app hides its title bar and has the
//! caption buttons drawn over it, as the traffic lights are on macOS; a view embedded in a window of
//! ours could not. Closing the window ends the run. The icon in the notification area, with what is
//! used of your plans, is `win_tray.rs`; toast notifications and the installer come after this
//! skeleton.
//!
//! The window's look is set before it is made (`with_main_window`, what `nsh.json` `"window"` would
//! say, for Windows only): the title bar hidden, and on Windows 11 22H2 and later Mica behind the
//! app, as the Tauri window had. A window with a system backdrop is drawn by a composition (no
//! redirection bitmap), which is chosen when the window is made, so Mica cannot be turned on later
//! from the TSX. The window keeps its system frame: its shadow, its resize borders and, on Windows
//! 11, its rounded corners (square while maximized, as the system draws them). The app is told
//! whether the material is there (`host.params.material`, `window_material`) and lets it through
//! (`ui/glass.ts`).
//!
//! The executable cargo builds has no icon of its own, so the window gets the app's from a file
//! (`app_icon`): without it the taskbar, Alt+Tab and the toasts show the system's blank one.

use std::path::{Path, PathBuf};

use nsh_platform_windows::{AppOptions, AppSource, AssetBase, Bundle, Limits, set_ui_sets};
use serde_json::json;
use windows::Win32::Foundation::{HWND, LPARAM};

use crate::config::Config;

/// The first Windows build with `DWMWA_SYSTEMBACKDROP_TYPE` (Windows 11 22H2), where NSH maps
/// `backdrop` to Mica; before it the attribute is refused and the window stays solid.
const SYSTEM_BACKDROP_BUILD: u32 = 22621;

/// The app's icon, the one every build wears (`apps/desktop/scripts/app-icon` makes it; the Tauri
/// app embeds the same file).
const APP_ICON: &[u8] = include_bytes!("../../../desktop/src-tauri/icons/icon.ico");

pub fn run(config: Config) -> std::process::ExitCode {
    // Once, before the first view: what the app's TSX may import, NSH's and the app's own crate.
    set_ui_sets(vec![nsh_base::registry(), deskfolk_app_native::registry()]);
    let bundle = match read_bundle(&config.bundle, config.hidden) {
        Ok(bundle) => bundle,
        Err(why) => {
            eprintln!("deskfolk-nsh: {why}");
            crate::runtime::stop_started();
            return std::process::ExitCode::FAILURE;
        }
    };
    let host = crate::launch::channel(&config, 1);
    // A release looks after the daemon inside it from here on, and launches at login as the
    // settings say (a dev build's do nothing).
    crate::runtime::supervise(config.data_dir.clone());
    crate::win_login::sync(config.endpoint.clone());
    // The wheel for the views that zoom or scroll themselves (`win_wheel.rs`).
    crate::win_wheel::install(host.clone());
    let nsh_dir = config.data_dir.join("nsh");
    let icon = app_icon(&nsh_dir);
    // The icon in the notification area, with what is used of your plans (`win_tray.rs`).
    crate::stop_all::watch();
    crate::win_tray::install(config.app_name.clone(), icon.clone(), host.clone(), config.data_dir.clone());
    let options = AppOptions {
        app_id: config.bundle_id.clone(),
        title: config.app_name.clone(),
        icon,
        size: (1100, 760),
        limits: Limits::standalone(),
        data_dir: Some(crate::config::nsh_data_dir(&config.data_dir)),
        asset_base: config.bundle.parent().map(|dir| AssetBase::Directory(dir.join("assets"))),
        host,
        fps: config.fps,
        // One copy of the release at a time, as the Tauri app was: a later launch (the Start menu
        // while the login launch waits in the notification area) shows that one's window and ends.
        single_instance: crate::config::RELEASE,
        ..AppOptions::default()
    };
    // NSH's runner: DPI awareness, OLE, the window made with the options above, its message loop.
    // It ends the process itself when the window goes and does not return here: the runtime is
    // stopped as the window is destroyed (`win_tray.rs`). It returns only when this launch handed
    // itself to the copy already running (`single_instance`), whose runtime this one must leave
    // alone: only one this process started is stopped, and the notification area icon it put up
    // is taken down.
    let code = nsh_platform_windows::run_app(AppSource::Bundle(bundle), options);
    crate::win_tray::remove_icon();
    crate::runtime::stop_started();
    code
}

/// A release that cannot start says why in a box of its own: started from the Start menu, nothing
/// else would show it.
pub fn alert(title: &str, text: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    use windows::core::HSTRING;
    // SAFETY: two owned wide strings that outlive the call; no owner window.
    unsafe {
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | MB_ICONERROR);
    }
}

/// Whether the window gets Mica behind the app: Windows 11 22H2 or later, with transparency
/// effects on and a graphics adapter of the hardware's. DWM accepts the backdrop everywhere from
/// 22H2 on but draws it only with both: without them (a server's display controller, a VM with
/// no GPU, transparency effects off) what shows through the app's clear parts is black, under the
/// glass's thin ground, so there the window and the app stay solid. Read once: the window is made
/// composed or not for good. `DESKFOLK_WINDOW_MATERIAL=mica|none` overrides it, to see either look.
pub fn has_material() -> bool {
    static MATERIAL: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *MATERIAL.get_or_init(|| match std::env::var("DESKFOLK_WINDOW_MATERIAL").as_deref() {
        Ok("mica") => true,
        Ok("none") => false,
        _ => {
            windows_build().is_some_and(|build| build >= SYSTEM_BACKDROP_BUILD)
                && transparency_effects()
                && hardware_adapter()
        }
    })
}

/// NSH's window: the top-level window of this process with NSH's window class (`NshWindow`, its
/// `window.rs`) and no owner. `None` before NSH has made it and after it is gone. The process has
/// other top-level windows (the IME's, OLE's, the notification area icon's on its own thread), so
/// whatever looks for NSH's window or its UI thread asks this (`win_wheel.rs`, `win_tray.rs`).
pub fn nsh_window() -> Option<HWND> {
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetClassNameW, GetWindow, GetWindowThreadProcessId,
    };
    use windows::core::BOOL;
    unsafe extern "system" fn each(window: HWND, found: LPARAM) -> BOOL {
        let mut pid = 0;
        let mut class = [0u16; 16];
        // SAFETY: plain queries; `found` is the `Option<HWND>` below, alive for the enumeration.
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut pid));
            if pid != GetCurrentProcessId() || GetWindow(window, GW_OWNER).is_ok() {
                return BOOL(1);
            }
            let length = GetClassNameW(window, &mut class).max(0) as usize;
            if class[..length] == *NSH_WINDOW_CLASS.as_wide() {
                *(found.0 as *mut Option<HWND>) = Some(window);
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    let mut found: Option<HWND> = None;
    // SAFETY: the callback only writes `found`, which outlives the call. Stopping early reads as an
    // error, so the result says nothing.
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut found as *mut Option<HWND> as isize)) };
    found
}

/// The class NSH registers its windows under (`nsh-platform-windows`'s `window.rs`).
const NSH_WINDOW_CLASS: windows::core::PCWSTR = windows::core::w!("NshWindow");

/// The app's icon as a file in `dir`, for NSH to give the window (taskbar, Alt+Tab, title bar)
/// and its toasts: NSH loads it only from a file, and only when the executable has none of its
/// own. Written when missing or different, so a changed icon follows the build. `None` when it
/// cannot be written: the window then shows the system's.
fn app_icon(dir: &Path) -> Option<PathBuf> {
    let path = dir.join("icon.ico");
    if std::fs::read(&path).ok().as_deref() != Some(APP_ICON) {
        if let Err(why) = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&path, APP_ICON)) {
            log::warn!("the app's icon {}: {why}", path.display());
            return None;
        }
    }
    Some(path)
}

fn read_bundle(path: &Path, hidden: bool) -> Result<Bundle, String> {
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    let bundle = unsafe { Bundle::read_trusted(path) }.map_err(|e| format!("cannot read bundle {}: {e}", path.display()))?;
    Ok(bundle.with_main_window(Some(&launch_window(has_material(), hidden).to_string())))
}

/// [`main_window`], made at the login launch (`--hidden`) with the window unseen: it is made and the
/// app runs in it until the notification area icon, the Start menu or a second launch shows it
/// (`nsh.json` `window.defaultVisible: false`, NSH's tray apps).
fn launch_window(material: bool, hidden: bool) -> serde_json::Value {
    let mut window = main_window(material);
    if hidden {
        window["defaultVisible"] = json!(false);
    }
    window
}

/// The main window's launch options on Windows (`nsh.json` `"window"`'s shape).
fn main_window(material: bool) -> serde_json::Value {
    json!({
        "titleBar": { "style": "hidden" },
        "backdrop": if material { "window" } else { "none" },
    })
}

/// The running system's build number (`CurrentBuildNumber`; `GetVersionEx` answers 8 to an
/// executable without a compatibility manifest).
fn windows_build() -> Option<u32> {
    use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    use windows::core::w;
    let mut buffer = [0u16; 16];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: the value is written into a local buffer of the size given.
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    let text = String::from_utf16_lossy(&buffer);
    text.trim_end_matches('\0').trim().parse().ok()
}

/// Settings › Personalisation › Colours › Transparency effects (on when the value is missing).
fn transparency_effects() -> bool {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    use windows::core::w;
    let mut value = 1u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: a DWORD written into a local of its size.
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("EnableTransparency"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast()),
            Some(&mut size),
        )
    };
    read.is_err() || value != 0
}

/// Whether a graphics adapter of the hardware's is there: one not flagged software and not the
/// Microsoft Basic Render Driver (vendor 0x1414, device 0x8c), which DWM falls back to without one.
fn hardware_adapter() -> bool {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1};
    // SAFETY: plain DXGI queries; the descriptions are returned by value.
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return false;
        };
        (0..).map_while(|i| factory.EnumAdapters1(i).ok()).any(|adapter| {
            adapter.GetDesc1().is_ok_and(|desc| {
                let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
                let basic_render = desc.VendorId == 0x1414 && desc.DeviceId == 0x8c;
                !software && !basic_render
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_hides_its_title_bar_and_asks_for_mica_only_where_there_is_some() {
        assert_eq!(main_window(true), json!({ "titleBar": { "style": "hidden" }, "backdrop": "window" }));
        assert_eq!(main_window(false)["backdrop"], "none");
        assert_eq!(main_window(false)["titleBar"]["style"], "hidden");
    }

    #[test]
    fn the_launch_options_are_ones_nsh_reads() {
        for material in [true, false] {
            assert!(nsh_core::desktop::MainWindowOptions::from_json(&main_window(material)).is_ok());
        }
    }

    #[test]
    fn the_login_launch_makes_the_window_unseen() {
        let hidden = launch_window(true, true);
        assert_eq!(hidden["defaultVisible"], false);
        let options = nsh_core::desktop::MainWindowOptions::from_json(&hidden).expect("NSH reads it");
        assert!(!options.visible_at_launch());
        let shown = nsh_core::desktop::MainWindowOptions::from_json(&launch_window(true, false)).expect("NSH reads it");
        assert!(shown.visible_at_launch());
    }

    #[test]
    fn nsh_s_window_is_the_unowned_one_of_its_class() {
        use windows::Win32::Foundation::{LRESULT, WPARAM};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, WINDOW_EX_STYLE, WNDCLASSEXW, WS_POPUP,
        };
        unsafe extern "system" fn plain(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            // SAFETY: Windows' own handling of every message.
            unsafe { DefWindowProcW(window, message, wparam, lparam) }
        }
        let other_class = windows::core::w!("DeskfolkTestOther");
        // SAFETY: windows of this test's thread, never shown, destroyed at its end.
        unsafe {
            let instance = GetModuleHandleW(None).unwrap();
            for class in [NSH_WINDOW_CLASS, other_class] {
                RegisterClassExW(&WNDCLASSEXW {
                    cbSize: size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(plain),
                    hInstance: instance.into(),
                    lpszClassName: class,
                    ..Default::default()
                });
            }
            let make = |class, owner| {
                let instance = Some(instance.into());
                let style = WS_POPUP;
                CreateWindowExW(WINDOW_EX_STYLE(0), class, None, style, 0, 0, 0, 0, owner, None, instance, None).unwrap()
            };
            // A top-level window of another class (the tray's, the IME's) is not it.
            let other = make(other_class, None);
            assert_eq!(nsh_window(), None);
            // Nor one of NSH's class with an owner, made after and so found first.
            let nsh = make(NSH_WINDOW_CLASS, None);
            let owned = make(NSH_WINDOW_CLASS, Some(nsh));
            assert_eq!(nsh_window(), Some(nsh));
            for window in [owned, nsh, other] {
                DestroyWindow(window).unwrap();
            }
        }
        assert_eq!(nsh_window(), None);
    }

    #[test]
    fn the_app_icon_is_written_once_and_put_back_when_it_differs() {
        let dir = std::env::temp_dir().join(format!("deskfolk-nsh-icon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = app_icon(&dir).expect("written");
        assert_eq!(path, dir.join("icon.ico"));
        assert_eq!(std::fs::read(&path).unwrap(), APP_ICON);
        std::fs::write(&path, b"stale").unwrap();
        assert_eq!(app_icon(&dir), Some(path.clone()));
        assert_eq!(std::fs::read(&path).unwrap(), APP_ICON);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_app_icon_is_an_ico_with_the_taskbar_sizes() {
        // ICONDIR: reserved 0, type 1 (icon), then the entries; 0 in a width byte is 256.
        assert_eq!(&APP_ICON[..4], &[0, 0, 1, 0]);
        let count = u16::from_le_bytes([APP_ICON[4], APP_ICON[5]]) as usize;
        let sides: Vec<u32> =
            (0..count).map(|i| match APP_ICON[6 + 16 * i] { 0 => 256, side => side.into() }).collect();
        for side in [16, 32, 48, 256] {
            assert!(sides.contains(&side), "no {side}px icon in {sides:?}");
        }
    }

    #[test]
    fn this_system_has_a_build_number() {
        assert!(windows_build().is_some_and(|build| build >= 10240));
    }
}
