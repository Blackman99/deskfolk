//! The delivery loop and the commands' logic, transplanted from the Tauri shell's
//! `notifications.rs` with the Tauri types taken out: every 2 s the runtime is polled for the
//! attention count (the Dock badge), the delivered banners are reconciled when the cleanup
//! revision moves, and one notification is claimed, revalidated, posted and reported. A click
//! stores an intent (`clickRef`) the messenger takes. The window's own facts come from
//! `window.rs`; the runtime's address from `Config.endpoint`.
//!
//! Left out on purpose: the Tauri shell's `TrustedNotificationCaller` document check and its cold
//! click qualification. Both guard a WebView document that may be a dev server or a bundled page;
//! here every caller is an NSH app of ours, granted by `nsh.json` `capabilities.host`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::endpoint::Endpoint;
use crate::notifications::*;

pub trait NotificationAdapter: Send + Sync {
    fn is_operational(&self) -> bool;
    fn gated_reason(&self) -> Option<String>;
    fn get_permission_state(&self) -> Result<String, String>;
    fn request_permission(&self) -> Result<String, String>;
    fn post_notification(
        &self,
        identifier: &str,
        title: &str,
        body: &str,
        sound: &str,
        click_ref: &str,
    ) -> Result<(), String>;
    fn get_delivered_identifiers(&self) -> Result<Vec<String>, String>;
    fn remove_delivered_notifications(&self, identifiers: &[String]) -> Result<(), String>;
    /// Any thread: the adapter hops to the main queue itself.
    fn set_dock_badge(&self, label: Option<&str>) -> Result<(), String>;
}

pub struct NotificationState {
    pub owner_id: String,
    pub intent_buffer: Mutex<Option<NotificationIntent>>,
    pub last_cleanup_revision: AtomicU64,
    pub last_attention_count: AtomicU32,
    pub current_badge_label: Mutex<Option<String>>,
    pub quitting: AtomicBool,
    pub adapter: Arc<dyn NotificationAdapter>,
    instance_id: String,
    presence: Mutex<HashMap<u32, Arc<PresenceQueue>>>,
}

impl NotificationState {
    pub fn with_adapter(adapter: Arc<dyn NotificationAdapter>) -> Self {
        Self {
            owner_id: random_hex(),
            intent_buffer: Mutex::new(None),
            last_cleanup_revision: AtomicU64::new(0),
            last_attention_count: AtomicU32::new(0),
            current_badge_label: Mutex::new(None),
            quitting: AtomicBool::new(false),
            adapter,
            instance_id: random_hex(),
            presence: Mutex::new(HashMap::new()),
        }
    }

    pub fn stop(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    /// The presence queue of window `id`: each window is its own presence instance, so a hidden
    /// window's report does not take back what a visible one said.
    fn presence_for(&self, window: u32) -> Arc<PresenceQueue> {
        let mut queues = self.presence.lock().unwrap_or_else(|e| e.into_inner());
        queues
            .entry(window)
            .or_insert_with(|| Arc::new(PresenceQueue::new(format!("{}-w{window}", self.instance_id))))
            .clone()
    }
}

/// The process's state, made on first use with the macOS adapter.
#[cfg(target_os = "macos")]
pub fn state() -> &'static Arc<NotificationState> {
    static STATE: OnceLock<Arc<NotificationState>> = OnceLock::new();
    STATE.get_or_init(|| Arc::new(NotificationState::with_adapter(Arc::new(crate::notify::MacAdapter))))
}

static ENDPOINT: OnceLock<Endpoint> = OnceLock::new();

/// Where the runtime listens, once the loop has started.
pub fn endpoint() -> Option<Endpoint> {
    ENDPOINT.get().cloned()
}

/// Starts the loop for the process, once, against the runtime at `endpoint`.
#[cfg(target_os = "macos")]
pub fn start(endpoint: Endpoint) {
    if ENDPOINT.set(endpoint.clone()).is_ok() {
        spawn_loop(state().clone(), endpoint);
    }
}

