//! Read the daemon's runtime descriptor and call health / quit / stop everything.
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
    PathBuf::from(default_data_dir(cfg!(windows), |name| {
        std::env::var(name).ok()
    }))
}

/// Contract §1's default-data-directory rule, joined by hand rather than
/// through `std::path::Path` (whose separator follows the platform this is
/// *compiled* for, not the `windows` flag) and reading the environment
/// through a closure rather than the real process environment, so the win32
/// branch — `%LOCALAPPDATA%\real-bot`, falling back to
/// `%USERPROFILE%\AppData\Local\real-bot` — is exercised from a macOS test.
fn default_data_dir(windows: bool, env: impl Fn(&str) -> Option<String>) -> String {
    let value = |name: &str| env(name).filter(|v| !v.is_empty());
    if windows {
        let root = value("LOCALAPPDATA")
            .or_else(|| value("USERPROFILE").map(|home| format!("{home}\\AppData\\Local")))
            .unwrap_or_else(|| ".".to_string());
        format!("{}\\{DEFAULT_DIRNAME}", root.trim_end_matches('\\'))
    } else {
        let home = value("HOME").unwrap_or_else(|| ".".to_string());
        format!(
            "{}/Library/Application Support/{DEFAULT_DIRNAME}",
            home.trim_end_matches('/')
        )
    }
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
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        if pid <= 0 {
            return false;
        }
        // SAFETY: `pid` is a plain process id; the handle is closed on every path below.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
        if handle.is_null() {
            // Denied still means the process exists (we just can't query it) —
            // the same case `kill(pid, 0)` reports as EPERM on unix.
            return std::io::Error::last_os_error().raw_os_error()
                == Some(ERROR_ACCESS_DENIED as i32);
        }
        let mut exit_code: u32 = 0;
        // SAFETY: `handle` was just opened above and is closed right after; `exit_code`
        // is a valid out-pointer for the call's duration.
        let alive = unsafe {
            GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32
        };
        unsafe { CloseHandle(handle) };
        alive
    }
    #[cfg(not(any(unix, windows)))]
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

#[allow(dead_code)]
pub fn write_stop_latch(dir: &Path) -> Result<(), String> {
    crate::launchd::write_stop_latch(&latch_path(dir))
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

/// The menu bar's 全部停下: a stop of yours on every Bot (ADR 0040 P2). A daemon that has no stops
/// yet refuses it (409), and the menu bar then stops the latest live turn in a direct, as before.
pub fn post_stop(endpoint: &Endpoint) -> bool {
    post_json(endpoint, "/v1/holds", r#"{"scope":"global"}"#)
        || post_json(endpoint, "/v1/turns/stop", "{}")
}

fn post_json(endpoint: &Endpoint, path: &str, body: &str) -> bool {
    let url = format!("{}{}", endpoint.origin, path);
    match agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .set("Content-Type", "application/json")
        .send_string(body)
    {
        Ok(resp) => (200..300).contains(&resp.status()),
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
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("independent-runtime-tests")
            .join(format!("local-api-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        dir
    }

    fn fake_env(pairs: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn default_data_dir_matches_contract_section_1() {
        // win32: LOCALAPPDATA wins outright.
        assert_eq!(
            default_data_dir(
                true,
                fake_env(vec![("LOCALAPPDATA", r"C:\Users\me\AppData\Local")])
            ),
            r"C:\Users\me\AppData\Local\real-bot"
        );
        // win32: falls back to USERPROFILE\AppData\Local when LOCALAPPDATA is unset.
        assert_eq!(
            default_data_dir(true, fake_env(vec![("USERPROFILE", r"C:\Users\me")])),
            r"C:\Users\me\AppData\Local\real-bot"
        );
        // win32: an empty LOCALAPPDATA is treated as unset, not as a literal empty root.
        assert_eq!(
            default_data_dir(
                true,
                fake_env(vec![("LOCALAPPDATA", ""), ("USERPROFILE", r"C:\Users\me")])
            ),
            r"C:\Users\me\AppData\Local\real-bot"
        );
        // win32: neither set falls back to the cwd, same spirit as the mac fallback.
        assert_eq!(default_data_dir(true, fake_env(vec![])), r".\real-bot");

        // macOS/Linux: unchanged rule.
        assert_eq!(
            default_data_dir(false, fake_env(vec![("HOME", "/Users/me")])),
            "/Users/me/Library/Application Support/real-bot"
        );
        assert_eq!(
            default_data_dir(false, fake_env(vec![])),
            "./Library/Application Support/real-bot"
        );
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

    /// A daemon on a loopback port that answers each request with the next status, and reports the
    /// request lines it saw.
    fn answering(statuses: Vec<u16>) -> (Endpoint, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for status in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0usize;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header == "\r\n" || header.is_empty() {
                        break;
                    }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; length];
                reader.read_exact(&mut body).unwrap();
                lines.push(format!(
                    "{} {}",
                    first.trim(),
                    String::from_utf8_lossy(&body)
                ));
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
            lines
        });
        (
            Endpoint {
                origin: format!("http://127.0.0.1:{port}"),
                token: "t".into(),
            },
            seen,
        )
    }

    #[test]
    fn menu_bar_stop_is_a_stop_on_everything() {
        let (endpoint, seen) = answering(vec![201]);
        assert!(post_stop(&endpoint));
        assert_eq!(
            seen.join().unwrap(),
            vec![r#"POST /v1/holds HTTP/1.1 {"scope":"global"}"#.to_string()]
        );
    }

    #[test]
    fn menu_bar_stop_falls_back_to_the_latest_turn_on_a_daemon_without_stops() {
        let (endpoint, seen) = answering(vec![409, 204]);
        assert!(post_stop(&endpoint));
        assert_eq!(
            seen.join().unwrap(),
            vec![
                r#"POST /v1/holds HTTP/1.1 {"scope":"global"}"#.to_string(),
                "POST /v1/turns/stop HTTP/1.1 {}".to_string(),
            ]
        );
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
    fn stop_latch_is_a_private_file_and_blocks_window_respawn() {
        let dir = temp_dir();
        assert!(!stop_latch_present(&dir));
        fs::write(dir.join("runtime.stop"), "stopped\n").unwrap();
        assert!(stop_latch_present(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stop_latch_helpers_do_not_touch_launchd() {
        let dir = temp_dir();
        assert!(!stop_latch_present(&dir));
        write_stop_latch(&dir).unwrap();
        assert!(stop_latch_present(&dir));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(latch_path(&dir)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert!(clear_stop_latch(&dir));
        assert!(!stop_latch_present(&dir));
        fs::remove_dir_all(&dir).ok();
    }
}
