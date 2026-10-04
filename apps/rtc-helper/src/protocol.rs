//! The stdio wire format, both directions: `[type:u8][len:u32be][payload]`, the same framing the
//! pty helpers use for their control frames. Payloads are small JSON objects; the screen's bytes
//! never pass through here, they go straight between the data channel and the local socket.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// An SDP offer with its candidates is a few KiB; anything near this is not a real frame.
pub const MAX_FRAME_PAYLOAD: usize = 64 * 1024;

// daemon → helper
pub const TYPE_OFFER: u8 = 1;
pub const TYPE_CLOSE: u8 = 2;

// helper → daemon
pub const TYPE_ANSWER: u8 = 1;
pub const TYPE_STATE: u8 = 2;
pub const TYPE_ERROR: u8 = 3;
/// Bytes carried each way so far, every couple of seconds while the channel is open.
pub const TYPE_STATS: u8 = 4;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

/// The phone's offer, plus the ICE servers the Mac's own settings name — never ones the phone
/// sent; the daemon fills these in.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Offer {
    pub sdp: String,
    #[serde(default)]
    pub ice_servers: Vec<IceServer>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Offer(Offer),
    Close,
    /// A frame we understood but that asks for nothing (unknown type, unreadable JSON).
    Ignored,
    /// stdin closed, a read failed, or a frame claimed an absurd length: the daemon is gone.
    EndOfStream,
}

pub async fn read_command<R: AsyncRead + Unpin>(reader: &mut R) -> Command {
    let mut header = [0u8; 5];
    if reader.read_exact(&mut header).await.is_err() {
        return Command::EndOfStream;
    }
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if len > MAX_FRAME_PAYLOAD {
        return Command::EndOfStream;
    }
    let mut payload = vec![0u8; len];
    if reader.read_exact(&mut payload).await.is_err() {
        return Command::EndOfStream;
    }
    match header[0] {
        TYPE_OFFER => serde_json::from_slice(&payload)
            .map(Command::Offer)
            .unwrap_or(Command::Ignored),
        TYPE_CLOSE => Command::Close,
        _ => Command::Ignored,
    }
}

#[derive(Debug, Serialize)]
pub struct Answer<'a> {
    pub sdp: &'a str,
}

#[derive(Debug, Serialize)]
pub struct State<'a> {
    pub state: &'a str,
}

#[derive(Debug, Serialize)]
pub struct Stats {
    pub to_phone: u64,
    pub from_phone: u64,
}

#[derive(Debug, Serialize)]
pub struct Failure<'a> {
    pub code: &'a str,
    pub message: String,
}

pub fn encode<T: Serialize>(frame_type: u8, value: &T) -> Vec<u8> {
    let payload = serde_json::to_vec(value).expect("frame payloads are plain structs");
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(frame_type);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    out
}

pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    frame_type: u8,
    value: &T,
) -> std::io::Result<()> {
    writer.write_all(&encode(frame_type, value)).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(frame_type: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![frame_type];
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[tokio::test]
    async fn reads_an_offer_with_ice_servers() {
        let bytes = frame(
            TYPE_OFFER,
            br#"{"sdp":"v=0","ice_servers":[{"urls":["stun:relay.example:3478"]}]}"#,
        );
        let command = read_command(&mut bytes.as_slice()).await;
        assert_eq!(
            command,
            Command::Offer(Offer {
                sdp: "v=0".into(),
                ice_servers: vec![IceServer {
                    urls: vec!["stun:relay.example:3478".into()],
                    username: String::new(),
                    credential: String::new()
                }],
            })
        );
    }

    #[tokio::test]
    async fn ice_servers_default_to_none() {
        let bytes = frame(TYPE_OFFER, br#"{"sdp":"v=0"}"#);
        assert_eq!(
            read_command(&mut bytes.as_slice()).await,
            Command::Offer(Offer {
                sdp: "v=0".into(),
                ice_servers: vec![]
            })
        );
    }

    #[tokio::test]
    async fn close_unknown_and_garbage() {
        assert_eq!(
            read_command(&mut frame(TYPE_CLOSE, b"").as_slice()).await,
            Command::Close
        );
        assert_eq!(
            read_command(&mut frame(9, b"{}").as_slice()).await,
            Command::Ignored
        );
        assert_eq!(
            read_command(&mut frame(TYPE_OFFER, b"not json").as_slice()).await,
            Command::Ignored
        );
    }

    #[tokio::test]
    async fn end_of_stream_on_eof_truncation_and_oversize() {
        assert_eq!(read_command(&mut [].as_slice()).await, Command::EndOfStream);
        let mut truncated = frame(TYPE_OFFER, br#"{"sdp":"v=0"}"#);
        truncated.truncate(8);
        assert_eq!(
            read_command(&mut truncated.as_slice()).await,
            Command::EndOfStream
        );
        let mut huge = vec![TYPE_OFFER];
        huge.extend_from_slice(&((MAX_FRAME_PAYLOAD as u32) + 1).to_be_bytes());
        assert_eq!(
            read_command(&mut huge.as_slice()).await,
            Command::EndOfStream
        );
    }

    #[test]
    fn encodes_length_prefixed_json() {
        let bytes = encode(TYPE_STATE, &State { state: "connected" });
        assert_eq!(bytes[0], TYPE_STATE);
        let len = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        assert_eq!(&bytes[5..], br#"{"state":"connected"}"#);
        assert_eq!(len, bytes.len() - 5);
    }
}
