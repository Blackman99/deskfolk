//! Copied from the Tauri app (`apps/desktop/src-tauri/src/remote_setup.rs`), macOS only: the
//! Windows pipe channel is not carried over, and the command is a plain function (`local_setup`).
//!
//! Pairing on this Mac talks to the daemon over a channel the window hands it at spawn (an
//! inherited socket pair, `prepare_channel` / `adopt_channel`), not over the local HTTP API. This
//! shell starts the dev runtime without one (`runtime::ensure`), and a dev build refuses the
//! command anyway, so nothing adopts a channel yet: a packaged non-dev build must spawn the daemon
//! with `prepare_channel` for pairing to work. Until then the command answers
//! `desktop_channel_unavailable`, as the Tauri app does when its channel is gone.
#![allow(dead_code)]

use serde_json::Value;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::sync::Mutex;
use std::time::Duration;

use crate::dev_build::Identity;

/// How long a reply may take: a confirmation waits on the person, and its challenge lasts 120 s.
const REPLY_TIMEOUT: Duration = Duration::from_secs(130);
/// Both ways, a frame is at most this long; anything else means the channel is not what it was.
const MAX_FRAME: usize = 8192;

static CHANNEL: Mutex<Option<UnixStream>> = Mutex::new(None);

pub fn prepare_channel(command: &mut std::process::Command) -> Option<UnixStream> {
    let (parent, child) = UnixStream::pair().ok()?;
    parent.set_read_timeout(Some(REPLY_TIMEOUT)).ok()?;
    parent.set_write_timeout(Some(Duration::from_secs(10))).ok()?;
    command.arg("--desktop-remote-channel");
    // Only the child inherits the connected endpoint; no named socket or bearer is published.
    // SAFETY: `pre_exec` runs between fork and exec, and only async-signal-safe calls happen here.
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

pub fn adopt_channel(channel: UnixStream) {
    if let Ok(mut guard) = CHANNEL.lock() {
        *guard = Some(channel);
    }
}

fn write_frame(writer: &mut impl Write, bytes: &[u8]) -> std::io::Result<()> {
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}

fn read_frame(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut prefix = [0; 4];
    reader.read_exact(&mut prefix)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(std::io::Error::other("invalid response"));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(body)
}

fn validate(input: &Value) -> Result<(), String> {
    let object = input.as_object().ok_or("malformed")?;
    let allowed: &[&str] = match object.get("operation").and_then(Value::as_str) {
        Some("status" | "open_pair" | "list_devices" | "prepare_recovery") => &["operation"],
        Some("confirm_recovery" | "confirm_change" | "confirm_uv_renewal" | "confirm_remove_device") => {
            &["operation", "proof"]
        }
        Some("prepare_change") => &["operation", "change"],
        Some("prepare_uv_renewal" | "prepare_remove_device") => &["operation", "deviceId"],
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

/// `remote_local_setup({ request })`. Blocks on the daemon, so the caller runs it off the engine
/// thread.
pub fn local_setup(id: &Identity, request: Value) -> Result<Value, String> {
    crate::remote_native::authorize(id)?;
    validate(&request)?;
    let bytes = serde_json::to_vec(&request).map_err(|_| "malformed")?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err("too_large".into());
    }
    exchange_bytes(&bytes)
}

/// One framed request and its reply over the channel. Also used by the shell itself for the
/// confirmation steps the app may not send (`remote_native::confirmation`).
pub(crate) fn exchange(request: &Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(request).map_err(|_| "malformed")?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err("too_large".into());
    }
    exchange_bytes(&bytes)
}

fn exchange_bytes(bytes: &[u8]) -> Result<Value, String> {
    let mut guard = CHANNEL.lock().map_err(|_| "unavailable")?;
    let stream = guard.as_mut().ok_or("desktop_channel_unavailable")?;
    let result = (|| {
        write_frame(stream, bytes)?;
        let body = read_frame(stream)?;
        serde_json::from_slice(&body).map_err(std::io::Error::other)
    })();
    if result.is_err() {
        *guard = None;
    }
    result.map_err(|_| "desktop_channel_unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_are_length_prefixed_and_bounded_both_ways() {
        let mut wire = Vec::new();
        write_frame(&mut wire, br#"{"operation":"status"}"#).unwrap();
        assert_eq!(&wire[..4], &22u32.to_be_bytes());
        assert_eq!(read_frame(&mut wire.as_slice()).unwrap(), br#"{"operation":"status"}"#);
        // Two replies back to back come apart where their prefixes say.
        let mut two = wire.clone();
        two.extend_from_slice(&wire);
        let mut reader = two.as_slice();
        assert!(read_frame(&mut reader).is_ok());
        assert!(read_frame(&mut reader).is_ok());
        assert!(read_frame(&mut reader).is_err());
        // Not a frame: a line the daemon printed to stdout, an empty or an oversized prefix.
        assert!(read_frame(&mut b"Deskfolk daemon listening\n".as_slice()).is_err());
        assert!(read_frame(&mut [0, 0, 0, 0].as_slice()).is_err());
        let mut huge = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
        huge.resize(4 + MAX_FRAME + 1, b' ');
        assert!(read_frame(&mut huge.as_slice()).is_err());
    }

    #[test]
    fn a_development_build_refuses_the_setup_before_reading_it() {
        let dev = Identity { bundle_id: "com.real-bot.desktop.nsh-dev".into(), data_dir: "/tmp/dev".into(), port: 17990, version: "0.4.0" };
        assert_eq!(local_setup(&dev, json!({"operation":"status"})).unwrap_err(), "disabled");
        assert_eq!(local_setup(&dev, json!("not an object")).unwrap_err(), "disabled");
    }

    #[test]
    fn without_a_channel_the_exchange_says_so() {
        assert_eq!(exchange(&json!({"operation":"status"})).unwrap_err(), "desktop_channel_unavailable");
    }

    #[test]
    fn setup_is_not_a_generic_native_or_http_proxy() {
        assert!(validate(&json!({"operation":"open_pair"})).is_ok());
        assert!(validate(&json!({"operation":"list_devices"})).is_ok());
        assert!(validate(&json!({"operation":"prepare_remove_device", "deviceId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"})).is_ok());
        assert!(validate(&json!({"operation":"read", "material":"host_identity"})).is_err());
        assert!(validate(&json!({"operation":"status", "url":"http://localhost"})).is_err());
        // The confirmation steps are the window's own; its webview cannot mint a proof.
        let challenge = format!("{}=", "A".repeat(43));
        assert!(validate(&json!({"operation":"challenge_proof", "challenge": challenge})).is_err());
        assert!(validate(&json!({"operation":"challenge_display", "challenge": challenge})).is_err());
        assert!(validate(&json!({"operation":"dev_authenticate", "challenge": challenge})).is_err());
    }
}
