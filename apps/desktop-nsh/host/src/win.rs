//! The Windows shell: one top-level NSH `AppView` window, running the same bundle and the same
//! launch parameters as on macOS. NSH makes the window, so the app can hide its title bar and have
//! the caption buttons drawn over it (`Window.setTitleBar`), as the traffic lights are on macOS; a
//! view embedded in a window of ours could not. Closing the window ends the message loop. The
//! window-level parts (Mica, tray, toast notifications, the installer) come after this skeleton.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use nsh_platform_windows::{AppOptions, AppView, AssetBase, Bundle, Limits, set_ui_sets};
use windows::Win32::System::Ole::OleInitialize;
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG, TranslateMessage};

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

    let view = AppView::new(
        None,
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
    view.show();
    VIEW.with_borrow_mut(|slot| *slot = Some(view));
    Ok(())
}

fn load_bundle(view: &AppView, path: &Path) -> Result<(), String> {
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    let bundle = unsafe { Bundle::read_trusted(path) }.map_err(|e| format!("cannot read bundle {}: {e}", path.display()))?;
    view.load(bundle.into());
    Ok(())
}
