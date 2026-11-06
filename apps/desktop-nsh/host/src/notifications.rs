//! The runtime's notification API, as the Tauri shell speaks it (`apps/desktop/src-tauri/src/
//! notifications.rs`): the DTOs, the HTTP calls and the presence queue. The loop that uses them is
//! in `notification_loop.rs`. Names and JSON shapes are the Tauri shell's, so the runtime and the
//! messenger see no difference between the two shells.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::endpoint::Endpoint;

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
    /// The process can hand a banner to Notification Center.
    pub native_delivery_v1: bool,
    /// Cold-start click from a signed installed package has been verified.
    pub cold_click_qualified: bool,
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

impl NotificationDeviceResponse {
    /// What the shell assumes while the runtime has no device record (409) or does not answer.
    pub fn default_preference() -> Self {
        Self { enabled: true, badge: true, sound: "default".to_string(), preview: "generic".to_string() }
    }
}

/// One report of where a window is, waiting for the thread that posts it.
pub struct PresenceJob {
    pub endpoint: Endpoint,
    pub visible: bool,
    pub focused: bool,
    pub session_id: Option<String>,
    pub at_latest: bool,
}

/// Presence goes to the runtime from a thread of its own, one queue per window: the messenger
/// reports every 5 s and on every focus change, and a runtime busy with a long conversation can
/// take up to the 3 s timeout to answer; the engine thread must not wait for that. The runtime
/// keeps only the newest presence per instance, so a report still waiting when a newer one comes
/// is dropped.
pub struct PresenceQueue(std::sync::mpsc::Sender<PresenceJob>);

impl PresenceQueue {
    pub fn new(instance_id: String) -> Self {
        let (sender, jobs) = std::sync::mpsc::channel::<PresenceJob>();
        let _ = std::thread::Builder::new().name("presence".into()).spawn(move || {
            while let Ok(mut job) = jobs.recv() {
                while let Ok(newer) = jobs.try_recv() {
                    job = newer;
                }
                let _ = post_presence(
                    &job.endpoint,
                    &NotificationPresenceRequest {
                        instance_id: &instance_id,
                        visible: job.visible,
                        focused: job.focused,
                        session_id: job.session_id.as_deref(),
                        at_latest: job.at_latest,
                    },
                );
            }
        });
        Self(sender)
    }

    pub fn send(&self, job: PresenceJob) {
        let _ = self.0.send(job);
    }
}

fn authorized(request: ureq::Request, endpoint: &Endpoint) -> ureq::Request {
    request.set("Authorization", &format!("Bearer {}", endpoint.token))
}

fn get(endpoint: &Endpoint, path: &str) -> ureq::Request {
    authorized(ureq::get(&format!("{}{path}", endpoint.origin)), endpoint).set("Accept", "application/json")
}

fn post(endpoint: &Endpoint, path: &str) -> ureq::Request {
    authorized(ureq::post(&format!("{}{path}", endpoint.origin)), endpoint)
        .set("Content-Type", "application/json")
}

pub fn poll_state(endpoint: &Endpoint) -> Result<DesktopStateResponse, String> {
    let resp = get(endpoint, "/v1/notifications/desktop/state")
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("state_poll_failed: {e}"))?;
    resp.into_json::<DesktopStateResponse>().map_err(|e| format!("state_parse_failed: {e}"))
}

pub fn poll_device_preference(endpoint: &Endpoint) -> Result<NotificationDeviceResponse, String> {
    match get(endpoint, "/v1/notification-device").timeout(Duration::from_secs(3)).call() {
        Ok(r) => r.into_json::<NotificationDeviceResponse>().map_err(|e| format!("device_parse_failed: {e}")),
        Err(ureq::Error::Status(409, _)) => Ok(NotificationDeviceResponse::default_preference()),
        Err(e) => Err(format!("device_poll_failed: {e}")),
    }
}

pub fn claim_notifications(
    endpoint: &Endpoint,
    owner_id: &str,
    permission: &str,
) -> Result<Option<DesktopClaimResponse>, String> {
    let resp = match post(endpoint, "/v1/notifications/desktop/claim")
        .timeout(Duration::from_secs(10))
        .send_json(&DesktopClaimRequest { owner_id, permission })
    {
        Ok(r) => r,
        Err(ureq::Error::Status(204, _)) => return Ok(None),
        Err(e) => return Err(format!("claim_failed: {e}")),
    };
    if resp.status() == 204 {
        return Ok(None);
    }
    let claim = resp.into_json::<DesktopClaimResponse>().map_err(|e| format!("claim_parse_failed: {e}"))?;
    Ok(Some(claim))
}

