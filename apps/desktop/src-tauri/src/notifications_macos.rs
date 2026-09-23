use std::ptr::NonNull;
use std::sync::OnceLock;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, ClassType};
use objc2_app_kit::NSApplication;
use objc2_foundation::{MainThreadMarker, NSArray, NSBundle, NSDictionary, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

use crate::notifications::NotificationAdapter;

/// Cold-start click from a signed, installed package is still unverified.
/// That gap stays visible here. It does not decide whether a banner can be posted:
/// posting follows the process bundle identity and the user's system permission.
pub const NATIVE_DELIVERY_QUALIFIED: bool = false;

/// A banner can be handed to Notification Center when this process has a bundle
/// identity. The cold-click qualification above is a separate, still-open check.
pub(crate) fn native_posting_ready(bundle_present: bool) -> bool {
    bundle_present
}

type OnClickCallback = Box<dyn Fn(&str) + Send + Sync>;
static ON_CLICK_CALLBACK: OnceLock<OnClickCallback> = OnceLock::new();
static DELEGATE_HOLDER: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "RealBotNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[allow(non_snake_case)]
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn userNotificationCenter_willPresentNotification_withCompletionHandler(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let options = UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::Sound
                | UNNotificationPresentationOptions::Badge;
            completion_handler.call((options,));
        }

        #[allow(non_snake_case)]
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let content = response.notification().request().content();
            let user_info = content.userInfo();
            let key = NSString::from_str("click_ref");
            let click_ref = if let Some(obj) = user_info.objectForKey(&key) {
                if let Ok(str_obj) = obj.downcast::<NSString>() {
                    str_obj.to_string()
                } else {
                    response.notification().request().identifier().to_string()
                }
            } else {
                response.notification().request().identifier().to_string()
            };

            if let Some(cb) = ON_CLICK_CALLBACK.get() {
                cb(&click_ref);
            }
            completion_handler.call(());
        }
    }
);

pub struct MacOsNotificationAdapter;

impl MacOsNotificationAdapter {
    pub fn new() -> Self {
        Self
    }

    fn bundle_id_present(&self) -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
    }
}

impl NotificationAdapter for MacOsNotificationAdapter {
    fn is_operational(&self) -> bool {
        native_posting_ready(self.bundle_id_present())
    }

    fn gated_reason(&self) -> Option<String> {
        if self.bundle_id_present() {
            None
        } else {
            Some("bundle_identifier_missing".to_string())
        }
    }

    fn setup_delegate(&self, on_click: Box<dyn Fn(&str) + Send + Sync + 'static>) {
        let _ = ON_CLICK_CALLBACK.set(on_click);
        if !self.bundle_id_present() {
            return;
        }

        DELEGATE_HOLDER.get_or_init(|| {
            let delegate: Retained<NotificationDelegate> =
                unsafe { objc2::msg_send![NotificationDelegate::class(), new] };
            let center = UNUserNotificationCenter::currentNotificationCenter();
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            delegate
        });
    }

    fn get_permission_state(&self) -> Result<String, String> {
        if !self.bundle_id_present() {
            return Ok("default".to_string());
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = std::sync::mpsc::channel();
        let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let settings = unsafe { settings.as_ref() };
            let status = settings.authorizationStatus();
            let _ = tx.send(status);
        });

        center.getNotificationSettingsWithCompletionHandler(&handler);
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(status) => match status {
                UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => {
                    Ok("granted".to_string())
                }
                UNAuthorizationStatus::Denied => Ok("denied".to_string()),
                UNAuthorizationStatus::NotDetermined => Ok("default".to_string()),
                _ => Ok("default".to_string()),
            },
            Err(e) => Err(format!("timeout querying notification settings: {e}")),
        }
    }

    fn request_permission(&self) -> Result<String, String> {
        if !self.bundle_id_present() {
            return Err("bundle_identifier_missing".to_string());
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = std::sync::mpsc::channel();
        let options = UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge;
        let handler = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            if !err.is_null() {
                let _ = tx.send(Err("request_failed".to_string()));
            } else {
                let _ = tx.send(Ok(granted.as_bool()));
            }
        });

        center.requestAuthorizationWithOptions_completionHandler(options, &handler);
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(Ok(true)) => Ok("granted".to_string()),
            Ok(Ok(false)) => Ok("denied".to_string()),
            Ok(Err(err)) => Err(err),
            Err(e) => Err(format!("timeout requesting notification permission: {e}")),
        }
    }

    fn post_notification(
        &self,
        identifier: &str,
        title: &str,
        body: &str,
        sound: &str,
        click_ref: &str,
    ) -> Result<(), String> {
        if !self.bundle_id_present() {
            return Err("bundle_identifier_missing".to_string());
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        if sound != "none" && sound != "off" {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }

        let key = NSString::from_str("click_ref");
        let val = NSString::from_str(click_ref);
        let user_info = NSDictionary::from_slices(&[&*key], &[&*val]);
        unsafe {
            let untyped_dict: &NSDictionary = core::mem::transmute(&*user_info);
            content.setUserInfo(untyped_dict);
        }

        let ns_ident = NSString::from_str(identifier);
        let req =
            UNNotificationRequest::requestWithIdentifier_content_trigger(&ns_ident, &content, None);

        let (tx, rx) = std::sync::mpsc::channel();
        let handler = RcBlock::new(move |err: *mut NSError| {
            if !err.is_null() {
                let _ = tx.send(Err("failed_to_add_request".to_string()));
            } else {
                let _ = tx.send(Ok(()));
            }
        });

        center.addNotificationRequest_withCompletionHandler(&req, Some(&handler));
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| match e {
                std::sync::mpsc::RecvTimeoutError::Timeout => "os_timeout".to_string(),
                std::sync::mpsc::RecvTimeoutError::Disconnected => {
                    "channel_disconnected".to_string()
                }
            })?
    }

    fn get_delivered_identifiers(&self) -> Result<Vec<String>, String> {
        if !self.bundle_id_present() {
            return Ok(Vec::new());
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = std::sync::mpsc::channel();
        let handler = RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
            let arr = unsafe { notifications.as_ref() };
            let mut idents = Vec::new();
            for i in 0..arr.count() {
                let notif = arr.objectAtIndex(i);
                idents.push(notif.request().identifier().to_string());
            }
            let _ = tx.send(idents);
        });

        center.getDeliveredNotificationsWithCompletionHandler(&handler);
        Ok(rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default())
    }

    fn remove_delivered_notifications(&self, identifiers: &[String]) -> Result<(), String> {
        if identifiers.is_empty() || !self.bundle_id_present() {
            return Ok(());
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let ns_strings: Vec<Retained<NSString>> =
            identifiers.iter().map(|s| NSString::from_str(s)).collect();
        let arr = NSArray::from_retained_slice(&ns_strings);
        center.removeDeliveredNotificationsWithIdentifiers(&arr);
        Ok(())
    }

    fn set_dock_badge(&self, label: Option<&str>) -> Result<(), String> {
        if let Some(mtm) = MainThreadMarker::new() {
            let app = NSApplication::sharedApplication(mtm);
            let dock = app.dockTile();
            let badge_ns = label.map(NSString::from_str);
            dock.setBadgeLabel(badge_ns.as_deref());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_click_qualification_does_not_block_posting() {
        assert!(!NATIVE_DELIVERY_QUALIFIED);
        assert!(native_posting_ready(true));
        assert!(!native_posting_ready(false));
    }
}
