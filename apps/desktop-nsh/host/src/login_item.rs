//! Launch at login, as `set_launch_at_login` and `register_login_item` do in the Tauri app
//! (`v0.5.1:apps/desktop/src-tauri/src/lib.rs`, which goes through `tauri_plugin_autostart`'s AppleScript
//! login item). Here it is the system's own `SMAppService.mainAppService`: the running `.app`
//! registered as a login item (macOS 13+). A dev build answers `false` and changes nothing.
//!
//! `SMAppService` cannot pass arguments: a login launch knows itself by its Apple event instead
//! (`app.rs`, `launched_at_login`) and keeps to the menu bar, as the Tauri app's `--hidden` did.
//!
//! A release's start makes the item follow the `launch_at_login` setting (on unless turned off),
//! as the Windows shell does (`win_login.rs`): registering on every launch would bring back an item
//! you had turned off in the settings.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::NSError;

use crate::dev_build::Identity;

#[link(name = "ServiceManagement", kind = "framework")]
unsafe extern "C" {}

/// `SMAppServiceStatusEnabled`.
const STATUS_ENABLED: isize = 1;

/// The system's login item for this app.
pub trait LoginItem {
    fn register(&self) -> Result<(), String>;
    fn unregister(&self) -> Result<(), String>;
    fn enabled(&self) -> bool;
}

struct MainApp;

fn service() -> Result<Retained<AnyObject>, String> {
    let class = AnyClass::get(c"SMAppService").ok_or("login items need macOS 13")?;
    let service: Option<Retained<AnyObject>> = unsafe { msg_send![class, mainAppService] };
    service.ok_or_else(|| "login items are unavailable".to_string())
}

impl LoginItem for MainApp {
    fn register(&self) -> Result<(), String> {
        let service = service()?;
        let done: Result<(), Retained<NSError>> = unsafe { msg_send![&*service, registerAndReturnError: _] };
        done.map_err(|e| e.localizedDescription().to_string())
    }

    fn unregister(&self) -> Result<(), String> {
        let service = service()?;
        let done: Result<(), Retained<NSError>> = unsafe { msg_send![&*service, unregisterAndReturnError: _] };
        done.map_err(|e| e.localizedDescription().to_string())
    }

    fn enabled(&self) -> bool {
        service()
            .map(|service| {
                let status: isize = unsafe { msg_send![&*service, status] };
                status == STATUS_ENABLED
            })
            .unwrap_or(false)
    }
}

/// `set_launch_at_login({ enabled })`: the item's state afterwards.
pub fn set(id: &Identity, enabled: bool) -> Result<bool, String> {
    set_with(id.is_dev(), enabled, &MainApp)
}

pub fn set_with(dev: bool, enabled: bool, item: &dyn LoginItem) -> Result<bool, String> {
    if dev {
        return Ok(false);
    }
    if enabled {
        item.register()?;
    } else {
        item.unregister()?;
    }
    Ok(item.enabled())
}

/// A packaged build's start: the login item follows the setting, read from the runtime once it
/// answers. On a thread of its own: it waits on the network.
pub fn sync_on_launch(id: &Identity, endpoint: crate::endpoint::Endpoint) {
    if id.is_dev() {
        return;
    }
    std::thread::spawn(move || {
        let Some(wanted) = crate::endpoint::launch_at_login_setting(&endpoint) else {
            log::warn!("launch at login left as it is: the settings did not answer");
            return;
        };
        match set_with(false, wanted, &MainApp) {
            Ok(now) => log::info!("launch at login {}", if now { "on" } else { "off" }),
            Err(why) => log::warn!("launch at login: {why}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<&'static str>>,
        on: RefCell<bool>,
    }

    impl LoginItem for Fake {
        fn register(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("register");
            *self.on.borrow_mut() = true;
            Ok(())
        }
        fn unregister(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("unregister");
            *self.on.borrow_mut() = false;
            Ok(())
        }
        fn enabled(&self) -> bool {
            *self.on.borrow()
        }
    }

    #[test]
    fn a_dev_build_answers_false_and_changes_nothing() {
        let fake = Fake::default();
        assert_eq!(set_with(true, true, &fake), Ok(false));
        assert_eq!(set_with(true, false, &fake), Ok(false));
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn a_packaged_build_registers_and_reports_the_systems_state() {
        let fake = Fake::default();
        assert_eq!(set_with(false, true, &fake), Ok(true));
        assert_eq!(set_with(false, false, &fake), Ok(false));
        assert_eq!(*fake.calls.borrow(), vec!["register", "unregister"]);
    }
}