pub fn revalidate_claim(
    endpoint: &Endpoint,
    delivery_id: &str,
    claim_token: &str,
) -> Result<DesktopRevalidateResponse, String> {
    let resp = post(endpoint, "/v1/notifications/desktop/revalidate")
        .timeout(Duration::from_secs(5))
        .send_json(&DesktopRevalidateRequest { delivery_id, claim_token })
        .map_err(|e| format!("revalidate_failed: {e}"))?;
    resp.into_json::<DesktopRevalidateResponse>().map_err(|e| format!("revalidate_parse_failed: {e}"))
}

pub fn report_delivery(
    endpoint: &Endpoint,
    delivery_id: &str,
    claim_token: &str,
    result: &str,
    code: Option<&str>,
) -> Result<(), String> {
    post(endpoint, "/v1/notifications/desktop/report")
        .timeout(Duration::from_secs(5))
        .send_json(&DesktopReportRequest { delivery_id, claim_token, result, code })
        .map_err(|e| format!("report_failed: {e}"))?;
    Ok(())
}

pub fn reconcile_notifications(
    endpoint: &Endpoint,
    identifiers: &[String],
) -> Result<DesktopReconcileResponse, String> {
    let resp = post(endpoint, "/v1/notifications/desktop/reconcile")
        .timeout(Duration::from_secs(5))
        .send_json(&DesktopReconcileRequest { identifiers: identifiers.to_vec() })
        .map_err(|e| format!("reconcile_failed: {e}"))?;
    resp.into_json::<DesktopReconcileResponse>().map_err(|e| format!("reconcile_parse_failed: {e}"))
}

pub fn post_presence(endpoint: &Endpoint, req: &NotificationPresenceRequest) -> Result<(), String> {
    post(endpoint, "/v1/notification-presence")
        .timeout(Duration::from_secs(3))
        .send_json(req)
        .map_err(|e| format!("presence_failed: {e}"))?;
    Ok(())
}

/// A tiny HTTP server for the tests: `handler(method_and_path, body)` answers `(status, json)`.
#[cfg(test)]
pub(crate) mod fake {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use crate::endpoint::Endpoint;

    pub type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

