//! The Linux shell: NSH's own runner (`run_app`), as on Windows (`win.rs`), so the window has what
//! the 0.4.0 app's Linux build had: one copy of the release at a time (a later launch hands itself
//! to the running one and ends), a start at login without a window (`--hidden`), the size it was
//! left at (`restoreBounds`), its notifications and its keys (Ctrl+Q). The rest is the app's and
//! this shell's own: the tray (`app/src/platform/linux-tray.ts`, NSH's StatusNotifierItem), the
//! close button that puts the window away while there is a tray to bring it back from
//! (`window-life.ts`), launch at login through the 0.4.0 app's autostart entry (`linux_login.rs`),
//! and the daemon it starts and watches (`runtime.rs`).
//!
//! A release is installed as the 0.4.0 app's Linux build was (`scripts/package.ts`): this program
//! at `/usr/lib/Deskfolk/real-bot-desktop` (`/usr/bin/real-bot-desktop` links to it), its app and
//! its daemon beside it (`app/`, `native/`), the icon and the desktop entry under the app's id.

use nsh_platform_linux::gtk4 as gtk;
use nsh_platform_linux::{AppOptions, AppSource, AssetBase, Bundle, Limits, run_app, set_ui_sets};
use serde_json::json;

use crate::config::Config;

pub fn run(config: Config) -> std::process::ExitCode {
    // Once, before the first view: what the app's TSX may import, NSH's and the app's own crate.
    set_ui_sets(vec![nsh_base::registry(), deskfolk_app_native::registry()]);
    // `--quit` shows no window: it hands itself to the running copy, or ends at once (`window-life.ts`).
    let bundle = match read_bundle(&config.bundle, config.hidden || config.quit) {
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
    if !config.quit {
        crate::runtime::supervise(config.data_dir.clone());
        crate::linux_login::sync(config.endpoint.clone());
        crate::stop_all::watch();
    }
    // The window's icon where the desktop has none from the entry (X11 without a matching
    // `StartupWMClass`, a dev build): the installed icon, by the app's id.
    if gtk::init().is_ok() {
        gtk::Window::set_default_icon_name(&config.bundle_id);
    }
    let options = AppOptions {
        app_id: config.bundle_id.clone(),
        title: config.app_name.clone(),
        size: (1100, 760),
        limits: Limits::standalone(),
        data_dir: Some(crate::config::nsh_data_dir(&config.data_dir)),
        asset_base: config.bundle.parent().map(|dir| AssetBase::Directory(dir.join("assets"))),
        host,
        fps: config.fps,
        // One copy of the release at a time, as the 0.4.0 app was: a later launch (the
        // applications menu while the login launch waits in the tray) brings that one's window
        // forward and ends.
        single_instance: crate::config::RELEASE,
        background: config.background,
        ..AppOptions::default()
    };
    // `run_app` returns when this copy's run ends, and also when this launch only handed itself to
    // the copy already running (`single_instance`), whose runtime it must leave alone. The app tells
    // which: one whose window ran here has called the shell (`launch::channel`).
    let code = run_app(AppSource::Bundle(bundle), options);
    if crate::runtime::window_ran() {
        crate::runtime::stop();
    } else {
        crate::runtime::stop_started();
    }
    if code == gtk::glib::ExitCode::SUCCESS { std::process::ExitCode::SUCCESS } else { std::process::ExitCode::FAILURE }
}

fn read_bundle(path: &std::path::Path, hidden: bool) -> Result<Bundle, String> {
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    let bundle = unsafe { Bundle::read_trusted(path) }.map_err(|e| format!("cannot read bundle {}: {e}", path.display()))?;
    Ok(bundle.with_main_window(Some(&launch_window(hidden).to_string())))
}

/// The main window's launch options (`nsh.json` `"window"`'s shape): the app draws its own title
/// bar, as on macOS and Windows; it comes back at the size it was left at, maximized if it was; it
/// goes no smaller than the 0.4.0 window; a login launch (`--hidden`) keeps it unseen until the tray
/// or a later launch shows it.
fn launch_window(hidden: bool) -> serde_json::Value {
    let mut window = json!({
        "titleBar": { "style": "hidden" },
        "restoreBounds": true,
        "minSize": { "width": 640, "height": 480 },
    });
    if hidden {
        window["defaultVisible"] = json!(false);
    }
    window
}

/// Whether a tray shows the app's icon on this desktop: a StatusNotifierItem host is on the session
/// bus (Plasma, XFCE, most panels; GNOME only with the AppIndicator extension). Without one the
/// close button minimizes rather than hides (`window-life.ts`).
pub fn tray_shown() -> bool {
    use gtk::gio;
    use gtk::glib;
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else { return false };
    let answer = bus.call_sync(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "NameHasOwner",
        Some(&("org.kde.StatusNotifierWatcher",).into()),
        Some(glib::VariantTy::new("(b)").expect("a variant type")),
        gio::DBusCallFlags::NONE,
        1000,
        gio::Cancellable::NONE,
    );
    answer.ok().and_then(|reply| reply.get::<(bool,)>()).is_some_and(|(owned,)| owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_draws_its_own_title_bar_and_comes_back_where_it_was() {
        let shown = launch_window(false);
        assert_eq!(shown["titleBar"]["style"], "hidden");
        assert_eq!(shown["restoreBounds"], true);
        assert!(shown.get("defaultVisible").is_none());
        assert_eq!(launch_window(true)["defaultVisible"], false);
        assert!(nsh_core::desktop::MainWindowOptions::from_json(&shown).is_ok());
    }
}
