//! System notifications and the Dock badge. NSH 0.4 has neither for an embedding app, so the shell
//! posts them itself, the way the Tauri shell's `notifications_macos.rs` does: Notification Center
//! needs a bundle identity, which the dev build gets from its `.app` wrapper (scripts/dev.ts).

use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{ClassType, define_class, msg_send};
use objc2_app_kit::NSApplication;
use objc2_foundation::{MainThreadMarker, NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

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
            let id = response.notification().request().identifier().to_string();
            if let Some(on_click) = ON_CLICK.get() {
                on_click(id);
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