/// 128 random bits as hex; the time only if the system has none to give.
fn random_hex() -> String {
    use std::io::Read;
    let mut buf = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_ok() {
        return buf.iter().map(|b| format!("{b:02x}")).collect();
    }
    format!(
        "{:032x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
    )
}

/// The Dock badge text for an attention count: nothing at 0 or when the device preference turns
/// it off, `99+` past 99.
pub fn badge_label(count: u32, active: bool) -> Option<String> {
    if !active || count == 0 {
        None
    } else if count > 99 {
        Some("99+".to_string())
    } else {
        Some(count.to_string())
    }
}

/// A banner was clicked: keep the intent for the messenger and bring the window forward.
pub fn on_click(state: &NotificationState, click_ref: &str, show: impl FnOnce()) {
    if let Ok(mut guard) = state.intent_buffer.lock() {
        *guard = Some(NotificationIntent { click_ref: click_ref.to_string() });
    }
    show();
}

/// One pass of the loop, against the runtime at `endpoint`.
pub fn poll_cycle(state: &NotificationState, endpoint: &Endpoint) {
    let adapter = &*state.adapter;
    if let Ok(state_resp) = poll_state(endpoint) {
        let count = state_resp.attention_count;
        state.last_attention_count.store(count, Ordering::SeqCst);

        let preference =
            poll_device_preference(endpoint).unwrap_or_else(|_| NotificationDeviceResponse::default_preference());
        let desired_badge = badge_label(count, preference.enabled && preference.badge);
        if let Ok(mut current) = state.current_badge_label.lock() {
            if *current != desired_badge {
                *current = desired_badge.clone();
                let _ = adapter.set_dock_badge(desired_badge.as_deref());
            }
        }

        if state_resp.cleanup_revision != state.last_cleanup_revision.load(Ordering::SeqCst) {
            if let Ok(identifiers) = adapter.get_delivered_identifiers() {
                let mut all_succeeded = true;
                for chunk in identifiers.chunks(100) {
                    match reconcile_notifications(endpoint, chunk) {
                        Ok(reconcile) => {
                            if !reconcile.remove_identifiers.is_empty() {
                                let _ = adapter.remove_delivered_notifications(&reconcile.remove_identifiers);
                            }
                        }
                        Err(_) => {
                            all_succeeded = false;
                            break;
                        }
                    }
                }
                if all_succeeded {
                    state.last_cleanup_revision.store(state_resp.cleanup_revision, Ordering::SeqCst);
                }
            }
        }
    }

    let permission = adapter.get_permission_state().unwrap_or_else(|_| "default".to_string());
    let Ok(Some(claim)) = claim_notifications(endpoint, &state.owner_id, &permission) else { return };
    let (delivery_id, claim_token) = (&claim.delivery_id, &claim.claim_token);
    let report = |result: &str, code: Option<&str>| {
        let _ = report_delivery(endpoint, delivery_id, claim_token, result, code);
    };
    match revalidate_claim(endpoint, delivery_id, claim_token) {
        Ok(reval) => match reval.action.as_str() {
            "deliver" => {
                let title = reval.title.as_deref().unwrap_or(&claim.title);
                let body = reval.body.as_deref().unwrap_or(&claim.body);
                let sound = reval.sound.as_deref().or(claim.sound.as_deref()).unwrap_or("default");
                if adapter.is_operational() {
                    match adapter.post_notification(&claim.identifier, title, body, sound, &claim.click_ref) {
                        Ok(()) => report("accepted", None),
                        Err(e) => report(if e == "os_timeout" { "unknown" } else { "failed" }, Some(&e)),
                    }
                } else {
                    report("failed", Some("delivery_gated"));
                }
            }
            "cancel" => report("failed", Some("cancelled")),
            "retry_later" => {}
            _ => report("unknown", Some("unknown_action")),
        },
        Err(e) => report("unknown", Some(&e)),
    }
}

