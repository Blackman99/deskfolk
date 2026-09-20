use serde_json::Value;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::{net::UnixStream, process::CommandExt};

#[cfg(unix)]
static CHANNEL: Mutex<Option<UnixStream>> = Mutex::new(None);

#[cfg(unix)]
pub fn prepare_channel(command: &mut std::process::Command) -> Option<UnixStream> {
    let (parent, child) = UnixStream::pair().ok()?;
    parent
        .set_read_timeout(Some(Duration::from_secs(130)))
        .ok()?;
    parent
        .set_write_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    command.arg("--desktop-remote-channel");
    // Only the child inherits the connected endpoint; no named socket or bearer is published.
    unsafe {
        command.pre_exec(move || {
            let fd = child.as_raw_fd();
            if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Some(parent)
}

#[cfg(unix)]
pub fn adopt_channel(channel: UnixStream) {
    if let Ok(mut guard) = CHANNEL.lock() {
        *guard = Some(channel);
    }
}

fn validate(input: &Value) -> Result<(), String> {
    let object = input.as_object().ok_or("malformed")?;
    let allowed: &[&str] = match object.get("operation").and_then(Value::as_str) {
        Some("status" | "open_pair" | "prepare_recovery") => &["operation"],
        Some("confirm_recovery") => &["operation", "proof"],
        Some("initialize") => &["operation", "config", "bootstrap"],
        Some("prepare_pair") => &["operation", "pairingId"],
        Some("confirm_pair") => &["operation", "pairingId", "proof"],
        _ => return Err("malformed".into()),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("malformed".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_local_setup(
    _caller: super::remote_native::BundledNativeCaller,
    request: Value,
) -> Result<Value, String> {
    validate(&request)?;
    let bytes = serde_json::to_vec(&request).map_err(|_| "malformed")?;
    if bytes.is_empty() || bytes.len() > 8192 {
        return Err("too_large".into());
    }
    #[cfg(unix)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = CHANNEL.lock().map_err(|_| "unavailable")?;
            let stream = guard.as_mut().ok_or("desktop_channel_unavailable")?;
            let result = (|| {
                stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
                stream.write_all(&bytes)?;
                let mut prefix = [0; 4];
                stream.read_exact(&mut prefix)?;
                let length = u32::from_be_bytes(prefix) as usize;
                if length == 0 || length > 8192 {
                    return Err(std::io::Error::other("invalid response"));
                }
                let mut body = vec![0; length];
                stream.read_exact(&mut body)?;
                serde_json::from_slice(&body).map_err(std::io::Error::other)
            })();
            if result.is_err() {
                *guard = None;
            }
            result.map_err(|_| "desktop_channel_unavailable".to_string())
        })
        .await
        .map_err(|_| "unavailable".to_string())?
    }
    #[cfg(not(unix))]
    Err("unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn setup_is_not_a_generic_native_or_http_proxy() {
        assert!(validate(&json!({"operation":"open_pair"})).is_ok());
        assert!(validate(&json!({"operation":"read", "material":"host_identity"})).is_err());
        assert!(validate(&json!({"operation":"status", "url":"http://localhost"})).is_err());
    }
}
