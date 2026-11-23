//! A Mac's screens, one at a time. macOS Screen Sharing sends every screen of a Mac in one
//! framebuffer, the screens side by side as they are arranged; with three screens a phone shows
//! each at a sliver of its width. The Mac reports its screens when the client lists two of Apple's
//! pseudo-encodings (`APPLE_DISPLAY_INFO` and `APPLE_DISPLAY_LAYOUT`), as a one-rectangle update,
//! and takes `SetDisplay` to send one screen (or all of them again): the framebuffer becomes that
//! screen's own pixels.
//!
//! Measured on macOS 27 from a client that speaks plain RFB 3.8, as this one does:
//! - the layout arrives unasked once the encodings are listed, and again at every change;
//! - `SetDisplay` narrows the framebuffer, and the new size comes only in the layout, never as a
//!   DesktopSize rectangle;
//! - a layout drops the update requests the Mac was holding, so nothing more arrives until the
//!   client asks again, and then it must ask for the whole screen;
//! - a request sent right behind SetDisplay is not dropped: the Mac answers it after the switch,
//!   and a second whole screen follows the one asked for after the answering layout (2.4 frames,
//!   6.2 MB, where one 5K frame is 2.6 MB). So while an ask is out the client asks for nothing;
//!   the answering layout comes unasked, and the whole screen is asked for once after it. Should
//!   none come, the page asks for the whole screen itself after a few seconds (`asking`).
//!
//! The formats follow remotex's measured notes (`docs/apple-vnc-889.md`, github.com/andrewtheguy/remotex,
//! MIT); the code is this client's own.
//!
//! The page asks for one screen by default, the main one, or the one it was showing last.

use serde_json::{Value, json};

use super::protocol::*;
use super::session::{Failure, Session};

/// The layout's header after its `u16` length, and each screen's record.
const HEAD: usize = 0x14;
const RECORD: usize = 0x38;
/// Apple's own viewer takes at most this many screens.
const MOST: usize = 25;

/// One screen, where it is in the Mac's arrangement, in points (as System Settings shows it).
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    pub id: u32,
    pub main: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// The screen being sent; `None`: all of them.
    pub current: Option<u32>,
    /// The framebuffer's size in pixels, which follows the choice.
    pub width: usize,
    pub height: usize,
    pub displays: Vec<Display>,
}

/// Which screen the page wants.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Want {
    All,
    Main,
    Id(u32),
}

/// The layout's payload (after its `u16` length): the header, then a record per screen. Members of
/// a mirror set share an origin; only the first is kept, the rest are the same picture.
pub fn parse_layout(p: &[u8]) -> Result<Layout, String> {
    if p.len() < HEAD {
        return Err("The Mac's display layout is too short".into());
    }
    let count = be16(p, 0x12);
    if count == 0 || count > MOST || p.len() < HEAD + count * RECORD {
        return Err(format!("The Mac's display layout lists {count} displays in {} bytes", p.len()));
    }
    let current = match be32(p, 0x0a) {
        u32::MAX => None,
        id => Some(id),
    };
    let mut displays: Vec<Display> = Vec::new();
    for record in p[HEAD..HEAD + count * RECORD].chunks_exact(RECORD) {
        let signed = |at: usize| i32::from(i16::from_be_bytes([record[at], record[at + 1]]));
        // Edges, top, left, bottom, right.
        let (top, left, bottom, right) = (signed(0x14), signed(0x16), signed(0x18), signed(0x1a));
        let flags = be32(record, 0x24);
        let mirrored = flags & 0b10 != 0;
        if right <= left || bottom <= top || (mirrored && displays.iter().any(|d| (d.x, d.y) == (left, top))) {
            continue;
        }
        displays.push(Display {
            id: be32(record, 0x10),
            main: flags & 1 != 0,
            x: left,
            y: top,
            width: (right - left) as u32,
            height: (bottom - top) as u32,
        });
    }
    if displays.is_empty() {
        return Err("The Mac's display layout has no usable display".into());
    }
    Ok(Layout { current, width: be16(p, 6), height: be16(p, 8), displays })
}

impl Layout {
    /// The view to ask for: `None` is all the screens. With one screen there is nothing to choose,
    /// and the view stays as the Mac has it.
    pub fn target(&self, want: Want) -> Option<u32> {
        if self.displays.len() < 2 {
            return self.current;
        }
        let main = self.displays.iter().find(|d| d.main).unwrap_or(&self.displays[0]).id;
        match want {
            Want::All => None,
            Want::Main => Some(main),
            Want::Id(id) => Some(if self.displays.iter().any(|d| d.id == id) { id } else { main }),
        }
    }

    /// `asking`: a SetDisplay went out with this layout, and the picture waits for the answer.
    pub fn event(&self, asking: bool) -> Value {
        let displays: Vec<Value> = self
            .displays
            .iter()
            .map(|d| json!({"id": d.id, "main": d.main, "x": d.x, "y": d.y, "width": d.width, "height": d.height}))
            .collect();
        json!({"type": "displays", "current": self.current, "displays": displays, "asking": asking})
    }
}

impl Session {
    /// A layout from the Mac: take its framebuffer, say what it has, and ask for the screen the
    /// page wants when the Mac is sending another view.
    pub(super) fn on_layout(&mut self, payload: &[u8]) -> Result<(), Failure> {
        // The Mac dropped both pending update requests and auto-updates either way: ask for the
        // whole screen and re-enable auto-updates once the target view is in place.
        self.repaint = true;
        self.auto_updates = false;
        let layout = match parse_layout(payload) {
            Ok(layout) => layout,
            // One this client can't read is passed over rather than ending a session that showed
            // the screen before displays were asked for.
            Err(_) => return Ok(()),
        };
        // The Mac draws its next rectangles on this framebuffer, whichever view comes next.
        if layout.width > 0 && layout.height > 0 {
            self.resize(layout.width, layout.height)?;
        }
        let target = layout.target(self.want);
        let asking = if target == layout.current {
            self.display_asked = None;
            false
        } else if self.display_asked == Some(target) {
            // The Mac answered the ask with another view: shown as it is, not asked again until
            // the Mac's next change, so a refusal can't become a loop.
            self.display_asked = None;
            false
        } else {
            self.ask_display(target);
            true
        };
        self.emit(layout.event(asking));
        self.layout = Some(layout);
        Ok(())
    }

    fn ask_display(&mut self, target: Option<u32>) {
        self.out.extend(set_display(target));
        self.display_asked = Some(target);
        self.auto_updates = false;
    }

    /// The page's choice. Before the Mac's first layout it is only kept; after it, the Mac is asked
    /// at once and its answering layout brings the new picture. Whether it asked.
    pub fn select_display(&mut self, want: Want) -> bool {
        self.want = want;
        self.display_asked = None;
        if !self.connected() {
            return false;
        }
        let Some(layout) = &self.layout else { return false };
        let target = layout.target(want);
        if target == layout.current {
            return false;
        }
        self.ask_display(target);
        true
    }
}
