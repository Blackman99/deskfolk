//! ConPTY's cursor-inheritance handshake, answered here.
//!
//! portable-pty opens every pseudo console with `PSEUDOCONSOLE_INHERIT_CURSOR`, so before conhost
//! draws anything it asks the terminal where the cursor is (`ESC [ 6 n`, a DSR) and waits for the
//! answer. xterm.js in the window would answer, but only once a window is attached: a session
//! nobody is looking at yet would hang, and on CI nothing ever answers. So the helper answers it
//! itself, for a fresh terminal (row 1, column 1), and keeps the question from reaching the window,
//! which would otherwise answer too and leave a stray `ESC[1;1R` typed at the prompt.
//!
//! Only the start of the output can hold the handshake. Past that, conhost answers a program's own
//! cursor queries from its buffer, so a later `ESC[6n` is left alone.

const QUERY: &[u8] = b"\x1b[6n";
/// The answer: the cursor is at the top left of a terminal that has shown nothing yet.
pub const REPLY: &[u8] = b"\x1b[1;1R";
/// How much output may pass before the question can no longer be the handshake.
const WINDOW: usize = 4096;

pub struct CursorHandshake {
    done: bool,
    seen: usize,
    carry: Vec<u8>,
}

impl Default for CursorHandshake {
    fn default() -> Self {
        Self::new()
    }
}

impl CursorHandshake {
    pub fn new() -> Self {
        CursorHandshake { done: false, seen: 0, carry: Vec::new() }
    }

    /// The bytes of `chunk` to pass on to stdout, and whether to send [`REPLY`] into the pty now.
    pub fn filter(&mut self, chunk: &[u8]) -> (Vec<u8>, bool) {
        if self.done {
            return (chunk.to_vec(), false);
        }
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        if let Some(at) = find(&data, QUERY) {
            self.done = true;
            let mut out = data[..at].to_vec();
            out.extend_from_slice(&data[at + QUERY.len()..]);
            return (out, true);
        }
        self.seen += chunk.len();
        if self.seen >= WINDOW {
            self.done = true;
            return (data, false);
        }
        // Hold back a trailing partial match, so a question split across two reads is still caught.
        let keep = partial_suffix(&data, QUERY);
        self.carry = data.split_off(data.len() - keep);
        (data, false)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// The length of the longest proper prefix of `needle` that `data` ends with.
fn partial_suffix(data: &[u8], needle: &[u8]) -> usize {
    (1..needle.len())
        .rev()
        .find(|&len| data.len() >= len && data[data.len() - len..] == needle[..len])
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_question_and_keeps_it_from_the_window() {
        let mut handshake = CursorHandshake::new();
        let (out, reply) = handshake.filter(b"\x1b[?9001h\x1b[?1004h\x1b[6n");
        assert!(reply);
        assert_eq!(out, b"\x1b[?9001h\x1b[?1004h");
    }

    #[test]
    fn output_after_the_question_in_the_same_read_is_kept() {
        let mut handshake = CursorHandshake::new();
        let (out, reply) = handshake.filter(b"\x1b[6nPS C:\\> ");
        assert!(reply);
        assert_eq!(out, b"PS C:\\> ");
    }

    #[test]
    fn a_question_split_across_reads_is_still_caught() {
        let mut handshake = CursorHandshake::new();
        let (first, reply) = handshake.filter(b"\x1b[?1004h\x1b[");
        assert!(!reply);
        assert_eq!(first, b"\x1b[?1004h");
        let (second, reply) = handshake.filter(b"6nhello");
        assert!(reply);
        assert_eq!(second, b"hello");
    }

    #[test]
    fn answers_only_once() {
        let mut handshake = CursorHandshake::new();
        assert!(handshake.filter(b"\x1b[6n").1);
        let (out, reply) = handshake.filter(b"\x1b[6n");
        assert!(!reply);
        assert_eq!(out, b"\x1b[6n");
    }

    #[test]
    fn a_question_long_after_the_start_belongs_to_a_program() {
        let mut handshake = CursorHandshake::new();
        let filler = vec![b'x'; WINDOW];
        let (out, reply) = handshake.filter(&filler);
        assert!(!reply);
        assert_eq!(out.len(), WINDOW);
        let (out, reply) = handshake.filter(b"\x1b[6n");
        assert!(!reply);
        assert_eq!(out, b"\x1b[6n");
    }

    #[test]
    fn plain_output_passes_through_unchanged() {
        let mut handshake = CursorHandshake::new();
        let (out, reply) = handshake.filter(b"hello\r\n");
        assert!(!reply);
        assert_eq!(out, b"hello\r\n");
    }
}