    /// Returns the endpoint and every `(request line, authorization, body)` the server saw.
    pub fn serve(
        handler: impl Fn(&str, &str) -> (u16, String) + Send + 'static,
    ) -> (Endpoint, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let request = line.trim().rsplit_once(' ').map(|(a, _)| a.to_owned()).unwrap_or_default();
                let (mut length, mut auth) = (0usize, String::new());
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                    let lower = header.to_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        auth = header.split_once(':').map(|(_, v)| v.trim().to_owned()).unwrap_or_default();
                    }
                }
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body);
                let body = String::from_utf8_lossy(&body).into_owned();
                log.lock().unwrap().push((request.clone(), auth, body.clone()));
                let (status, answer) = handler(&request, &body);
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        (Endpoint { origin: format!("http://127.0.0.1:{port}"), port, token: "test-token".into() }, seen)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::fake::serve;
    use super::*;

    #[test]
    fn dto_json_shapes_match_the_tauri_shell() {
        let dto = NotificationPermissionStateDto {
            permission: "granted".into(),
            native_reading_v1: true,
            native_delivery_v1: true,
            cold_click_qualified: false,
            operational: true,
            gated_reason: None,
            attention_count: 2,
        };
        assert_eq!(
            serde_json::to_value(&dto).unwrap(),
            serde_json::json!({
                "permission": "granted", "nativeReadingV1": true, "nativeDeliveryV1": true,
                "coldClickQualified": false, "operational": true, "gatedReason": null, "attentionCount": 2
            })
        );
        assert_eq!(
            serde_json::to_value(NotificationIntent { click_ref: "r".into() }).unwrap(),
            serde_json::json!({ "clickRef": "r" })
        );
        let facts = NativeFocusFacts { visible: true, focused: false, minimized: false, effective_focused: false };
        assert_eq!(
            serde_json::to_value(facts).unwrap(),
            serde_json::json!({ "visible": true, "focused": false, "minimized": false, "effectiveFocused": false })
        );
        let report: NotificationViewReport =
            serde_json::from_str(r#"{"sessionId":"s","atLatest":true,"visible":false}"#).unwrap();
        assert_eq!(report.session_id.as_deref(), Some("s"));
        assert_eq!(report.at_latest, Some(true));
        assert_eq!(report.visible, Some(false));
        assert_eq!(report.focused, None);
    }

    #[test]
    fn a_delivery_report_leaves_out_an_absent_code() {
        let json = serde_json::to_value(DesktopReportRequest {
            delivery_id: "d",
            claim_token: "t",
            result: "accepted",
            code: None,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "delivery_id": "d", "claim_token": "t", "result": "accepted" }));
    }

    #[test]
    fn the_http_calls_carry_the_bearer_token_and_read_the_answers() {
        let (endpoint, seen) = serve(|request, _| match request {
            "GET /v1/notifications/desktop/state" => (200, r#"{"attention_count":3,"cleanup_revision":42}"#.into()),
            "GET /v1/notification-device" => (
                200,
                r#"{"receiver_id":"desktop","revision":1,"enabled":true,"badge":true,"sound":"default","preview":"generic"}"#.into(),
            ),
            "POST /v1/notifications/desktop/reconcile" => (200, r#"{"remove_identifiers":["stale-1"]}"#.into()),
            "POST /v1/notifications/desktop/claim" => (
                200,
                serde_json::to_string(&DesktopClaimResponse {
                    delivery_id: "deliv-1".into(),
                    claim_token: "token-1".into(),
                    lease_expires_at: 10000,
                    click_ref: "click-ref-1".into(),
                    title: "Test Claim Title".into(),
                    body: "Test Claim Body".into(),
                    sound: Some("default".into()),
                    identifier: "notif-1".into(),
                })
                .unwrap(),
            ),
            "POST /v1/notifications/desktop/revalidate" => (
                200,
                serde_json::to_string(&DesktopRevalidateResponse {
                    action: "deliver".into(),
                    permit: Some("permit-1".into()),
                    title: Some("Revalidated Title".into()),
                    body: Some("Revalidated Body".into()),
                    sound: Some("default".into()),
                    retry_after_ms: None,
                })
                .unwrap(),
            ),
            "POST /v1/notifications/desktop/report" => (200, r#"{"ok":true}"#.into()),
            "POST /v1/notification-presence" => (204, String::new()),
            _ => (404, "{}".into()),
        });

        let state = poll_state(&endpoint).expect("poll_state");
        assert_eq!((state.attention_count, state.cleanup_revision), (3, 42));
        let device = poll_device_preference(&endpoint).expect("poll_device_preference");
        assert!(device.enabled && device.badge);
        let claim = claim_notifications(&endpoint, "owner-1", "granted").expect("claim").expect("some claim");
        assert_eq!((claim.delivery_id.as_str(), claim.title.as_str()), ("deliv-1", "Test Claim Title"));
        let reval = revalidate_claim(&endpoint, &claim.delivery_id, &claim.claim_token).expect("revalidate");
        assert_eq!(reval.action, "deliver");
        assert_eq!(reval.permit.as_deref(), Some("permit-1"));
        assert_eq!(reval.title.as_deref(), Some("Revalidated Title"));
        report_delivery(&endpoint, &claim.delivery_id, &claim.claim_token, "accepted", None).expect("report");
        let reconcile = reconcile_notifications(&endpoint, &["stale-1".to_string()]).expect("reconcile");
        assert_eq!(reconcile.remove_identifiers, vec!["stale-1".to_string()]);
        post_presence(
            &endpoint,
            &NotificationPresenceRequest {
                instance_id: "inst-1",
                visible: true,
                focused: true,
                session_id: Some("sess-1"),
                at_latest: true,
            },
        )
        .expect("presence");

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 7);
        assert!(seen.iter().all(|(_, auth, _)| auth == "Bearer test-token"));
    }

    #[test]
    fn a_204_claim_means_nothing_waits_and_a_409_device_falls_back_to_the_default() {
        let (endpoint, _) = serve(|request, _| match request {
            "POST /v1/notifications/desktop/claim" => (204, String::new()),
            "GET /v1/notification-device" => (409, "{}".into()),
            _ => (404, "{}".into()),
        });
        assert!(claim_notifications(&endpoint, "o", "granted").unwrap().is_none());
        let device = poll_device_preference(&endpoint).unwrap();
        assert!(device.enabled && device.badge);
        assert_eq!((device.sound.as_str(), device.preview.as_str()), ("default", "generic"));
    }

    /// Handing a report over must not wait on the runtime; while it sits on one, the newest of
    /// those behind it goes next.
    #[test]
    fn presence_reports_never_wait_on_a_busy_runtime() {
        let count = Arc::new(Mutex::new(0usize));
        let (endpoint, seen) = serve(move |_, _| {
            let mut n = count.lock().unwrap();
            *n += 1;
            if *n == 1 {
                std::thread::sleep(Duration::from_millis(1500));
            }
            (204, String::new())
        });
        let queue = PresenceQueue::new("inst-1".to_string());
        let job = |session: &str| PresenceJob {
            endpoint: endpoint.clone(),
            visible: true,
            focused: true,
            session_id: Some(session.to_string()),
            at_latest: true,
        };
        let started = std::time::Instant::now();
        queue.send(job("first"));
        std::thread::sleep(Duration::from_millis(200));
        queue.send(job("second"));
        queue.send(job("third"));
        assert!(started.elapsed() < Duration::from_millis(500), "sending waited on the runtime");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(200));
        let sessions: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(_, _, body)| {
                let value: serde_json::Value = serde_json::from_str(body).unwrap();
                value["session_id"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(sessions, vec!["first", "third"]);
    }
}
