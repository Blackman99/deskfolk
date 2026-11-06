//! One terminal of the runtime, held natively: the screen state (`alacritty_terminal`) fed by the
//! runtime's byte stream, and the writes back (keys, size). Attaching follows the messenger's
//! `TerminalView.svelte`: the sync socket first, then `screen` (a replay of what shows), then
//! `watch` from its offset; stream frames carry the rest, deduplicated by offset.
//!
//! Its own socket and HTTP calls, on threads of its own: the bytes never pass through the app's JS.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::Deserialize;
use serde_json::json;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub rows: usize,
    pub cols: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Where the runtime listens and how to authenticate.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

/// What the view hears from the session (on the session's threads).
pub trait Observer: Send + Sync + 'static {
    /// The screen changed: draw again.
    fn changed(&self);
    /// The screen was replayed at the runtime's size: fit it to the view.
    fn attached(&self, size: Size);
    fn exited(&self);
    fn failed(&self, message: String);
}

/// Answers the program's queries (device attributes, cursor position) back into the pty.
#[derive(Clone)]
pub struct Replies(Sender<Command>);

impl EventListener for Replies {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(text) = event {
            let _ = self.0.send(Command::Input(text.into_bytes()));
        }
    }
}

pub enum Command {
    Input(Vec<u8>),
    Resize(Size),
}

pub struct Shared {
    pub term: FairMutex<Term<Replies>>,
    stop: AtomicBool,
}

pub struct Session {
    pub shared: Arc<Shared>,
    commands: Sender<Command>,
}

impl Session {
    pub fn start(endpoint: Endpoint, id: String, observer: Arc<dyn Observer>) -> Session {
        let (commands, rx) = mpsc::channel();
        let config = Config { scrolling_history: 10_000, ..Config::default() };
        let term = Term::new(config, &Size { rows: 24, cols: 80 }, Replies(commands.clone()));
        let shared = Arc::new(Shared { term: FairMutex::new(term), stop: AtomicBool::new(false) });
        let agent = agent();
        {
            let (shared, endpoint, id, observer) = (shared.clone(), endpoint.clone(), id.clone(), observer.clone());
            std::thread::Builder::new()
                .name(format!("terminal-read-{id}"))
                .spawn(move || {
                    if let Err(why) = read(&shared, &endpoint, &id, &*observer, &agent) {
                        if !shared.stop.load(Ordering::Relaxed) {
                            observer.failed(why);
                        }
                    }
                })
                .expect("a thread");
        }
        {
            let agent = self::agent();
            std::thread::Builder::new()
                .name(format!("terminal-write-{id}"))
                .spawn(move || write(rx, &endpoint, &id, &agent))
                .expect("a thread");
        }
        Session { shared, commands }
    }

    pub fn input(&self, bytes: Vec<u8>) {
        if !bytes.is_empty() {
            let _ = self.commands.send(Command::Input(bytes));
        }
    }

    /// Resizes the screen here and the pty there.
    pub fn resize(&self, size: Size) {
        let mut term = self.shared.term.lock();
        if term.screen_lines() == size.rows && term.columns() == size.cols {
            return;
        }
        term.resize(size);
        drop(term);
        let _ = self.commands.send(Command::Resize(size));
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

/// An HTTP client for the loopback runtime that ignores the environment's proxies.
fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .proxy(None)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .new_agent()
}

#[derive(Deserialize)]
struct Screen {
    offset: u64,
    data: String,
    rows: usize,
    cols: usize,
}

#[derive(Deserialize)]
struct Frame {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    data: String,
    #[serde(default)]
    closed: bool,
}

/// Bytes of a frame not seen yet: `None` when the whole frame was. `next` is the offset the
/// screen has reached.
pub fn unseen(next: u64, offset: u64, bytes: &[u8]) -> Option<&[u8]> {
    let end = offset + bytes.len() as u64;
    if end <= next {
        None
    } else if offset >= next {
        Some(bytes)
    } else {
        Some(&bytes[(next - offset) as usize..])
    }
}

fn read(shared: &Shared, endpoint: &Endpoint, id: &str, observer: &dyn Observer, agent: &ureq::Agent) -> Result<(), String> {
    let base = format!("http://127.0.0.1:{}", endpoint.port);
    let auth = format!("Bearer {}", endpoint.token);
    let (mut socket, _) = tungstenite::connect(format!("ws://127.0.0.1:{}/v1/events", endpoint.port))
        .map_err(|e| format!("cannot reach the runtime: {e}"))?;
    socket
        .send(Message::text(json!({ "type": "auth", "token": endpoint.token, "protocol": "sync-v1" }).to_string()))
        .map_err(|e| e.to_string())?;
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    }