/// The loop's thread: every 2 s, until `stop`. `endpoint` is where the runtime listens.
pub fn spawn_loop(state: Arc<NotificationState>, endpoint: Endpoint) {
    let _ = std::thread::Builder::new().name("notifications".into()).spawn(move || {
        while !state.quitting.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(2));
            if state.quitting.load(Ordering::SeqCst) {
                break;
            }
            poll_cycle(&state, &endpoint);
        }
    });
}

fn permission_dto(state: &NotificationState, permission: String) -> NotificationPermissionStateDto {
    let operational = state.adapter.is_operational();
    NotificationPermissionStateDto {
        permission,
        native_reading_v1: true,
        native_delivery_v1: operational,
        // The Tauri shell's cold-click check does not exist here (see the module note).
        cold_click_qualified: false,
        operational,
        gated_reason: state.adapter.gated_reason(),
        attention_count: state.last_attention_count.load(Ordering::SeqCst),
    }
}

/// `notification_permission_state`. Blocks on Notification Center: not for the engine thread.
pub fn permission_state(state: &NotificationState) -> NotificationPermissionStateDto {
    let permission = state.adapter.get_permission_state().unwrap_or_else(|_| "default".to_string());
    permission_dto(state, permission)
}

/// `request_notification_permission`. Blocks until the person answers: not for the engine thread.
pub fn request_permission(state: &NotificationState) -> Result<NotificationPermissionStateDto, String> {
    let permission = match state.adapter.request_permission() {
        Ok(p) => p,
        Err(e) => {
            if state.adapter.is_operational() {
                return Err(e);
            }
            state.adapter.get_permission_state().unwrap_or_else(|_| "default".to_string())
        }
    };
    Ok(permission_dto(state, permission))
}

/// `take_notification_intent`: the clicked banner's reference, once.
pub fn take_intent(state: &NotificationState) -> Result<Option<NotificationIntent>, String> {
    let mut guard = state.intent_buffer.lock().map_err(|_| "intent_buffer_poisoned".to_string())?;
    Ok(guard.take())
}

/// What a window looks like to the OS: `(visible, key window, miniaturized)`.
pub type WindowFacts = (bool, bool, bool);

