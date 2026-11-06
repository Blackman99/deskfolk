//! Launch at login, as `set_launch_at_login` and `register_login_item` do in the Tauri app
//! (`apps/desktop/src-tauri/src/lib.rs`, which goes through `tauri_plugin_autostart`'s AppleScript
//! login item). Here it is the system's own `SMAppService.mainAppService`: the running `.app`
//! registered as a login item (macOS 13+). A dev build answers `false` and changes nothing.
//!
//! `SMAppService` cannot pass arguments, so a login launch opens the window; the Tauri app's
//! `--hidden` start-to-tray has no counterpart here yet.

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

/// The first launch of a packaged build puts the app among the login items (`register_login_item`).
pub fn register_on_launch(id: &Identity) {
    if id.is_dev() {
        return;
    }
    let _ = MainApp.register();
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