    let screen: Screen = agent
        .get(format!("{base}/v1/terminals/{id}/screen"))
        .header("Authorization", &auth)
        .call()
        .map_err(|e| format!("cannot read the terminal: {e}"))?
        .into_body()
        .read_json()
        .map_err(|e| e.to_string())?;
    let size = Size { rows: screen.rows.max(1), cols: screen.cols.max(1) };
    let mut parser: Processor = Processor::new();
    {
        let mut term = shared.term.lock();
        term.resize(size);
        let bytes = B64.decode(screen.data.as_bytes()).unwrap_or_default();
        parser.advance(&mut *term, &bytes);
    }
    let mut next = screen.offset;
    observer.attached(size);
    observer.changed();
    agent
        .post(format!("{base}/v1/terminals/{id}/watch"))
        .header("Authorization", &auth)
        .send_json(json!({ "from": next }))
        .map_err(|e| format!("cannot watch the terminal: {e}"))?;

    while !shared.stop.load(Ordering::Relaxed) {
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => continue,
            Err(e) => return Err(format!("the runtime closed the connection: {e}")),
        };
        let Message::Text(text) = message else { continue };
        let Ok(frame) = serde_json::from_str::<Frame>(&text) else { continue };
        if frame.kind != "stream" || frame.id != id {
            continue;
        }
        let bytes = B64.decode(frame.data.as_bytes()).unwrap_or_default();
        if let Some(fresh) = unseen(next, frame.offset, &bytes) {
            let mut term = shared.term.lock();
            parser.advance(&mut *term, fresh);
            drop(term);
            next = frame.offset + bytes.len() as u64;
            observer.changed();
        }
        if frame.closed {
            observer.exited();
            break;
        }
    }
    let _ = close(socket);
    Ok(())
}

fn close(mut socket: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) -> Result<(), tungstenite::Error> {
    socket.close(None)?;
    socket.flush()
}

/// Writes keys and sizes in the order they were made; a keystroke carries no request receipt.
fn write(rx: Receiver<Command>, endpoint: &Endpoint, id: &str, agent: &ureq::Agent) {
    let base = format!("http://127.0.0.1:{}", endpoint.port);
    let auth = format!("Bearer {}", endpoint.token);
    while let Ok(command) = rx.recv() {
        let result = match command {
            Command::Input(mut bytes) => {
                // Whatever else is queued goes in the same request: a paste or fast typing.
                while let Ok(Command::Input(more)) = rx.try_recv() {
                    bytes.extend(more);
                }
                agent
                    .post(format!("{base}/v1/terminals/{id}/input"))
                    .header("Authorization", &auth)
                    .send_json(json!({ "data": B64.encode(&bytes) }))
            }
            Command::Resize(size) => agent
                .post(format!("{base}/v1/terminals/{id}/resize"))
                .header("Authorization", &auth)
                .send_json(json!({ "rows": size.rows, "cols": size.cols })),
        };
        if let Err(e) = result {
            log::warn!("terminal {id}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_already_on_screen_are_dropped_and_overlaps_trimmed() {
        assert_eq!(unseen(10, 0, b"0123456789"), None);
        assert_eq!(unseen(10, 5, b"56789abc"), Some(&b"abc"[..]));
        assert_eq!(unseen(10, 10, b"abc"), Some(&b"abc"[..]));
        // A gap (the ring dropped bytes): what came is shown anyway.
        assert_eq!(unseen(10, 20, b"xyz"), Some(&b"xyz"[..]));
    }

    #[test]
    fn the_screen_answers_queries_back_into_the_pty() {
        let (tx, rx) = mpsc::channel();
        let mut term = Term::new(Config::default(), &Size { rows: 4, cols: 10 }, Replies(tx));
        let mut parser: Processor = Processor::new();
        // Primary device attributes.
        parser.advance(&mut term, b"\x1b[c");
        let Ok(Command::Input(answer)) = rx.try_recv() else { panic!("no answer") };
        assert!(answer.starts_with(b"\x1b[?"));
    }
}
