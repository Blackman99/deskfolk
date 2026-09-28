//! The stdin control-frame wire format: `[type:u8][len:u32be][payload]`. Generic over `Read` so
//! the exact same decoder runs against real stdin at runtime and an in-memory `io::Cursor` in
//! tests — no Windows types involved, so this is fully exercised by `cargo test` on any host.

use std::io::{self, Read};

/// The Swift helper aborts the control loop on a frame this large; matched here so both sides
/// agree on what "too big to be real" means.
pub const MAX_FRAME_PAYLOAD: usize = 1 << 20;

pub const TYPE_INPUT: u8 = 1;
pub const TYPE_RESIZE: u8 = 2;
pub const TYPE_SIGNAL: u8 = 3;
pub const TYPE_SHUTDOWN: u8 = 4;

/// One decoded control-frame event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    /// Raw bytes to write to the pty, verbatim.
    Input(Vec<u8>),
    /// A new terminal size.
    Resize { rows: u16, cols: u16 },
    /// A signal number, Darwin numbering (see `signal.rs` for what Windows does with it).
    Signal(u8),
    /// Take the session down.
    Shutdown,
    /// A frame we understood but that doesn't ask for anything (a malformed resize/signal
    /// payload, or a type we don't recognize) — matches the Swift helper's `default: break`:
    /// keep reading, don't treat it as an error.
    Ignored,
    /// stdin closed, a read failed, or a frame declared a payload over `MAX_FRAME_PAYLOAD` —
    /// all three mean the same thing the Swift helper's dropped control loop means: the daemon
    /// is gone (or as good as), so this is treated exactly like an explicit `Shutdown`.
    EndOfStream,
}

/// Reads exactly `buf.len()` bytes, or `Ok(false)` if the stream ends first — including partway
/// through, which is just as final as an EOF at the very start.
fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<bool> {
    match reader.read_exact(buf) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(err) => Err(err),
    }
}

/// Reads and decodes one control frame, blocking until a full frame arrives or the stream ends.
pub fn read_event<R: Read>(reader: &mut R) -> io::Result<ControlEvent> {
    let mut header = [0u8; 5];
    if !read_exact_or_eof(reader, &mut header)? {
        return Ok(ControlEvent::EndOfStream);
    }
    let frame_type = header[0];
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if len > MAX_FRAME_PAYLOAD {
        return Ok(ControlEvent::EndOfStream);
    }
    let mut payload = vec![0u8; len];
    if !read_exact_or_eof(reader, &mut payload)? {
        return Ok(ControlEvent::EndOfStream);
    }
    Ok(decode(frame_type, payload))
}

fn decode(frame_type: u8, payload: Vec<u8>) -> ControlEvent {
    match frame_type {
        TYPE_INPUT => ControlEvent::Input(payload),
        TYPE_RESIZE if payload.len() == 4 => ControlEvent::Resize {
            rows: u16::from_be_bytes([payload[0], payload[1]]),
            cols: u16::from_be_bytes([payload[2], payload[3]]),
        },
        TYPE_SIGNAL if payload.len() == 1 => ControlEvent::Signal(payload[0]),
        TYPE_SHUTDOWN => ControlEvent::Shutdown,
        _ => ControlEvent::Ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frame(frame_type: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + payload.len());
        out.push(frame_type);
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn decodes_an_input_frame() {
        let bytes = frame(TYPE_INPUT, b"abc");
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Input(b"abc".to_vec()));
    }

    #[test]
    fn decodes_an_empty_input_frame() {
        let bytes = frame(TYPE_INPUT, b"");
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Input(Vec::new()));
    }

    #[test]
    fn decodes_a_resize_frame() {
        let bytes = frame(TYPE_RESIZE, &[0, 24, 0, 80]);
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Resize { rows: 24, cols: 80 });
    }

    #[test]
    fn decodes_a_signal_frame() {
        let bytes = frame(TYPE_SIGNAL, &[9]);
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Signal(9));
    }

    #[test]
    fn decodes_a_shutdown_frame() {
        let bytes = frame(TYPE_SHUTDOWN, b"");
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Shutdown);
    }

    #[test]
    fn shutdown_frame_ignores_a_stray_payload() {
        // The Swift helper doesn't check frame 4's payload length either.
        let bytes = frame(TYPE_SHUTDOWN, b"???");
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Shutdown);
    }

    #[test]
    fn malformed_resize_payload_is_ignored_not_fatal() {
        let bytes = frame(TYPE_RESIZE, &[0, 1]);
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Ignored);
    }

    #[test]
    fn malformed_signal_payload_is_ignored_not_fatal() {
        let bytes = frame(TYPE_SIGNAL, &[]);
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Ignored);
    }

    #[test]
    fn unknown_frame_type_is_ignored_not_fatal() {
        let bytes = frame(99, b"");
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Ignored);
    }

    #[test]
    fn empty_stream_is_end_of_stream() {
        let mut cursor = Cursor::new(Vec::new());
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::EndOfStream);
    }

    #[test]
    fn eof_partway_through_the_header_is_end_of_stream() {
        let mut cursor = Cursor::new(vec![TYPE_INPUT, 0, 0]);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::EndOfStream);
    }

    #[test]
    fn eof_partway_through_the_payload_is_end_of_stream() {
        let mut header = vec![TYPE_INPUT];
        header.extend_from_slice(&10u32.to_be_bytes());
        header.extend_from_slice(b"abc"); // declared 10 bytes, only 3 delivered
        let mut cursor = Cursor::new(header);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::EndOfStream);
    }

    #[test]
    fn oversized_frame_is_end_of_stream_without_reading_the_payload() {
        let mut header = vec![TYPE_INPUT];
        header.extend_from_slice(&((MAX_FRAME_PAYLOAD as u32) + 1).to_be_bytes());
        // No payload bytes at all follow — if the decoder tried to read them, it would report
        // EndOfStream anyway, so this specifically checks it doesn't try to allocate first.
        let mut cursor = Cursor::new(header);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::EndOfStream);
    }

    #[test]
    fn reads_multiple_frames_off_the_same_stream_in_order() {
        let mut bytes = frame(TYPE_SIGNAL, &[2]);
        bytes.extend(frame(TYPE_INPUT, b"hi"));
        bytes.extend(frame(TYPE_SHUTDOWN, b""));
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Signal(2));
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Input(b"hi".to_vec()));
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::Shutdown);
    }

    #[test]
    fn a_frame_over_one_mebibyte_ends_the_loop() {
        // Sanity check on the constant itself: exactly at the limit is fine...
        let at_limit = frame(TYPE_INPUT, &vec![0u8; MAX_FRAME_PAYLOAD]);
        let mut cursor = Cursor::new(at_limit);
        match read_event(&mut cursor).unwrap() {
            ControlEvent::Input(payload) => assert_eq!(payload.len(), MAX_FRAME_PAYLOAD),
            other => panic!("expected Input, got {other:?}"),
        }
        // ...one byte over is not.
        let mut header = vec![TYPE_INPUT];
        header.extend_from_slice(&((MAX_FRAME_PAYLOAD as u32) + 1).to_be_bytes());
        let mut cursor = Cursor::new(header);
        assert_eq!(read_event(&mut cursor).unwrap(), ControlEvent::EndOfStream);
    }
}