/// `report_notification_view`: combines the window's own facts with the messenger's report, tells
/// the runtime (off this thread) and answers the facts.
pub fn report_view(
    state: &NotificationState,
    window: u32,
    facts: Option<WindowFacts>,
    report: NotificationViewReport,
    endpoint: Option<Endpoint>,
) -> NativeFocusFacts {
    let (is_visible, is_focused, is_minimized) = facts.unwrap_or((false, false, false));
    let rust_focused = is_visible && is_focused && !is_minimized;
    let effective_focused = rust_focused && report.focused.unwrap_or(false);
    let effective_visible = is_visible && !is_minimized && report.visible.unwrap_or(true);

    if let Some(endpoint) = endpoint {
        state.presence_for(window).send(PresenceJob {
            endpoint,
            visible: effective_visible,
            focused: effective_focused,
            session_id: report.session_id,
            at_latest: report.at_latest.unwrap_or(false),
        });
    }
    NativeFocusFacts {
        visible: effective_visible,
        focused: rust_focused,
        minimized: is_minimized,
        effective_focused,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::fake::serve;

    #[derive(Default)]
    struct MockAdapter {
        operational: bool,
        permission: Mutex<String>,
        delivered: Mutex<Vec<String>>,
        posted: Mutex<Vec<(String, String, String, String, String)>>,
        removed: Mutex<Vec<String>>,
        dock_badge: Mutex<Option<String>>,
    }

    impl NotificationAdapter for MockAdapter {
        fn is_operational(&self) -> bool {
            self.operational
        }
        fn gated_reason(&self) -> Option<String> {
            (!self.operational).then(|| "bundle_identifier_missing".to_string())
        }
        fn get_permission_state(&self) -> Result<String, String> {
            Ok(self.permission.lock().unwrap().clone())
        }
        fn request_permission(&self) -> Result<String, String> {
            if !self.operational {
                return Err("bundle_identifier_missing".to_string());
            }
            *self.permission.lock().unwrap() = "granted".to_string();
            Ok("granted".to_string())
        }
        fn post_notification(&self, id: &str, title: &str, body: &str, sound: &str, click: &str) -> Result<(), String> {
            if !self.operational {
                return Err("bundle_identifier_missing".to_string());
            }
            self.posted.lock().unwrap().push((id.into(), title.into(), body.into(), sound.into(), click.into()));
            Ok(())
        }
        fn get_delivered_identifiers(&self) -> Result<Vec<String>, String> {
            Ok(self.delivered.lock().unwrap().clone())
        }
        fn remove_delivered_notifications(&self, identifiers: &[String]) -> Result<(), String> {
            self.removed.lock().unwrap().extend(identifiers.iter().cloned());
            self.delivered.lock().unwrap().retain(|id| !identifiers.contains(id));
            Ok(())
        }
        fn set_dock_badge(&self, label: Option<&str>) -> Result<(), String> {
            *self.dock_badge.lock().unwrap() = label.map(str::to_string);
            Ok(())
        }
    }

    fn state_with(adapter: MockAdapter) -> (Arc<MockAdapter>, NotificationState) {
        let adapter = Arc::new(adapter);
        (adapter.clone(), NotificationState::with_adapter(adapter))
    }

    #[test]
    fn badge_label_formatting() {
        assert_eq!(badge_label(0, true), None);
        assert_eq!(badge_label(5, true), Some("5".into()));
        assert_eq!(badge_label(99, true), Some("99".into()));
        assert_eq!(badge_label(120, true), Some("99+".into()));
        assert_eq!(badge_label(5, false), None);
    }

    #[test]
    fn the_intent_is_taken_once() {
        let (_, state) = state_with(MockAdapter::default());
        assert_eq!(take_intent(&state).unwrap(), None);
        let mut shown = false;
        on_click(&state, "click-1", || shown = true);
        assert!(shown);
        assert_eq!(take_intent(&state).unwrap(), Some(NotificationIntent { click_ref: "click-1".into() }));
        assert_eq!(take_intent(&state).unwrap(), None);
    }

    #[test]
    fn the_permission_dto_fails_closed_without_a_bundle_and_opens_with_one() {
        let (_, closed) =
            state_with(MockAdapter { permission: Mutex::new("default".into()), ..Default::default() });
        let dto = permission_state(&closed);
        assert_eq!(dto.permission, "default");
        assert!(dto.native_reading_v1 && !dto.native_delivery_v1 && !dto.operational);
        assert_eq!(dto.gated_reason.as_deref(), Some("bundle_identifier_missing"));
        // A gated adapter's refusal answers the plain state instead of an error.
        assert_eq!(request_permission(&closed).unwrap().permission, "default");

        let (_, open) = state_with(MockAdapter {
            operational: true,
            permission: Mutex::new("default".into()),
            ..Default::default()
        });
        assert_eq!(request_permission(&open).unwrap().permission, "granted");
        let dto = permission_state(&open);
        assert!(dto.native_delivery_v1 && dto.operational);
        assert_eq!(dto.gated_reason, None);
    }

    #[test]
    fn the_view_report_combines_the_window_and_the_messenger() {
        let (_, state) = state_with(MockAdapter::default());
        let report = |visible, focused| NotificationViewReport {
            visible: Some(visible),
            focused: Some(focused),
            ..Default::default()
        };
        let facts = report_view(&state, 1, Some((true, true, false)), report(true, true), None);
        assert_eq!(facts, NativeFocusFacts { visible: true, focused: true, minimized: false, effective_focused: true });
        // The page says it is not focused: the window's own focus stands, the effective one does not.
        let facts = report_view(&state, 1, Some((true, true, false)), report(true, false), None);
        assert_eq!((facts.focused, facts.effective_focused), (true, false));
        // Miniaturized or hidden is never visible, whatever the page says.
        let facts = report_view(&state, 1, Some((true, true, true)), report(true, true), None);
        assert_eq!((facts.visible, facts.focused, facts.minimized, facts.effective_focused), (false, false, true, false));
        let facts = report_view(&state, 1, None, NotificationViewReport::default(), None);
        assert_eq!(facts, NativeFocusFacts { visible: false, focused: false, minimized: false, effective_focused: false });
        // No report on `visible` counts as visible.
        let facts = report_view(&state, 1, Some((true, false, false)), NotificationViewReport::default(), None);
        assert!(facts.visible);
    }

    #[test]
    fn each_window_reports_presence_as_its_own_instance() {
        let (endpoint, seen) = serve(|_, _| (204, String::new()));
        let (_, state) = state_with(MockAdapter::default());
        for window in [1, 2] {
            report_view(&state, window, Some((true, true, false)), NotificationViewReport::default(), Some(endpoint.clone()));
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while seen.lock().unwrap().len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut ids: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(_, _, body)| serde_json::from_str::<serde_json::Value>(body).unwrap()["instance_id"].as_str().unwrap().to_owned())
            .collect();
        ids.sort();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
        assert!(ids[0].ends_with("-w1") && ids[1].ends_with("-w2"));
    }

    fn json_answer<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn a_cycle_sets_the_badge_reconciles_claims_posts_and_reports() {
        let (endpoint, seen) = serve(|request, _| match request {
            "GET /v1/notifications/desktop/state" => (200, r#"{"attention_count":120,"cleanup_revision":7}"#.into()),
            "GET /v1/notification-device" => (200, r#"{"enabled":true,"badge":true,"sound":"default","preview":"generic"}"#.into()),
            "POST /v1/notifications/desktop/reconcile" => (200, r#"{"remove_identifiers":["stale"]}"#.into()),
            "POST /v1/notifications/desktop/claim" => (
                200,
                json_answer(&DesktopClaimResponse {
                    delivery_id: "d1".into(),
                    claim_token: "t1".into(),
                    lease_expires_at: 0,
                    click_ref: "ref-1".into(),
                    title: "Claimed".into(),
                    body: "Claimed body".into(),
                    sound: Some("default".into()),
                    identifier: "id-1".into(),
                }),
            ),
            "POST /v1/notifications/desktop/revalidate" => (
                200,
                json_answer(&DesktopRevalidateResponse {
                    action: "deliver".into(),
                    permit: None,
                    title: Some("Fresh".into()),
                    body: None,
                    sound: None,
                    retry_after_ms: None,
                }),
            ),
            "POST /v1/notifications/desktop/report" => (200, "{}".into()),
            _ => (404, "{}".into()),
        });
        let (adapter, state) = state_with(MockAdapter {
            operational: true,
            permission: Mutex::new("granted".into()),
            delivered: Mutex::new(vec!["stale".into(), "live".into()]),
            ..Default::default()
        });
        poll_cycle(&state, &endpoint);

        assert_eq!(*adapter.dock_badge.lock().unwrap(), Some("99+".to_string()));
        assert_eq!(state.last_attention_count.load(Ordering::SeqCst), 120);
        assert_eq!(*adapter.removed.lock().unwrap(), vec!["stale".to_string()]);
        assert_eq!(state.last_cleanup_revision.load(Ordering::SeqCst), 7);
        // The revalidated title wins, the claim's body fills the gap.
        assert_eq!(
            *adapter.posted.lock().unwrap(),
            vec![("id-1".into(), "Fresh".into(), "Claimed body".into(), "default".into(), "ref-1".into())]
        );
        let seen = seen.lock().unwrap();
        let claim = seen.iter().find(|(r, _, _)| r.ends_with("/claim")).unwrap();
        let claim: serde_json::Value = serde_json::from_str(&claim.2).unwrap();
        assert_eq!(claim["owner_id"], state.owner_id.as_str());
        assert_eq!(claim["permission"], "granted");
        let report = seen.iter().find(|(r, _, _)| r.ends_with("/report")).unwrap();
        let report: serde_json::Value = serde_json::from_str(&report.2).unwrap();
        assert_eq!((report["result"].as_str(), report.get("code")), (Some("accepted"), None));
    }

    /// Runs one cycle against a runtime that answers every claim with `action`; returns the report.
    fn report_for(action: &'static str, operational: bool) -> (Arc<MockAdapter>, Vec<serde_json::Value>) {
        let (endpoint, seen) = serve(move |request, _| match request {
            "GET /v1/notifications/desktop/state" => (200, r#"{"attention_count":0,"cleanup_revision":0}"#.into()),
            "POST /v1/notifications/desktop/claim" => (
                200,
                json_answer(&DesktopClaimResponse {
                    delivery_id: "d".into(),
                    claim_token: "t".into(),
                    lease_expires_at: 0,
                    click_ref: "r".into(),
                    title: "T".into(),
                    body: "B".into(),
                    sound: None,
                    identifier: "i".into(),
                }),
            ),
            "POST /v1/notifications/desktop/revalidate" => (
                200,
                json_answer(&DesktopRevalidateResponse {
                    action: action.into(),
                    permit: None,
                    title: None,
                    body: None,
                    sound: None,
                    retry_after_ms: None,
                }),
            ),
            "POST /v1/notifications/desktop/report" => (200, "{}".into()),
            _ => (404, "{}".into()),
        });
        let (adapter, state) =
            state_with(MockAdapter { operational, permission: Mutex::new("granted".into()), ..Default::default() });
        poll_cycle(&state, &endpoint);
        let reports = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(r, _, _)| r.ends_with("/report"))
            .map(|(_, _, body)| serde_json::from_str(body).unwrap())
            .collect();
        (adapter, reports)
    }

    #[test]
    fn claim_actions_are_reported_the_way_the_tauri_shell_does() {
        let (adapter, reports) = report_for("deliver", false);
        assert!(adapter.posted.lock().unwrap().is_empty());
        assert_eq!((reports[0]["result"].as_str(), reports[0]["code"].as_str()), (Some("failed"), Some("delivery_gated")));

        let (_, reports) = report_for("cancel", true);
        assert_eq!((reports[0]["result"].as_str(), reports[0]["code"].as_str()), (Some("failed"), Some("cancelled")));

        let (adapter, reports) = report_for("retry_later", true);
        assert!(reports.is_empty() && adapter.posted.lock().unwrap().is_empty());

        let (_, reports) = report_for("surprise", true);
        assert_eq!((reports[0]["result"].as_str(), reports[0]["code"].as_str()), (Some("unknown"), Some("unknown_action")));

        let (adapter, reports) = report_for("deliver", true);
        assert_eq!(adapter.posted.lock().unwrap().len(), 1);
        assert_eq!(reports[0]["result"], "accepted");
    }

    #[test]
    fn reconciliation_goes_in_chunks_of_a_hundred_and_stays_pending_when_one_fails() {
        let (endpoint, seen) = serve(|request, body| match request {
            "GET /v1/notifications/desktop/state" => (200, r#"{"attention_count":0,"cleanup_revision":9}"#.into()),
            "GET /v1/notification-device" => (200, r#"{"enabled":true,"badge":true}"#.into()),
            "POST /v1/notifications/desktop/reconcile" => {
                let request: DesktopReconcileRequest = serde_json::from_str(body).unwrap();
                // The second chunk fails.
                if request.identifiers[0] == "id-100" {
                    (500, "{}".into())
                } else {
                    (200, r#"{"remove_identifiers":[]}"#.into())
                }
            }
            _ => (204, String::new()),
        });
        let (_, state) = state_with(MockAdapter {
            permission: Mutex::new("default".into()),
            delivered: Mutex::new((0..250).map(|i| format!("id-{i}")).collect()),
            ..Default::default()
        });
        poll_cycle(&state, &endpoint);
        assert_eq!(state.last_cleanup_revision.load(Ordering::SeqCst), 0, "a failed chunk keeps the revision pending");
        let sizes: Vec<usize> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(r, _, _)| r.ends_with("/reconcile"))
            .map(|(_, _, body)| serde_json::from_str::<DesktopReconcileRequest>(body).unwrap().identifiers.len())
            .collect();
        assert_eq!(sizes, vec![100, 100]);
    }
}
