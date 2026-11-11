//! The Linux shell: a GTK 4 application window whose child is one NSH `AppView`, running the same
//! bundle and the same launch parameters as on macOS. The window-level parts (tray, notifications,
//! AppImage and deb) come after this skeleton.

use std::cell::RefCell;
use std::rc::Rc;

use nsh_platform_linux::gtk4 as gtk;
use nsh_platform_linux::{AppOptions, AppView, AssetBase, Bundle, Limits, set_ui_sets};
use gtk::prelude::*;

use crate::config::Config;

pub fn run(config: Config) -> std::process::ExitCode {
    // Once, before the first view: what the app's TSX may import, NSH's and the app's own crate.
    set_ui_sets(vec![nsh_base::registry(), deskfolk_app_native::registry()]);
    let config = Rc::new(config);
    let app = gtk::Application::builder()
        .application_id(config.bundle_id.as_str())
        // Our own arguments are parsed already; GTK must not reject them.
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build();
    let failed = Rc::new(RefCell::new(None::<String>));
    {
        let (config, failed) = (config.clone(), failed.clone());
        app.connect_activate(move |app| {
            if let Err(why) = open(app, &config) {
                *failed.borrow_mut() = Some(why);
                app.quit();
            }
        });
    }
    let status = app.run_with_args::<&str>(&[]);
    crate::runtime::stop();
    if let Some(why) = failed.borrow_mut().take() {
        eprintln!("deskfolk-nsh: {why}");
        return std::process::ExitCode::FAILURE;
    }
    if status == gtk::glib::ExitCode::SUCCESS { std::process::ExitCode::SUCCESS } else { std::process::ExitCode::FAILURE }
}

fn open(app: &gtk::Application, config: &Config) -> Result<(), String> {
    let window = gtk::ApplicationWindow::builder()
        .application(app)
        .title(config.app_name.as_str())
        .default_width(1100)
        .default_height(760)
        .build();
    let view = AppView::new(AppOptions {
        app_id: config.bundle_id.clone(),
        title: config.app_name.clone(),
        size: (1100, 760),
        limits: Limits::standalone(),
        data_dir: Some(config.data_dir.join("nsh")),
        asset_base: config.bundle.parent().map(|dir| AssetBase::Directory(dir.join("assets"))),
        host: crate::launch::channel(config, 1),
        fps: config.fps,
        ..AppOptions::default()
    });
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    let bundle = unsafe { Bundle::read_trusted(&config.bundle) }
        .map_err(|e| format!("cannot read bundle {}: {e}", config.bundle.display()))?;
    view.load(bundle.into());
    window.set_child(Some(&view.widget()));
    // The window keeps the view; closing it stops the app.
    let keep = RefCell::new(Some(Rc::clone(&view)));
    window.connect_destroy(move |_| {
        if let Some(view) = keep.take() {
            view.stop();
        }
    });
    window.present();
    Ok(())
}
