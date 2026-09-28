//! Keystrokes on their way into ConPTY.
//!
//! portable-pty opens the pseudo console with `PSEUDOCONSOLE_WIN32_INPUT_MODE`, and conhost then
//! asks the terminal (`ESC [ ? 9001 h`) to send keys as Win32 key events. Plain text still gets
//! through as it is, but a bare `0x03` does not become Ctrl+C: on windows-latest, `ping -t` kept
//! running after one. Windows Terminal sends Ctrl+C as key events, and so does this: the Ctrl and C
//! keys going down and up, `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _` each, which conhost turns into the
//! same Ctrl+C a keyboard would, interrupt included.

use std::borrow::Cow;

const ETX: u8 = 0x03;

/// Ctrl down, C down (character 3, left Ctrl held), C up, Ctrl up.
pub const CTRL_C: &[u8] = b"\x1b[17;29;0;1;8;1_\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_\x1b[17;29;0;0;0;1_";

/// `bytes` as conhost should receive them: every `0x03` becomes a Ctrl+C key press, the rest is
/// left exactly as typed.
pub fn encode(bytes: &[u8]) -> Cow<'_, [u8]> {
    if !bytes.contains(&ETX) {
        return Cow::Borrowed(bytes);
    }
    let mut out = Vec::with_capacity(bytes.len() + CTRL_C.len());
    for &byte in bytes {
        if byte == ETX {
            out.extend_from_slice(CTRL_C);
        } else {
            out.push(byte);
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_untouched() {
        assert!(matches!(encode(b"dir\r"), Cow::Borrowed(b"dir\r")));
    }

    #[test]
    fn a_bare_ctrl_c_becomes_a_key_press() {
        assert_eq!(encode(b"\x03").as_ref(), CTRL_C);
    }

    #[test]
    fn ctrl_c_inside_typed_text_keeps_its_place() {
        let mut expected = b"ab".to_vec();
        expected.extend_from_slice(CTRL_C);
        expected.extend_from_slice(b"cd");
        assert_eq!(encode(b"ab\x03cd").as_ref(), expected.as_slice());
    }

    #[test]
    fn the_key_events_press_and_release_both_keys() {
        let text = std::str::from_utf8(CTRL_C).unwrap();
        let events: Vec<&str> = text.split('\x1b').filter(|e| !e.is_empty()).collect();
        assert_eq!(events, ["[17;29;0;1;8;1_", "[67;46;3;1;8;1_", "[67;46;3;0;8;1_", "[17;29;0;0;0;1_"]);
    }
}
