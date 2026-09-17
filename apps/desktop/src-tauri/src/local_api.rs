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
}
