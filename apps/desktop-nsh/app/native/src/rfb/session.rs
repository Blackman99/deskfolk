//! One RFB connection: a buffer-and-commit parser (`pump`) over the bytes `feed` appends. A step
//! either consumes a whole message or says it needs more bytes and changes nothing.

use serde_json::{Value, json};

use super::decoders::{Decoders, Rect};
use super::protocol::*;
use super::tiles::Framebuffer;

/// A failure; `security` marks noVNC's "securityfailure" cases (so the UI can say wrong password).
pub struct Failure {
    pub reason: String,
    pub security: bool,
}

impl Failure {
    pub fn new(reason: impl Into<String>) -> Self {
        Failure { reason: reason.into(), security: false }
    }
}

impl From<String> for Failure {
    fn from(reason: String) -> Self {
        Failure::new(reason)
    }
}

pub enum Step {
    /// Consumed this many bytes.
    Done(usize),
    Need,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Phase {
    Version,
    Security,
    Auth,
    SecurityResult,
    SecurityReason { context: &'static str },
    ServerInit,
    Normal,
    Dead,
}

pub struct Session {
    pub(super) buf: Vec<u8>,
    pub(super) out: Vec<u8>,
    pub(super) events: Vec<Value>,
    pub(super) phase: Phase,
    /// 3, 7 or 8.
    pub(super) minor: u32,
    pub(super) scheme: u32,
    pub(super) credentials: Option<(String, String)>,
    pub(super) asked: bool,
    pub(super) seed: Option<Vec<u8>>,
    pub(super) fb: Framebuffer,
    pub(super) decoders: Decoders,
    pub(super) rects_remaining: u32,
    changed: bool,
}

impl Session {
    pub fn new() -> Self {
        Session {
            buf: Vec::new(),
            out: Vec::new(),
            events: Vec::new(),
            phase: Phase::Version,
            minor: 8,
            scheme: 0,
            credentials: None,
            asked: false,
            seed: None,
            fb: Framebuffer::empty(),
            decoders: Decoders::default(),
            rects_remaining: 0,
            changed: false,
        }
    }

    pub fn connected(&self) -> bool {
        self.phase == Phase::Normal
    }

    pub fn emit(&mut self, event: Value) {
        self.events.push(event);
    }

    pub fn fail(&mut self, f: Failure) {
        let mut e = json!({"type": "failed", "reason": f.reason});
        if f.security {
            e["securityFailure"] = json!(true);
        }
        self.emit(e);
        self.phase = Phase::Dead;
        self.buf.clear();
    }

    /// Appends bytes and parses; an empty slice means the transport ended.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Value> {
        if bytes.is_empty() {
            if self.phase != Phase::Dead {
                if self.phase == Phase::Normal {
                    self.emit(json!({"type": "closed"}));
                } else {
                    self.fail(Failure::new("The connection closed before the handshake finished"));
                }
                self.phase = Phase::Dead;
            }
            return std::mem::take(&mut self.events);
        }
        self.buf.extend_from_slice(bytes);
        self.pump()
    }

    pub fn pump(&mut self) -> Vec<Value> {
        let mut used = 0;
        while self.phase != Phase::Dead {
            match self.step(used) {
                Ok(Step::Done(n)) => used += n,
                Ok(Step::Need) => break,
                Err(f) => self.fail(f),
            }
        }
        self.buf.drain(..used.min(self.buf.len()));
        if self.phase == Phase::Dead {
            self.buf.clear();
        }
        if self.changed {
            self.changed = false;
            self.emit(json!({"type": "update"}));
        }
        std::mem::take(&mut self.events)
    }

    fn step(&mut self, used: usize) -> Result<Step, Failure> {
        // Work on the unconsumed tail; `pump` drains once at the end.
        let buf = std::mem::take(&mut self.buf);
        let r = self.step_on(&buf[used..]);
        self.buf = buf;
        r
    }

    fn step_on(&mut self, data: &[u8]) -> Result<Step, Failure> {
        match self.phase {
            Phase::Normal => self.normal(data),
            Phase::Dead => Ok(Step::Need),
            _ => self.init_step(data),
        }
    }

    fn normal(&mut self, data: &[u8]) -> Result<Step, Failure> {
        if self.rects_remaining > 0 {
            return self.rect(data);
        }
        let Some(&kind) = data.first() else { return Ok(Step::Need) };
        match kind {
            0 => {
                if data.len() < 4 {
                    return Ok(Step::Need);
                }
                self.rects_remaining = be16(data, 2) as u32;
                if self.rects_remaining == 0 {
                    self.finish_update();
                }
                Ok(Step::Done(4))
            }
            1 => {
                if data.len() < 6 {
                    return Ok(Step::Need);
                }
                let total = 6 + be16(data, 4) * 6;
                Ok(if data.len() < total { Step::Need } else { Step::Done(total) })
            }
            2 => {
                self.emit(json!({"type": "bell"}));
                Ok(Step::Done(1))
            }
            3 => {
                if data.len() < 8 {
                    return Ok(Step::Need);
                }
                let length = be32(data, 4) as i32;
                let size = length.unsigned_abs() as usize;
                if data.len() < 8 + size {
                    return Ok(Step::Need);
                }
                if length >= 0 {
                    let text: String = data[8..8 + size].iter().map(|&b| b as char).collect();
                    self.emit(json!({"type": "clipboard", "text": text}));
                }
                Ok(Step::Done(8 + size))
            }
            other => Err(Failure::new(format!("Unexpected server message (type {other})"))),
        }
    }

    /// noVNC asks for the next (incremental) update as soon as one is complete.
    fn finish_update(&mut self) {
        self.out.extend(update_request(true, self.fb.w, self.fb.h));
        self.changed = true;
    }

    fn rect(&mut self, data: &[u8]) -> Result<Step, Failure> {
        if data.len() < 12 {
            return Ok(Step::Need);
        }
        let (x, y, w, h) = (be16(data, 0), be16(data, 2), be16(data, 4), be16(data, 6));
        let encoding = be32(data, 8) as i32;
        let body = &data[12..];
        let used = match encoding {
            PSEUDO_DESKTOP_SIZE => {
                self.resize(w, h)?;
                0
            }
            PSEUDO_EXTENDED_DESKTOP_SIZE => {
                if body.len() < 4 {
                    return Ok(Step::Need);
                }
                let total = 4 + body[0] as usize * 16;
                if body.len() < total {
                    return Ok(Step::Need);
                }
                // x is the reason (1: we asked), y the status of our request: as noVNC, a refused
                // request of ours changes nothing.
                if !(x == 1 && y != 0) {
                    self.resize(w, h)?;
                }
                total
            }
            _ => {
                if x + w > self.fb.w || y + h > self.fb.h {
                    return Err(Failure::new("Error decoding rect: it lies outside the framebuffer"));
                }
                let rect = Rect { x, y, w, h };
                match self.decoders.decode(&mut self.fb, encoding, rect, body)? {
                    Some(n) => {
                        self.changed = true;
                        n
                    }
                    None => return Ok(Step::Need),
                }
            }
        };
        self.rects_remaining -= 1;
        if self.rects_remaining == 0 {
            self.finish_update();
        }
        Ok(Step::Done(12 + used))
    }

    pub(super) fn resize(&mut self, w: usize, h: usize) -> Result<(), Failure> {
        if w * h > (1 << 26) {
            return Err(Failure::new("The remote screen is too large"));
        }
        if (w, h) != (self.fb.w, self.fb.h) {
            self.fb.resize(w, h);
            if self.phase == Phase::Normal {
                self.changed = true;
                self.emit(json!({"type": "resized", "width": w, "height": h}));
            }
        }
        Ok(())
    }

    // Input from the user, sent only once connected.

    pub fn pointer(&mut self, x: f64, y: f64, buttons: f64) {
        if !self.connected() || self.fb.w == 0 || self.fb.h == 0 {
            return;
        }
        let x = (x.max(0.0) as usize).min(self.fb.w - 1) as u16;
        let y = (y.max(0.0) as usize).min(self.fb.h - 1) as u16;
        self.out.extend(pointer_event(x, y, buttons as u32 as u8));
    }

    pub fn key(&mut self, keysym: f64, down: bool) {
        if self.connected() {
            self.out.extend(key_event(keysym as u32, down));
        }
    }

    pub fn cut_text(&mut self, text: &str) {
        if self.connected() {
            self.out.extend(client_cut_text(text));
        }
    }

    pub fn request_update(&mut self, full: bool) {
        if self.connected() {
            self.out.extend(update_request(!full, self.fb.w, self.fb.h));
        }
    }
}
