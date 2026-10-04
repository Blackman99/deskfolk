use serde_json::Value;
use std::io::{Read, Write};

// The desktop remote channel is a unix domain socket pair handed to the daemon over an inherited
// fd. Windows has no way to hand a child a handle past the standard three that Bun would pick up,
// so there it is the daemon's own stdin and stdout, two pipes only this window holds the other
// ends of (ADR 0059). Either way it carries the same length-prefixed JSON frames.
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::sync::Mutex;
use std::time::Duration;

/// How long a reply may take: a confirmation waits on the person, and its challenge lasts 120 s.
const REPLY_TIMEOUT: Duration = Duration::from_secs(130);
/// Both ways, a frame is at most this long; anything else means the channel is not what it was.
const MAX_FRAME: usize = 8192;

#[cfg(unix)]
static CHANNEL: Mutex<Option<UnixStream>> = Mutex::new(None);

#[cfg(windows)]
struct PipeChannel {
    input: std::process::ChildStdin,
    /// Each reply frame the daemon wrote, read off its stdout by a thread of its own: a pipe on
    /// Windows has no read timeout, and a daemon that stops answering must not hold the lock.
    replies: std::sync::mpsc::Receiver<Vec<u8>>,
}

#[cfg(windows)]
static CHANNEL: Mutex<Option<PipeChannel>> = Mutex::new(None);

#[cfg(unix)]
pub fn prepare_channel(command: &mut std::process::Command) -> Option<UnixStream> {
    let (parent, child) = UnixStream::pair().ok()?;
    parent.set_read_timeout(Some(REPLY_TIMEOUT)).ok()?;
    parent
        .set_write_timeout(Some(Duration::from_secs(10)))
        .ok()?;
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

#[cfg(unix)]
pub fn adopt_channel(channel: UnixStream) {
    if let Ok(mut guard) = CHANNEL.lock() {
        *guard = Some(channel);
    }
}

/// The daemon's stdin and stdout become the channel; nothing else of it is published either.
#[cfg(windows)]
pub fn prepare_channel(command: &mut std::process::Command) {
    use std::process::Stdio;
    command.arg("--desktop-remote-channel");
    command.stdin(Stdio::piped()).stdout(Stdio::piped());
}

/// Takes the spawned daemon's pipes as the channel, replacing the last daemon's.
#[cfg(windows)]
pub fn adopt_channel(child: &mut std::process::Child) {
    let (Some(input), Some(mut output)) = (child.stdin.take(), child.stdout.take()) else {
        return;
    };
    let (sender, replies) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // Ends when the daemon's stdout does, or garbles; the receiver then sees it gone.
        while let Ok(frame) = read_frame(&mut output) {
            if sender.send(frame).is_err() {
                return;
            }
        }
    });
    if let Ok(mut guard) = CHANNEL.lock() {
        *guard = Some(PipeChannel { input, replies });
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

#[tauri::command]
pub async fn remote_local_setup(
    _caller: super::remote_native::BundledNativeCaller,
    request: Value,
) -> Result<Value, String> {
    validate(&request)?;
    let bytes = serde_json::to_vec(&request).map_err(|_| "malformed")?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err("too_large".into());
    }
    tauri::async_runtime::spawn_blocking(move || exchange_bytes(&bytes))
        .await
        .map_err(|_| "unavailable".to_string())?
}

/// One framed request and its reply over the channel. Also used by the window itself for the
/// confirmation steps its webview may not send (`remote_native::remote_native_confirmation`).
pub(crate) fn exchange(request: &Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(request).map_err(|_| "malformed")?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err("too_large".into());
    }
    exchange_bytes(&bytes)
}

#[cfg(unix)]
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

#[cfg(windows)]
fn exchange_bytes(bytes: &[u8]) -> Result<Value, String> {
    let mut guard = CHANNEL.lock().map_err(|_| "unavailable")?;
    let channel = guard.as_mut().ok_or("desktop_channel_unavailable")?;
    let result = (|| {
        write_frame(&mut channel.input, bytes)?;
        // A reply that comes after this gave up would answer the next request, so a timeout
        // drops the channel like any other failure.
        let body = channel
            .replies
            .recv_timeout(REPLY_TIMEOUT)
            .map_err(std::io::Error::other)?;
        serde_json::from_slice(&body).map_err(std::io::Error::other)
    })();
    if result.is_err() {
        *guard = None;
    }
    result.map_err(|_| "desktop_channel_unavailable".to_string())
}

#[cfg(not(any(unix, windows)))]
fn exchange_bytes(_bytes: &[u8]) -> Result<Value, String> {
    Err("unavailable".into())
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
