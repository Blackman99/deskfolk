//! The Windows shell: a top-level Win32 window with one NSH `AppView` as its child window, sized
//! to the client area, running the same bundle and the same launch parameters as on macOS. The
//! window-level parts (Mica, tray, toast notifications, the installer) come after this skeleton.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use nsh_platform_windows::{AppOptions, AppView, AssetBase, Bundle, Limits, set_ui_sets};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::OleInitialize;
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect,
    GetMessageW, IDC_ARROW, LoadCursorW, MSG, MoveWindow, PostQuitMessage, RegisterClassW, TranslateMessage,
    WINDOW_EX_STYLE, WM_DESTROY, WM_SIZE, WNDCLASSW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::{HSTRING, w};

use crate::config::Config;

thread_local! {
    static VIEW: RefCell<Option<Rc<AppView>>> = const { RefCell::new(None) };
}

pub fn run(config: Config) -> std::process::ExitCode {
    match open(&config) {
        Ok(()) => {
            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            VIEW.with_borrow_mut(|view| {
                if let Some(view) = view.take() {
                    view.stop();
                }
            });
            crate::runtime::stop();
            std::process::ExitCode::SUCCESS
        }
        Err(why) => {
            eprintln!("deskfolk-nsh: {why}");
            crate::runtime::stop();
            std::process::ExitCode::FAILURE
        }
    }
}

fn open(config: &Config) -> Result<(), String> {
    // Once per thread: COM and OLE (the clipboard, image decoding).
    unsafe { OleInitialize(None) }.map_err(|e| e.to_string())?;
    // Once, before the first view: what the app's TSX may import, NSH's and the app's own crate.
    set_ui_sets(vec![nsh_base::registry(), deskfolk_app_native::registry()]);

    let instance = unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?;
    let class = w!("DeskfolkDevWindow");
    let window_class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        hInstance: instance.into(),
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW) }.map_err(|e| e.to_string())?,
        lpszClassName: class,
        ..Default::default()
    };
    if unsafe { RegisterClassW(&window_class) } == 0 {
        return Err("cannot register the window class".into());
    }
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            &HSTRING::from(config.app_name.as_str()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1100,
            760,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
    .map_err(|e| e.to_string())?;

    let view = AppView::new(
        Some(window),
        AppOptions {
            app_id: config.bundle_id.clone(),
            title: config.app_name.clone(),
            size: (1100, 760),
            limits: Limits::standalone(),
            data_dir: Some(config.data_dir.join("nsh")),
            asset_base: config.bundle.parent().map(|dir| AssetBase::Directory(dir.join("assets"))),
            host: crate::launch::channel(config, 1),
            fps: config.fps,
            ..AppOptions::default()
        },
    )
    .map_err(|e| e.to_string())?;
    load_bundle(&view, &config.bundle)?;
    fit(window, &view);
    VIEW.with_borrow_mut(|slot| *slot = Some(view));
    Ok(())
}

fn load_bundle(view: &AppView, path: &Path) -> Result<(), String> {
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    let bundle = unsafe { Bundle::read_trusted(path) }.map_err(|e| format!("cannot read bundle {}: {e}", path.display()))?;
    view.load(bundle.into());
    Ok(())
}

fn fit(window: HWND, view: &AppView) {
    let mut area = RECT::default();
    if unsafe { GetClientRect(window, &mut area) }.is_ok() {
        let _ = unsafe { MoveWindow(view.hwnd(), 0, 0, area.right - area.left, area.bottom - area.top, true) };
    }
}

extern "system" fn window_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_SIZE => {
            VIEW.with_borrow(|view| {
                if let Some(view) = view {
                    fit(window, view);
                }
            });
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}
