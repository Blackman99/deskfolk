//! A native RFB (VNC) client, ported from noVNC: the protocol, the password schemes and the
//! decoders, with no sockets. TSX owns the transport: it hands the bytes it reads to `feed`,
//! sends what `take_outgoing` returns, and paints the BMP tiles `dirty_tiles` returns.
//!
//! Left out of noVNC: the other security types (Tight, VeNCrypt, RA2, MSLogon, XVP, plain), the
//! UltraVNC repeater, TightPNG and the stand-alone JPEG and H.264 encodings, the cursor, desktop
//! name, fence, continuous-updates, QEMU, Xvp, LastRect and extended-clipboard/mouse-button
//! extensions, and 8/16-bit and colour-mapped pixel formats (we ask for 24-bit true colour as
//! noVNC does and read every pixel as four bytes).

#![allow(unknown_lints, clippy::chunks_exact_to_as_chunks)] // a style lint newer than most toolchains

mod auth;
mod decoders;
mod init;
mod inflate;
mod protocol;
mod session;
mod tiles;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_decoders;

use std::cell::RefCell;
use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use nsh_core::prelude::*;
use serde_json::{Value, json};

use session::Session;

thread_local! {
    static SESSIONS: RefCell<HashMap<String, Session>> = RefCell::new(HashMap::new());
}

fn with<T>(id: &str, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
    SESSIONS.with_borrow_mut(|s| s.get_mut(id).map(f))
}

fn json_string(events: Vec<Value>) -> String {
    Value::Array(events).to_string()
}

/// Remote screens over RFB.
#[module]
pub struct Screens;

#[module]
impl Screens {
    /// Starts session `id`, waiting for the server's version line.
    pub fn open(id: String) {
        SESSIONS.with_borrow_mut(|s| s.insert(id, Session::new()));
    }

    /// Appends bytes from the server and returns the events (a JSON array). An empty `bytes` says
    /// the transport ended (`closed`, or `failed` before the handshake finished).
    pub fn feed(id: String, bytes: Vec<u8>) -> String {
        json_string(with(&id, |s| s.feed(&bytes)).unwrap_or_default())
    }

    /// The bytes to send to the server since the last call.
    pub fn take_outgoing(id: String) -> Vec<u8> {
        with(&id, |s| std::mem::take(&mut s.out)).unwrap_or_default()
    }

    /// Answers a `credentials` event; returns the events this unblocks (a JSON array), those a
    /// later `feed` would otherwise carry.
    pub fn credentials(id: String, username: String, password: String) -> String {
        json_string(
            with(&id, |s| {
                s.credentials = Some((username, password));
                s.pump()
            })
            .unwrap_or_default(),
        )
    }

    /// Entropy (16 bytes or more) for the ARD key exchange; call before `credentials`.
    pub fn seed(id: String, bytes: Vec<u8>) {
        with(&id, |s| s.seed = Some(bytes));
    }

    /// Moves the pointer to (`x`, `y`) in framebuffer pixels (clamped) with the buttons held: bit 0 left, 1 middle, 2 right, 3 to 6 wheel up, down, left, right.
    pub fn pointer(id: String, x: f64, y: f64, buttons: f64) {
        with(&id, |s| s.pointer(x, y, buttons));
    }

    /// Presses or releases the X11 keysym `keysym`.
    pub fn key(id: String, keysym: f64, down: bool) {
        with(&id, |s| s.key(keysym, down));
    }

    /// Sends the clipboard text to the server (Latin-1).
    pub fn cut_text(id: String, text: String) {
        with(&id, |s| s.cut_text(&text));
    }

    /// Asks for the whole screen's next update, incremental unless `full`. (The client already asks after ServerInit and after each update.)
    pub fn request_update(id: String, full: bool) {
        with(&id, |s| s.request_update(full));
    }

    /// `[width, height]`, `[0, 0]` until connected.
    pub fn size(id: String) -> Vec<f64> {
        with(&id, |s| if s.connected() { vec![s.fb.w as f64, s.fb.h as f64] } else { vec![0.0, 0.0] })
            .unwrap_or_else(|| vec![0.0, 0.0])
    }

    /// The changed 256x256 tiles as `[{x, y, w, h, uri}]` (BMP data URLs); clears the changes.
    pub fn dirty_tiles(id: String) -> String {
        let tiles = with(&id, |s| s.fb.take_dirty()).unwrap_or_default();
        let tiles: Vec<Value> = tiles
            .into_iter()
            .map(|t| json!({"x": t.x, "y": t.y, "w": t.w, "h": t.h, "uri": format!("data:image/bmp;base64,{}", B64.encode(t.bmp))}))
            .collect();
        json_string(tiles)
    }

    /// Forgets session `id`.
    pub fn close(id: String) {
        SESSIONS.with_borrow_mut(|s| s.remove(&id));
    }
}
