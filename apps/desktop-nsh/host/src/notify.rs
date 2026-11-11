//! System notifications and the Dock badge. NSH 0.4 has neither for an embedding app, so the shell
//! posts them itself, the way the Tauri shell's `notifications_macos.rs` does: Notification Center
//! needs a bundle identity, which the dev build gets from its `.app` wrapper (scripts/dev.ts).

use std::ptr::NonNull;
use std::sync::OnceLock;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{ClassType, define_class, msg_send};
use dispatch2::DispatchQueue;
use objc2_app_kit::NSApplication;
use objc2_foundation::{MainThreadMarker, NSArray, NSBundle, NSDictionary, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

use crate::notification_loop::NotificationAdapter;

/// The key a banner's `userInfo` keeps the messenger's click reference under (the Tauri shell's).
const CLICK_REF_KEY: &str = "click_ref";

type OnClick = Box<dyn Fn(String) + Send + Sync>;
static ON_CLICK: OnceLock<OnClick> = OnceLock::new();
static DELEGATE: OnceLock<Retained<Delegate>> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "DeskfolkNshNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::Sound
                | UNNotificationPresentationOptions::Badge,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let request = response.notification().request();
            // The click reference the banner was posted with; a banner without one (`shell.notify`)
            // reports its identifier.
            let click_ref = request
                .content()
                .userInfo()
                .objectForKey(&NSString::from_str(CLICK_REF_KEY))
                .and_then(|value| value.downcast::<NSString>().ok())
                .map(|value| value.to_string())
                .unwrap_or_else(|| request.identifier().to_string());
            if let Some(on_click) = ON_CLICK.get() {
                on_click(click_ref);
            }
            completion.call(());
        }
    }
);

/// Whether this process can post at all: Notification Center refuses a bare binary.
pub fn available() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Installs the delegate and asks for permission once; `on_click` gets the clicked banner's id.
pub fn setup(on_click: impl Fn(String) + Send + Sync + 'static) {
    let _ = ON_CLICK.set(Box::new(on_click));
    if !available() {
        log::warn!("notifications: no bundle identifier; run the dev build from its .app wrapper");
        return;
    }
    DELEGATE.get_or_init(|| {
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::class(), new] };
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let options =
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
        let answer = RcBlock::new(|granted: Bool, error: *mut NSError| {
            if !error.is_null() || !granted.as_bool() {
                log::warn!("notifications: permission not granted");
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(options, &answer);
        delegate
    });
}

/// Posts a banner. Returns at once; a refusal is logged.
pub fn post(id: &str, title: &str, body: &str) -> Result<(), String> {
    if !available() {
        return Err("bundle_identifier_missing".into());
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
    let done = RcBlock::new(|error: *mut NSError| {
        if error.is_null() {
            log::info!("notifications: Notification Center took the banner");
        } else {
            let why = unsafe { (*error).localizedDescription() }.to_string();
            log::warn!("notifications: Notification Center refused the banner: {why}");
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&done));
    Ok(())
}

/// The Dock badge; `None` clears it. Main thread.
pub fn set_badge(mtm: MainThreadMarker, label: Option<&str>) {
    let label = label.filter(|l| !l.is_empty()).map(NSString::from_str);
    let tile = NSApplication::sharedApplication(mtm).dockTile();
    tile.setBadgeLabel(label.as_deref());
    log::info!("dock badge now {:?}", tile.badgeLabel().map(|l| l.to_string()));
}

/// Notification Center's permission as the messenger names it: `granted`, `denied` or `default`
/// (not asked yet). Blocks up to 3 s on Notification Center, so never on the main thread's own
/// work or an engine thread.
pub fn permission_state() -> Result<String, String> {
    if !available() {
        return Ok("default".to_string());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus());
    });
    UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&handler);
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional) => Ok("granted".to_string()),
        Ok(UNAuthorizationStatus::Denied) => Ok("denied".to_string()),
        Ok(_) => Ok("default".to_string()),
        Err(e) => Err(format!("timeout querying notification settings: {e}")),
    }
}

