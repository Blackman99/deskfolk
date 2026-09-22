use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationIntent {
    pub click_ref: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermissionStateDto {
    pub permission: String,
    pub native_reading_v1: bool,
    pub native_delivery_v1: bool,
    pub operational: bool,
    pub gated_reason: Option<String>,
    pub attention_count: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NotificationViewReport {
    pub session_id: Option<String>,
    pub at_latest: Option<bool>,
    pub visible: Option<bool>,
    pub focused: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFocusFacts {
    pub visible: bool,
    pub focused: bool,
    pub minimized: bool,
    pub effective_focused: bool,
}

#[derive(Serialize, Debug)]
pub struct DesktopClaimRequest<'a> {
    pub owner_id: &'a str,
    pub permission: &'a str,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DesktopClaimResponse {
    pub delivery_id: String,
    pub claim_token: String,
    #[serde(default)]
    pub lease_expires_at: u64,
    pub click_ref: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub sound: Option<String>,
    pub identifier: String,
}

#[derive(Serialize, Debug)]
pub struct DesktopRevalidateRequest<'a> {
    pub delivery_id: &'a str,
    pub claim_token: &'a str,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DesktopRevalidateResponse {
    pub action: String,
    #[serde(default)]
    pub permit: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub sound: Option<String>,
    #[serde(default)]
    pub retry_after_ms: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct DesktopReportRequest<'a> {
    pub delivery_id: &'a str,
    pub claim_token: &'a str,
    pub result: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'a str>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct DesktopStateResponse {
    #[serde(default)]
    pub attention_count: u32,
    #[serde(default)]
    pub cleanup_revision: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DesktopReconcileRequest {
    pub identifiers: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct DesktopReconcileResponse {
    #[serde(default)]
    pub remove_identifiers: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct NotificationPresenceRequest<'a> {
    pub instance_id: &'a str,
    pub visible: bool,
    pub focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<&'a str>,
    pub at_latest: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NotificationDeviceResponse {
    pub enabled: bool,
    pub badge: bool,
    #[serde(default)]
    pub sound: String,
    #[serde(default)]
    pub preview: String,
}

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
    fn set_dock_badge(&self, label: Option<&str>) -> Result<(), String>;
    fn setup_delegate(&self, on_click: Box<dyn Fn(&str) + Send + Sync + 'static>);
}

#[allow(dead_code)]
pub struct FallbackNotificationAdapter;

impl NotificationAdapter for FallbackNotificationAdapter {
    fn is_operational(&self) -> bool {
        false
    }
    fn gated_reason(&self) -> Option<String> {
        Some("installed_app_coldclick_required".to_string())
    }
    fn get_permission_state(&self) -> Result<String, String> {
        Ok("default".to_string())
    }
    fn request_permission(&self) -> Result<String, String> {
        Err("delivery_gated: installed_app_coldclick_required".to_string())
    }
    fn post_notification(
        &self,
        _identifier: &str,
        _title: &str,
        _body: &str,
        _sound: &str,
        _click_ref: &str,
    ) -> Result<(), String> {
        Err("delivery_gated: installed_app_coldclick_required".to_string())
    }
    fn get_delivered_identifiers(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn remove_delivered_notifications(&self, _identifiers: &[String]) -> Result<(), String> {
        Ok(())
    }
    fn set_dock_badge(&self, _label: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    fn setup_delegate(&self, _on_click: Box<dyn Fn(&str) + Send + Sync + 'static>) {}
}

fn generate_random_128_hex() -> String {
    let mut buf = [0u8; 16];
    let res = unsafe { libc::getentropy(buf.as_mut_ptr().cast(), 16) };
    if res == 0 {
        buf.iter().map(|b| format!("{b:02x}")).collect()
    } else {
        format!(
            "{:032x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        )
    }
}

pub struct NotificationState {
    pub owner_id: String,
    pub instance_id: String,
    pub intent_buffer: Arc<Mutex<Option<NotificationIntent>>>,
    pub last_cleanup_revision: AtomicU64,
    pub last_attention_count: AtomicU32,
    pub current_badge_label: Mutex<Option<String>>,
    pub quitting: AtomicBool,
    pub adapter: Arc<dyn NotificationAdapter>,
}

impl NotificationState {
    pub fn new() -> Self {
        #[cfg(target_os = "macos")]
        let adapter: Arc<dyn NotificationAdapter> =
            Arc::new(crate::notifications_macos::MacOsNotificationAdapter::new());
        #[cfg(not(target_os = "macos"))]
        let adapter: Arc<dyn NotificationAdapter> = Arc::new(FallbackNotificationAdapter);

        Self {
            owner_id: generate_random_128_hex(),
            instance_id: generate_random_128_hex(),
            intent_buffer: Arc::new(Mutex::new(None)),
            last_cleanup_revision: AtomicU64::new(0),
            last_attention_count: AtomicU32::new(0),
            current_badge_label: Mutex::new(None),
            quitting: AtomicBool::new(false),
            adapter,
        }
    }

    #[cfg(test)]
    pub fn with_adapter(adapter: Arc<dyn NotificationAdapter>) -> Self {
        Self {
            owner_id: "test-owner-128bit-hex".to_string(),
            instance_id: "test-instance-id".to_string(),
            intent_buffer: Arc::new(Mutex::new(None)),
            last_cleanup_revision: AtomicU64::new(0),
            last_attention_count: AtomicU32::new(0),
            current_badge_label: Mutex::new(None),
            quitting: AtomicBool::new(false),
            adapter,
        }
    }

    pub fn stop(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }
}

pub struct TrustedNotificationCaller;

fn authorize_notification_document(
    label: &str,
    url: &tauri::Url,
    development: bool,
    local_acl: bool,
) -> Result<(), String> {
    if !local_acl || label != "main" {
        return Err("forbidden_caller".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("forbidden_origin".into());
    }

    if development {
        let is_dev_server = (url.scheme() == "http" || url.scheme() == "https")
            && (url.host_str() == Some("localhost")
                || url.host_str() == Some("127.0.0.1")
                || url.host_str() == Some("[::1]")
                || url.host_str() == Some("::1"))
            && (url.port() == Some(5173) || url.port() == Some(17890));
        let is_bundled = url.scheme() == "tauri" && url.host_str() == Some("localhost");
        if !is_dev_server && !is_bundled {
            return Err("forbidden_origin".into());
        }
    } else {
        let is_bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
        if !is_bundled {
            return Err("forbidden_origin".into());
        }
    }

    let path = url.path();
    if !matches!(path, "" | "/" | "/index.html") {
        return Err("forbidden_origin".into());
    }
    Ok(())
}

impl TrustedNotificationCaller {
    pub(crate) fn from_item<R: tauri::Runtime>(
        command: tauri::ipc::CommandItem<'_, R>,
        development: bool,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let webview = command.message.webview_ref();
        let local_acl = command.acl.as_ref().is_some_and(|acl| {
            acl.iter()
                .any(|entry| matches!(entry.context, tauri::utils::acl::ExecutionContext::Local))
        });
        authorize_notification_document(webview.label(), &webview.url()?, development, local_acl)?;
        Ok(Self)
    }
}

impl<'a, R: tauri::Runtime> tauri::ipc::CommandArg<'a, R> for TrustedNotificationCaller {
    fn from_command(
        command: tauri::ipc::CommandItem<'a, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        Self::from_item(command, cfg!(debug_assertions) || tauri::is_dev())
    }
}

pub fn on_notification_click(
    click_ref: &str,
    app: &AppHandle,
    intent_buffer: &Mutex<Option<NotificationIntent>>,
) {
    if let Ok(mut guard) = intent_buffer.lock() {
        *guard = Some(NotificationIntent {
            click_ref: click_ref.to_string(),
        });
    }
    crate::show_main(app);
}

pub fn poll_state(endpoint: &crate::LocalApiEndpoint) -> Result<DesktopStateResponse, String> {
    let url = format!("{}/v1/notifications/desktop/state", endpoint.origin);
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("state_poll_failed: {e}"))?;

    resp.into_json::<DesktopStateResponse>()
        .map_err(|e| format!("state_parse_failed: {e}"))
}

pub fn poll_device_preference(
    endpoint: &crate::LocalApiEndpoint,
) -> Result<NotificationDeviceResponse, String> {
    let url = format!("{}/v1/notification-device", endpoint.origin);
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(3))
        .call();

    match resp {
        Ok(r) => r
            .into_json::<NotificationDeviceResponse>()
            .map_err(|e| format!("device_parse_failed: {e}")),
        Err(ureq::Error::Status(409, _)) => Ok(NotificationDeviceResponse {
            enabled: true,
            badge: true,
            sound: "default".to_string(),
            preview: "generic".to_string(),
        }),
        Err(e) => Err(format!("device_poll_failed: {e}")),
    }
}

pub fn claim_notifications(
    endpoint: &crate::LocalApiEndpoint,
    owner_id: &str,
    permission: &str,
) -> Result<Option<DesktopClaimResponse>, String> {
    let url = format!("{}/v1/notifications/desktop/claim", endpoint.origin);
    let req_body = DesktopClaimRequest {
        owner_id,
        permission,
    };
    let resp = match ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_json(&req_body)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(204, _)) => return Ok(None),
        Err(e) => return Err(format!("claim_failed: {e}")),
    };

    if resp.status() == 204 {
        return Ok(None);
    }

    let claim = resp
        .into_json::<DesktopClaimResponse>()
        .map_err(|e| format!("claim_parse_failed: {e}"))?;
    Ok(Some(claim))
}

pub fn revalidate_claim(
    endpoint: &crate::LocalApiEndpoint,
    delivery_id: &str,
    claim_token: &str,
) -> Result<DesktopRevalidateResponse, String> {
    let url = format!("{}/v1/notifications/desktop/revalidate", endpoint.origin);
    let req_body = DesktopRevalidateRequest {
        delivery_id,
        claim_token,
    };
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .send_json(&req_body)
        .map_err(|e| format!("revalidate_failed: {e}"))?;

    resp.into_json::<DesktopRevalidateResponse>()
        .map_err(|e| format!("revalidate_parse_failed: {e}"))
}

pub fn report_delivery(
    endpoint: &crate::LocalApiEndpoint,
    delivery_id: &str,
    claim_token: &str,
    result: &str,
    code: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/v1/notifications/desktop/report", endpoint.origin);
    let req_body = DesktopReportRequest {
        delivery_id,
        claim_token,
        result,
        code,
    };
    let _ = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .send_json(&req_body)
        .map_err(|e| format!("report_failed: {e}"))?;

    Ok(())
}

pub fn reconcile_notifications(
    endpoint: &crate::LocalApiEndpoint,
    identifiers: &[String],
) -> Result<DesktopReconcileResponse, String> {
    let url = format!("{}/v1/notifications/desktop/reconcile", endpoint.origin);
    let req_body = DesktopReconcileRequest {
        identifiers: identifiers.to_vec(),
    };
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .send_json(&req_body)
        .map_err(|e| format!("reconcile_failed: {e}"))?;

    resp.into_json::<DesktopReconcileResponse>()
        .map_err(|e| format!("reconcile_parse_failed: {e}"))
}

pub fn post_presence(
    endpoint: &crate::LocalApiEndpoint,
    req: &NotificationPresenceRequest,
) -> Result<(), String> {
    let url = format!("{}/v1/notification-presence", endpoint.origin);
    let _ = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(3))
        .send_json(req)
        .map_err(|e| format!("presence_failed: {e}"))?;

    Ok(())
}

pub fn poll_daemon_cycle(
    adapter: &dyn NotificationAdapter,
    state: &NotificationState,
    endpoint: &crate::LocalApiEndpoint,
    app: &AppHandle,
) {
    if let Ok(state_resp) = poll_state(endpoint) {
        let count = state_resp.attention_count;
        state.last_attention_count.store(count, Ordering::SeqCst);

        let dev_pref = poll_device_preference(endpoint).unwrap_or(NotificationDeviceResponse {
            enabled: true,
            badge: true,
            sound: "default".to_string(),
            preview: "generic".to_string(),
        });

        let badge_active = dev_pref.enabled && dev_pref.badge;
        let desired_badge = if badge_active && count > 0 {
            if count > 99 {
                Some("99+".to_string())
            } else {
                Some(count.to_string())
            }
        } else {
            None
        };

        if let Ok(mut current_guard) = state.current_badge_label.lock() {
            if *current_guard != desired_badge {
                *current_guard = desired_badge.clone();
                let adapter = state.adapter.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = adapter.set_dock_badge(desired_badge.as_deref());
                });
            }
        }

        let last_rev = state.last_cleanup_revision.load(Ordering::SeqCst);
        if state_resp.cleanup_revision != last_rev {
            if let Ok(identifiers) = adapter.get_delivered_identifiers() {
                let mut all_succeeded = true;
                for chunk in identifiers.chunks(100) {
                    match reconcile_notifications(endpoint, chunk) {
                        Ok(reconcile_resp) => {
                            if !reconcile_resp.remove_identifiers.is_empty() {
                                let _ = adapter.remove_delivered_notifications(
                                    &reconcile_resp.remove_identifiers,
                                );
                            }
                        }
                        Err(_) => {
                            all_succeeded = false;
                            break;
                        }
                    }
                }
                if all_succeeded {
                    state
                        .last_cleanup_revision
                        .store(state_resp.cleanup_revision, Ordering::SeqCst);
                }
            }
        }
    }

    let perm = adapter
        .get_permission_state()
        .unwrap_or_else(|_| "default".to_string());
    if let Ok(Some(claim)) = claim_notifications(endpoint, &state.owner_id, &perm) {
        let delivery_id = &claim.delivery_id;
        let claim_token = &claim.claim_token;

        match revalidate_claim(endpoint, delivery_id, claim_token) {
            Ok(reval) => match reval.action.as_str() {
                "deliver" => {
                    let title = reval.title.as_deref().unwrap_or(&claim.title);
                    let body = reval.body.as_deref().unwrap_or(&claim.body);
                    let sound = reval
                        .sound
                        .as_deref()
                        .or(claim.sound.as_deref())
                        .unwrap_or("default");

                    if adapter.is_operational() {
                        match adapter.post_notification(
                            &claim.identifier,
                            title,
                            body,
                            sound,
                            &claim.click_ref,
                        ) {
                            Ok(_) => {
                                let _ = report_delivery(
                                    endpoint,
                                    delivery_id,
                                    claim_token,
                                    "accepted",
                                    None,
                                );
                            }
                            Err(e) => {
                                let result = if e == "os_timeout" {
                                    "unknown"
                                } else {
                                    "failed"
                                };
                                let _ = report_delivery(
                                    endpoint,
                                    delivery_id,
                                    claim_token,
                                    result,
                                    Some(&e),
                                );
                            }
                        }
                    } else {
                        let _ = report_delivery(
                            endpoint,
                            delivery_id,
                            claim_token,
                            "failed",
                            Some("delivery_gated"),
                        );
                    }
                }
                "cancel" => {
                    let _ = report_delivery(
                        endpoint,
                        delivery_id,
                        claim_token,
                        "failed",
                        Some("cancelled"),
                    );
                }
                "retry_later" => {}
                _ => {
                    let _ = report_delivery(
                        endpoint,
                        delivery_id,
                        claim_token,
                        "unknown",
                        Some("unknown_action"),
                    );
                }
            },
            Err(e) => {
                let _ = report_delivery(endpoint, delivery_id, claim_token, "unknown", Some(&e));
            }
        }
    }
}

pub fn setup_notifications(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<NotificationState>();
    let app_clone = app.clone();
    let intent_buf = state.intent_buffer.clone();

    state.adapter.setup_delegate(Box::new(move |click_ref| {
        on_notification_click(click_ref, &app_clone, &intent_buf);
    }));

    let handle = app.clone();
    std::thread::spawn(move || {
        while !handle
            .state::<NotificationState>()
            .quitting
            .load(Ordering::SeqCst)
        {
            std::thread::sleep(Duration::from_secs(2));
            if handle
                .state::<NotificationState>()
                .quitting
                .load(Ordering::SeqCst)
            {
                break;
            }

            let endpoint = handle
                .state::<Mutex<crate::AppState>>()
                .lock()
                .ok()
                .and_then(|guard| crate::read_endpoint(&guard));

            if let Some(ep) = endpoint {
                let state = handle.state::<NotificationState>();
                poll_daemon_cycle(&*state.adapter, &state, &ep, &handle);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn notification_permission_state(
    _caller: TrustedNotificationCaller,
    state: tauri::State<'_, NotificationState>,
) -> Result<NotificationPermissionStateDto, String> {
    let permission = state
        .adapter
        .get_permission_state()
        .unwrap_or_else(|_| "default".to_string());
    let operational = state.adapter.is_operational();
    let gated_reason = state.adapter.gated_reason();
    let attention_count = state.last_attention_count.load(Ordering::SeqCst);

    Ok(NotificationPermissionStateDto {
        permission,
        native_reading_v1: true,
        native_delivery_v1: operational,
        operational,
        gated_reason,
        attention_count,
    })
}

#[tauri::command]
pub fn request_notification_permission(
    _caller: TrustedNotificationCaller,
    state: tauri::State<'_, NotificationState>,
) -> Result<NotificationPermissionStateDto, String> {
    let permission = match state.adapter.request_permission() {
        Ok(p) => p,
        Err(e) => {
            if state.adapter.is_operational() {
                return Err(e);
            }
            state
                .adapter
                .get_permission_state()
                .unwrap_or_else(|_| "default".to_string())
        }
    };
    let operational = state.adapter.is_operational();
    let gated_reason = state.adapter.gated_reason();
    let attention_count = state.last_attention_count.load(Ordering::SeqCst);

    Ok(NotificationPermissionStateDto {
        permission,
        native_reading_v1: true,
        native_delivery_v1: operational,
        operational,
        gated_reason,
        attention_count,
    })
}

#[tauri::command]
pub fn take_notification_intent(
    _caller: TrustedNotificationCaller,
    state: tauri::State<'_, NotificationState>,
) -> Result<Option<NotificationIntent>, String> {
    let mut guard = state
        .intent_buffer
        .lock()
        .map_err(|_| "intent_buffer_poisoned".to_string())?;
    Ok(guard.take())
}

#[tauri::command]
pub fn report_notification_view(
    _caller: TrustedNotificationCaller,
    app: AppHandle,
    state: tauri::State<'_, NotificationState>,
    report: NotificationViewReport,
) -> Result<NativeFocusFacts, String> {
    let (is_visible, is_focused, is_minimized) = match app.get_webview_window("main") {
        Some(window) => (
            window.is_visible().unwrap_or(false),
            window.is_focused().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
        ),
        None => (false, false, false),
    };

    let rust_focused = is_visible && is_focused && !is_minimized;
    let effective_focused = rust_focused && report.focused.unwrap_or(false);
    let effective_visible = is_visible && !is_minimized && report.visible.unwrap_or(true);

    let endpoint = app
        .state::<Mutex<crate::AppState>>()
        .lock()
        .ok()
        .and_then(|guard| crate::read_endpoint(&guard));

    if let Some(ep) = endpoint {
        let presence_req = NotificationPresenceRequest {
            instance_id: &state.instance_id,
            visible: effective_visible,
            focused: effective_focused,
            session_id: report.session_id.as_deref(),
            at_latest: report.at_latest.unwrap_or(false),
        };
        let _ = post_presence(&ep, &presence_req);
    }

    Ok(NativeFocusFacts {
        visible: effective_visible,
        focused: rust_focused,
        minimized: is_minimized,
        effective_focused,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    #[derive(Default)]
    struct MockNotificationAdapter {
        pub operational: bool,
        pub permission: Mutex<String>,
        pub delivered: Mutex<Vec<String>>,
        pub posted: Mutex<Vec<(String, String, String, String, String)>>,
        pub removed: Mutex<Vec<String>>,
        pub dock_badge: Mutex<Option<String>>,
    }

    impl NotificationAdapter for MockNotificationAdapter {
        fn is_operational(&self) -> bool {
            self.operational
        }
        fn gated_reason(&self) -> Option<String> {
            if self.operational {
                None
            } else {
                Some("installed_app_coldclick_required".to_string())
            }
        }
        fn get_permission_state(&self) -> Result<String, String> {
            Ok(self.permission.lock().unwrap().clone())
        }
        fn request_permission(&self) -> Result<String, String> {
            if !self.operational {
                return Err("delivery_gated: installed_app_coldclick_required".to_string());
            }
            *self.permission.lock().unwrap() = "granted".to_string();
            Ok("granted".to_string())
        }
        fn post_notification(
            &self,
            identifier: &str,
            title: &str,
            body: &str,
            sound: &str,
            click_ref: &str,
        ) -> Result<(), String> {
            if !self.operational {
                return Err("delivery_gated: installed_app_coldclick_required".to_string());
            }
            self.posted.lock().unwrap().push((
                identifier.to_string(),
                title.to_string(),
                body.to_string(),
                sound.to_string(),
                click_ref.to_string(),
            ));
            Ok(())
        }
        fn get_delivered_identifiers(&self) -> Result<Vec<String>, String> {
            Ok(self.delivered.lock().unwrap().clone())
        }
        fn remove_delivered_notifications(&self, identifiers: &[String]) -> Result<(), String> {
            self.removed
                .lock()
                .unwrap()
                .extend(identifiers.iter().cloned());
            self.delivered
                .lock()
                .unwrap()
                .retain(|id| !identifiers.contains(id));
            Ok(())
        }
        fn set_dock_badge(&self, label: Option<&str>) -> Result<(), String> {
            *self.dock_badge.lock().unwrap() = label.map(str::to_string);
            Ok(())
        }
        fn setup_delegate(&self, _on_click: Box<dyn Fn(&str) + Send + Sync + 'static>) {}
    }

    #[test]
    fn test_authorize_notification_document_dev() {
        let dev_url = tauri::Url::parse("http://localhost:5173/").unwrap();
        assert!(authorize_notification_document("main", &dev_url, true, true).is_ok());

        let dev_127_url = tauri::Url::parse("http://127.0.0.1:5173/index.html").unwrap();
        assert!(authorize_notification_document("main", &dev_127_url, true, true).is_ok());

        let dev_ipv6_bracket = tauri::Url::parse("http://[::1]:5173/").unwrap();
        assert!(authorize_notification_document("main", &dev_ipv6_bracket, true, true).is_ok());

        let wrong_port = tauri::Url::parse("http://localhost:3000/").unwrap();
        assert!(authorize_notification_document("main", &wrong_port, true, true).is_err());

        let non_local = tauri::Url::parse("http://localhost:5173/").unwrap();
        assert!(authorize_notification_document("main", &non_local, true, false).is_err());

        let wrong_window = tauri::Url::parse("http://localhost:5173/").unwrap();
        assert!(authorize_notification_document("settings", &wrong_window, true, true).is_err());

        let remote_host = tauri::Url::parse("https://evil.com/").unwrap();
        assert!(authorize_notification_document("main", &remote_host, true, true).is_err());

        let userinfo = tauri::Url::parse("http://user:pass@localhost:5173/").unwrap();
        assert!(authorize_notification_document("main", &userinfo, true, true).is_err());

        let subpath = tauri::Url::parse("http://localhost:5173/some/nested/path").unwrap();
        assert!(authorize_notification_document("main", &subpath, true, true).is_err());
    }

    #[test]
    fn test_authorize_notification_document_bundled() {
        let tauri_url = tauri::Url::parse("tauri://localhost/index.html").unwrap();
        assert!(authorize_notification_document("main", &tauri_url, false, true).is_ok());

        let dev_in_prod = tauri::Url::parse("http://localhost:5173/").unwrap();
        assert!(authorize_notification_document("main", &dev_in_prod, false, true).is_err());

        let remote = tauri::Url::parse("https://example.com/").unwrap();
        assert!(authorize_notification_document("main", &remote, false, true).is_err());

        let invalid_path = tauri::Url::parse("tauri://localhost/unauthorized").unwrap();
        assert!(authorize_notification_document("main", &invalid_path, false, true).is_err());
    }

    #[test]
    fn test_intent_buffer_warm_and_cold() {
        let buf = Arc::new(Mutex::new(None));
        assert_eq!(*buf.lock().unwrap(), None);

        buf.lock().unwrap().replace(NotificationIntent {
            click_ref: "click-1".to_string(),
        });
        assert_eq!(
            *buf.lock().unwrap(),
            Some(NotificationIntent {
                click_ref: "click-1".to_string()
            })
        );

        let taken = buf.lock().unwrap().take();
        assert_eq!(
            taken,
            Some(NotificationIntent {
                click_ref: "click-1".to_string()
            })
        );
        assert_eq!(*buf.lock().unwrap(), None);

        let taken_again = buf.lock().unwrap().take();
        assert_eq!(taken_again, None);
    }

    #[test]
    fn test_permission_state_dto_fail_closed_in_dev_or_unbundled() {
        let mock = Arc::new(MockNotificationAdapter {
            operational: false,
            permission: Mutex::new("default".to_string()),
            ..Default::default()
        });

        let state = NotificationState::with_adapter(mock);
        let dto = NotificationPermissionStateDto {
            permission: state.adapter.get_permission_state().unwrap(),
            native_reading_v1: true,
            native_delivery_v1: state.adapter.is_operational(),
            operational: state.adapter.is_operational(),
            gated_reason: state.adapter.gated_reason(),
            attention_count: state.last_attention_count.load(Ordering::SeqCst),
        };

        assert_eq!(dto.permission, "default");
        assert!(dto.native_reading_v1);
        assert!(!dto.native_delivery_v1);
        assert!(!dto.operational);
        assert_eq!(
            dto.gated_reason,
            Some("installed_app_coldclick_required".to_string())
        );
    }

    #[test]
    fn test_permission_state_dto_operational_when_verified() {
        let mock = Arc::new(MockNotificationAdapter {
            operational: true,
            permission: Mutex::new("granted".to_string()),
            ..Default::default()
        });

        let state = NotificationState::with_adapter(mock);
        let dto = NotificationPermissionStateDto {
            permission: state.adapter.get_permission_state().unwrap(),
            native_reading_v1: true,
            native_delivery_v1: state.adapter.is_operational(),
            operational: state.adapter.is_operational(),
            gated_reason: state.adapter.gated_reason(),
            attention_count: state.last_attention_count.load(Ordering::SeqCst),
        };

        assert_eq!(dto.permission, "granted");
        assert!(dto.native_reading_v1);
        assert!(dto.native_delivery_v1);
        assert!(dto.operational);
        assert_eq!(dto.gated_reason, None);
    }

    #[test]
    fn test_poller_daemon_http_flow() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }

                let mut content_length = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line == "\r\n" || line == "\n" {
                        break;
                    }
                    if line.to_lowercase().starts_with("content-length:") {
                        if let Some(val) = line.split(':').nth(1) {
                            content_length = val.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                }

                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }

                if request_line.starts_with("GET /v1/notifications/desktop/state") {
                    let b = "{\"attention_count\":3,\"cleanup_revision\":42}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        b.len(),
                        b
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("GET /v1/notification-device") {
                    let b = "{\"receiver_id\":\"desktop\",\"revision\":1,\"enabled\":true,\"badge\":true,\"sound\":\"default\",\"preview\":\"generic\"}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        b.len(),
                        b
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("POST /v1/notifications/desktop/reconcile") {
                    let b = "{\"remove_identifiers\":[\"stale-1\"]}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        b.len(),
                        b
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("POST /v1/notifications/desktop/claim") {
                    let resp_body = serde_json::to_string(&DesktopClaimResponse {
                        delivery_id: "deliv-1".to_string(),
                        claim_token: "token-1".to_string(),
                        lease_expires_at: 10000,
                        click_ref: "click-ref-1".to_string(),
                        title: "Test Claim Title".to_string(),
                        body: "Test Claim Body".to_string(),
                        sound: Some("default".to_string()),
                        identifier: "notif-1".to_string(),
                    })
                    .unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        resp_body.len(),
                        resp_body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("POST /v1/notifications/desktop/revalidate") {
                    let resp_body = serde_json::to_string(&DesktopRevalidateResponse {
                        action: "deliver".to_string(),
                        permit: Some("permit-1".to_string()),
                        title: Some("Revalidated Title".to_string()),
                        body: Some("Revalidated Body".to_string()),
                        sound: Some("default".to_string()),
                        retry_after_ms: None,
                    })
                    .unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        resp_body.len(),
                        resp_body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("POST /v1/notifications/desktop/report") {
                    let b = "{\"ok\":true}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        b.len(),
                        b
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("POST /v1/notification-presence") {
                    let resp = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(resp.as_bytes());
                } else {
                    let resp =
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(resp.as_bytes());
                }
            }
        });

        let endpoint = crate::LocalApiEndpoint {
            origin: format!("http://127.0.0.1:{port}"),
            token: "test-token".to_string(),
        };

        let state_resp = poll_state(&endpoint).expect("poll_state");
        assert_eq!(state_resp.attention_count, 3);
        assert_eq!(state_resp.cleanup_revision, 42);

        let dev_resp = poll_device_preference(&endpoint).expect("poll_device_preference");
        assert!(dev_resp.enabled);
        assert!(dev_resp.badge);

        let claim = claim_notifications(&endpoint, "owner-1", "granted")
            .expect("claim")
            .expect("some claim");
        assert_eq!(claim.delivery_id, "deliv-1");
        assert_eq!(claim.title, "Test Claim Title");

        let reval = revalidate_claim(&endpoint, &claim.delivery_id, &claim.claim_token)
            .expect("revalidate");
        assert_eq!(reval.action, "deliver");
        assert_eq!(reval.permit, Some("permit-1".to_string()));
        assert_eq!(reval.title, Some("Revalidated Title".to_string()));

        let report = report_delivery(
            &endpoint,
            &claim.delivery_id,
            &claim.claim_token,
            "accepted",
            None,
        );
        assert!(report.is_ok());

        let reconcile =
            reconcile_notifications(&endpoint, &["stale-1".to_string()]).expect("reconcile");
        assert_eq!(reconcile.remove_identifiers, vec!["stale-1".to_string()]);

        let presence = post_presence(
            &endpoint,
            &NotificationPresenceRequest {
                instance_id: "inst-1",
                visible: true,
                focused: true,
                session_id: Some("sess-1"),
                at_latest: true,
            },
        );
        assert!(presence.is_ok());
    }

    #[test]
    fn test_poller_daemon_claim_actions_and_gated_reporting() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind port");
        let port = listener.local_addr().unwrap().port();

        let report_log = Arc::new(Mutex::new(Vec::new()));
        let report_log_clone = report_log.clone();

        std::thread::spawn(move || {
            let mut claim_idx = 0;
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }

                let mut content_length = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line == "\r\n" || line == "\n" {
                        break;
                    }
                    if line.to_lowercase().starts_with("content-length:") {
                        if let Some(val) = line.split(':').nth(1) {
                            content_length = val.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                }

                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }

                if request_line.starts_with("POST /v1/notifications/desktop/claim") {
                    claim_idx += 1;
                    let resp_body = serde_json::to_string(&DesktopClaimResponse {
                        delivery_id: format!("deliv-{claim_idx}"),
                        claim_token: format!("tok-{claim_idx}"),
                        lease_expires_at: 10000,
                        click_ref: format!("ref-{claim_idx}"),
                        title: format!("Title {claim_idx}"),
                        body: format!("Body {claim_idx}"),
                        sound: Some("default".to_string()),
                        identifier: format!("id-{claim_idx}"),
                    })
                    .unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        resp_body.len(),
                        resp_body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("POST /v1/notifications/desktop/revalidate") {
                    let (action, retry_after) = if claim_idx == 1 {
                        ("deliver", None)
                    } else if claim_idx == 2 {
                        ("cancel", None)
                    } else {
                        ("retry_later", Some(30000))
                    };
                    let resp_body = serde_json::to_string(&DesktopRevalidateResponse {
                        action: action.to_string(),
                        permit: if action == "deliver" {
                            Some("permit-abc".to_string())
                        } else {
                            None
                        },
                        title: None,
                        body: None,
                        sound: None,
                        retry_after_ms: retry_after,
                    })
                    .unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        resp_body.len(),
                        resp_body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if request_line.starts_with("POST /v1/notifications/desktop/report") {
                    let req: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    report_log_clone.lock().unwrap().push(req);
                    let b = "{\"ok\":true}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        b.len(),
                        b
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else {
                    let resp =
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(resp.as_bytes());
                }
            }
        });

        let endpoint = crate::LocalApiEndpoint {
            origin: format!("http://127.0.0.1:{port}"),
            token: "tok".to_string(),
        };

        let gated_adapter = MockNotificationAdapter {
            operational: false,
            ..Default::default()
        };

        let claim1 = claim_notifications(&endpoint, "owner", "granted")
            .unwrap()
            .unwrap();
        let reval1 = revalidate_claim(&endpoint, &claim1.delivery_id, &claim1.claim_token).unwrap();
        assert_eq!(reval1.action, "deliver");
        assert!(!gated_adapter.is_operational());
        report_delivery(
            &endpoint,
            &claim1.delivery_id,
            &claim1.claim_token,
            "failed",
            Some("delivery_gated"),
        )
        .unwrap();

        let claim2 = claim_notifications(&endpoint, "owner", "granted")
            .unwrap()
            .unwrap();
        let reval2 = revalidate_claim(&endpoint, &claim2.delivery_id, &claim2.claim_token).unwrap();
        assert_eq!(reval2.action, "cancel");
        report_delivery(
            &endpoint,
            &claim2.delivery_id,
            &claim2.claim_token,
            "failed",
            Some("cancelled"),
        )
        .unwrap();

        let claim3 = claim_notifications(&endpoint, "owner", "granted")
            .unwrap()
            .unwrap();
        let reval3 = revalidate_claim(&endpoint, &claim3.delivery_id, &claim3.claim_token).unwrap();
        assert_eq!(reval3.action, "retry_later");
        assert_eq!(reval3.retry_after_ms, Some(30000));

        let reports = report_log.lock().unwrap();
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0]["result"], "failed");
        assert_eq!(reports[0]["code"], "delivery_gated");
        assert_eq!(reports[1]["result"], "failed");
        assert_eq!(reports[1]["code"], "cancelled");
    }

    #[test]
    fn test_reconciliation_multi_chunk() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind port");
        let port = listener.local_addr().unwrap().port();

        let chunk_sizes = Arc::new(Mutex::new(Vec::new()));
        let chunk_sizes_clone = chunk_sizes.clone();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }

                let mut content_length = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line == "\r\n" || line == "\n" {
                        break;
                    }
                    if line.to_lowercase().starts_with("content-length:") {
                        if let Some(val) = line.split(':').nth(1) {
                            content_length = val.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                }

                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }

                if request_line.starts_with("POST /v1/notifications/desktop/reconcile") {
                    let req: DesktopReconcileRequest = serde_json::from_slice(&body).unwrap();
                    chunk_sizes_clone
                        .lock()
                        .unwrap()
                        .push(req.identifiers.len());
                    let b = "{\"remove_identifiers\":[]}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        b.len(),
                        b
                    );
                    let _ = stream.write_all(resp.as_bytes());
                }
            }
        });

        let endpoint = crate::LocalApiEndpoint {
            origin: format!("http://127.0.0.1:{port}"),
            token: "tok".to_string(),
        };

        let identifiers: Vec<String> = (0..250).map(|i| format!("id-{i}")).collect();
        for chunk in identifiers.chunks(100) {
            let res = reconcile_notifications(&endpoint, chunk).unwrap();
            assert!(res.remove_identifiers.is_empty());
        }

        let recorded = chunk_sizes.lock().unwrap();
        assert_eq!(*recorded, vec![100, 100, 50]);
    }

    #[test]
    fn test_dock_badge_formatting() {
        let adapter = MockNotificationAdapter::default();

        let count = 0;
        let label = if count == 0 {
            None
        } else if count > 99 {
            Some("99+".to_string())
        } else {
            Some(count.to_string())
        };
        adapter.set_dock_badge(label.as_deref()).unwrap();
        assert_eq!(*adapter.dock_badge.lock().unwrap(), None);

        let count = 5;
        let label = if count == 0 {
            None
        } else if count > 99 {
            Some("99+".to_string())
        } else {
            Some(count.to_string())
        };
        adapter.set_dock_badge(label.as_deref()).unwrap();
        assert_eq!(*adapter.dock_badge.lock().unwrap(), Some("5".to_string()));

        let count = 120;
        let label = if count == 0 {
            None
        } else if count > 99 {
            Some("99+".to_string())
        } else {
            Some(count.to_string())
        };
        adapter.set_dock_badge(label.as_deref()).unwrap();
        assert_eq!(*adapter.dock_badge.lock().unwrap(), Some("99+".to_string()));
    }

    #[test]
    fn test_permissions_toml_and_capabilities_default() {
        let perm_content = std::fs::read_to_string("permissions/notifications.toml")
            .expect("read permissions/notifications.toml");
        assert!(perm_content.contains("allow-notification-permission-state"));
        assert!(perm_content.contains("allow-request-notification-permission"));
        assert!(perm_content.contains("allow-take-notification-intent"));
        assert!(perm_content.contains("allow-report-notification-view"));

        let cap_content = std::fs::read_to_string("capabilities/default.json")
            .expect("read capabilities/default.json");
        assert!(cap_content.contains("\"allow-notification-permission-state\""));
        assert!(cap_content.contains("\"allow-request-notification-permission\""));
        assert!(cap_content.contains("\"allow-take-notification-intent\""));
        assert!(cap_content.contains("\"allow-report-notification-view\""));
    }
}
