//! Read the daemon's runtime descriptor and call health / quit / stop.
//! Never log the token or Authorization header.

use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::supervisor::{Endpoint, Probe};

const DEFAULT_DIRNAME: &str = "real-bot";
const DESCRIPTOR_NAME: &str = "local-api.json";
const HEALTH_NAME: &str = "real-bot";
pub const BIND_PORT: u16 = 17890;
pub const STOP_LATCH_NAME: &str = "runtime.stop";

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Descriptor {
    pub pid: i32,
    pub port: u16,
    pub token: String,
    pub started_at: String,
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("REAL_BOT_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(DEFAULT_DIRNAME)
}

pub fn descriptor_path(dir: &Path) -> PathBuf {
    dir.join(DESCRIPTOR_NAME)
}

pub fn read_descriptor(dir: &Path) -> Option<Descriptor> {
    let text = fs::read_to_string(descriptor_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn endpoint_from_descriptor(desc: &Descriptor) -> Endpoint {
    Endpoint::new(desc.port, desc.token.clone())
}

pub fn probe_health(origin: &str) -> Probe {
    let url = format!("{origin}/v1/health");
    match agent().get(&url).call() {
        Ok(resp) => {
            let ok = resp.status() == 200
                && resp
                    .into_json::<serde_json::Value>()
                    .ok()
                    .and_then(|v| {
                        let name = v.get("name")?.as_str()?;
                        let ok = v.get("ok")?.as_bool()?;
                        Some(ok && name == HEALTH_NAME)
                    })
                    .unwrap_or(false);
            if ok {
                Probe::Ours
            } else {
                Probe::OccupiedByOther
            }
        }
        Err(ureq::Error::Status(_, _)) => Probe::OccupiedByOther,
        Err(_) => Probe::Down,
    }
}

pub fn probe_bind(port: u16) -> Probe {
    probe_health(&format!("http://127.0.0.1:{port}"))
}

/// `kill(pid, 0)`: the process exists (including one we cannot signal).
pub fn pid_alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        if pid <= 0 {
            return false;
        }
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if rc == 0 {
            return true;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(code) if code == libc::ESRCH => false,
            Some(_) => true,
            None => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Authenticated quit. Returns true if the daemon accepted (204) or is already gone.
pub fn post_quit(endpoint: &Endpoint) -> bool {
    let url = format!("{}/v1/runtime/quit", endpoint.origin);
    match agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .call()
    {
        Ok(resp) => resp.status() == 204 || resp.status() == 200,
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => false,
        Err(_) => {
            // Connection refused after a successful quit, or the process already died.
            matches!(probe_health(&endpoint.origin), Probe::Down)
        }
    }
}

pub fn latch_path(dir: &Path) -> PathBuf {
    dir.join(STOP_LATCH_NAME)
}

pub fn stop_latch_present(dir: &Path) -> bool {
    latch_path(dir).is_file()
}

pub fn clear_stop_latch(dir: &Path) -> bool {
    match fs::remove_file(latch_path(dir)) {
        Ok(()) => true,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

pub fn write_stop_latch(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    fs::write(latch_path(dir), b"stopped\n").map_err(|err| err.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainStatus {
    pub phase: String,
    pub remaining: Vec<String>,
    pub forced: bool,
}

#[allow(dead_code)]
pub fn get_drain(endpoint: &Endpoint) -> Option<DrainStatus> {
    let url = format!("{}/v1/runtime/drain", endpoint.origin);
    let resp = agent()
        .get(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .call()
        .ok()?;
    parse_drain(resp.into_json().ok()?)
}

#[allow(dead_code)]
pub fn post_quiesce(endpoint: &Endpoint, action: &str) -> Option<DrainStatus> {
    let url = format!("{}/v1/runtime/quiesce", endpoint.origin);
    let resp = agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .send_string(&format!(r#"{{"action":"{action}"}}"#))
        .ok()?;
    parse_drain(resp.into_json().ok()?)
}

#[allow(dead_code)]
pub fn post_handoff_exit(endpoint: &Endpoint) -> bool {
    post_runtime(endpoint, "/v1/runtime/handoff")
}

#[allow(dead_code)]
pub fn post_runtime_stop(endpoint: &Endpoint) -> bool {
    post_runtime(endpoint, "/v1/runtime/stop")
}

#[allow(dead_code)]
fn post_runtime(endpoint: &Endpoint, path: &str) -> bool {
    let url = format!("{}{path}", endpoint.origin);
    match agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .call()
    {
        Ok(resp) => resp.status() == 204 || resp.status() == 200,
        Err(_) => matches!(probe_health(&endpoint.origin), Probe::Down),
    }
}

pub(crate) fn parse_drain(value: serde_json::Value) -> Option<DrainStatus> {
    let phase = value.get("phase")?.as_str()?.to_string();
    let forced = value.get("forced")?.as_bool()?;
    let remaining = value
        .get("remaining")?
        .as_array()?
        .iter()
        .map(|id| id.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    Some(DrainStatus {
        phase,
        remaining,
        forced,
    })
}

pub fn post_stop(endpoint: &Endpoint) -> bool {
    let url = format!("{}/v1/turns/stop", endpoint.origin);
    match agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .send_string("{}")
    {
        Ok(resp) => resp.status() == 204 || resp.status() == 200,
        Err(_) => false,
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(800))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = UNIQUE.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("real-bot-desktop-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_descriptor_without_requiring_pretty_print() {
        let dir = temp_dir();
        fs::write(
            descriptor_path(&dir),
            r#"{"pid":12,"port":17890,"token":"abc","started_at":"2026-09-14T00:00:00.000Z"}"#,
        )
        .unwrap();
        let desc = read_descriptor(&dir).expect("descriptor");
        assert_eq!(desc.pid, 12);
        assert_eq!(desc.port, 17890);
        assert_eq!(desc.token, "abc");
        let ep = endpoint_from_descriptor(&desc);
        assert_eq!(ep.origin, "http://127.0.0.1:17890");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_or_garbage_descriptor_is_none() {
        let dir = temp_dir();
        assert!(read_descriptor(&dir).is_none());
        fs::write(descriptor_path(&dir), "not-json").unwrap();
        assert!(read_descriptor(&dir).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreachable_health_is_down() {
        assert_eq!(probe_bind(1), Probe::Down);
    }

    #[test]
    fn pid_alive_sees_this_process_and_not_pid_zero() {
        assert!(pid_alive(std::process::id() as i32));
        assert!(!pid_alive(0));
        assert!(!pid_alive(-1));
    }

    #[test]
    fn drain_payload_is_phase_remaining_forced() {
        let value = serde_json::json!({
            "phase": "draining",
            "remaining": ["turn-1"],
            "forced": false
        });
        assert_eq!(
            parse_drain(value),
            Some(DrainStatus {
                phase: "draining".into(),
                remaining: vec!["turn-1".into()],
                forced: false,
            })
        );
        assert!(parse_drain(serde_json::json!({ "phase": "running" })).is_none());
    }

    #[test]
    fn stop_latch_helpers_do_not_touch_launchd() {
        let dir = temp_dir();
        assert!(!stop_latch_present(&dir));
        write_stop_latch(&dir).unwrap();
        assert!(stop_latch_present(&dir));
        assert!(clear_stop_latch(&dir));
        assert!(!stop_latch_present(&dir));
        fs::remove_dir_all(&dir).ok();
    }
}