/// Asks the system for permission (the person answers the prompt; up to 60 s).
pub fn request_permission() -> Result<String, String> {
    if !available() {
        return Err("bundle_identifier_missing".to_string());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
    let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        let _ = tx.send(if error.is_null() { Ok(granted.as_bool()) } else { Err("request_failed".to_string()) });
    });
    UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(options, &handler);
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Ok(true)) => Ok("granted".to_string()),
        Ok(Ok(false)) => Ok("denied".to_string()),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("timeout requesting notification permission: {e}")),
    }
}

/// Posts a banner carrying `click_ref` in its `userInfo` and waits (up to 5 s) for Notification
/// Center's verdict: `os_timeout` when it gives none, `failed_to_add_request` when it refuses.
pub fn post_with_ref(id: &str, title: &str, body: &str, sound: &str, click_ref: &str) -> Result<(), String> {
    if !available() {
        return Err("bundle_identifier_missing".to_string());
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    if sound != "none" && sound != "off" {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    let key = NSString::from_str(CLICK_REF_KEY);
    let value = NSString::from_str(click_ref);
    let info = NSDictionary::from_slices(&[&*key], &[&*value]);
    // SAFETY: the dictionary holds only NSString values, which `userInfo` accepts as `AnyObject`.
    unsafe {
        let untyped: &NSDictionary = core::mem::transmute(&*info);
        content.setUserInfo(untyped);
    }
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
    let (tx, rx) = std::sync::mpsc::channel();
    let done = RcBlock::new(move |error: *mut NSError| {
        let _ = tx.send(if error.is_null() { Ok(()) } else { Err("failed_to_add_request".to_string()) });
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
    rx.recv_timeout(Duration::from_secs(5)).map_err(|e| match e {
        std::sync::mpsc::RecvTimeoutError::Timeout => "os_timeout".to_string(),
        std::sync::mpsc::RecvTimeoutError::Disconnected => "channel_disconnected".to_string(),
    })?
}

/// The identifiers of the banners still in Notification Center.
pub fn delivered_identifiers() -> Vec<String> {
    if !available() {
        return Vec::new();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handler = RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
        let notifications = unsafe { notifications.as_ref() };
        let ids = (0..notifications.count())
            .map(|i| notifications.objectAtIndex(i).request().identifier().to_string())
            .collect::<Vec<_>>();
        let _ = tx.send(ids);
    });
    UNUserNotificationCenter::currentNotificationCenter().getDeliveredNotificationsWithCompletionHandler(&handler);
    rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
}

pub fn remove_delivered(ids: &[String]) {
    if ids.is_empty() || !available() {
        return;
    }
    let strings: Vec<Retained<NSString>> = ids.iter().map(|id| NSString::from_str(id)).collect();
    UNUserNotificationCenter::currentNotificationCenter()
        .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&strings));
}

/// The Notification Center adapter the delivery loop and the messenger's commands run on.
pub struct MacAdapter;

impl NotificationAdapter for MacAdapter {
    /// A banner can be handed over when the process has a bundle identity.
    fn is_operational(&self) -> bool {
        available()
    }

    fn gated_reason(&self) -> Option<String> {
        (!available()).then(|| "bundle_identifier_missing".to_string())
    }

    fn get_permission_state(&self) -> Result<String, String> {
        permission_state()
    }

    fn request_permission(&self) -> Result<String, String> {
        request_permission()
    }

    fn post_notification(&self, id: &str, title: &str, body: &str, sound: &str, click_ref: &str) -> Result<(), String> {
        post_with_ref(id, title, body, sound, click_ref)
    }

    fn get_delivered_identifiers(&self) -> Result<Vec<String>, String> {
        Ok(delivered_identifiers())
    }

    fn remove_delivered_notifications(&self, identifiers: &[String]) -> Result<(), String> {
        remove_delivered(identifiers);
        Ok(())
    }

    fn set_dock_badge(&self, label: Option<&str>) -> Result<(), String> {
        let label = label.map(str::to_owned);
        DispatchQueue::main().exec_async(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                set_badge(mtm, label.as_deref());
            }
        });
        Ok(())
    }
}
