//! The rect decoders (noVNC's `core/decoders`). Each one first *measures* the rect from its
//! prefix and returns `None` while the bytes are not all there; only a complete rect is applied,
//! so a short read never touches the framebuffer or a zlib stream.

mod simple;
mod tight;
mod zlib;

use super::inflate::Inflator;
use super::protocol::*;
use super::tiles::Framebuffer;

#[derive(Clone, Copy)]
pub struct Rect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// What persists between rects: zlib streams and hextile's colours.
#[derive(Default)]
pub struct Decoders {
    pub(super) zlib: Inflator,
    pub(super) zrle: Inflator,
    pub(super) tight: [Inflator; 4],
    pub(super) hextile: simple::HextileState,
}

/// Result of a decoder: `Ok(None)` needs more bytes, `Ok(Some(n))` consumed `n` bytes of `data`.
pub type Decoded = Result<Option<usize>, String>;

impl Decoders {
    pub fn decode(&mut self, fb: &mut Framebuffer, encoding: i32, r: Rect, data: &[u8]) -> Decoded {
        match encoding {
            ENC_RAW => simple::raw(fb, r, data),
            ENC_COPYRECT => simple::copy_rect(fb, r, data),
            ENC_RRE => simple::rre(fb, r, data),
            ENC_HEXTILE => simple::hextile(&mut self.hextile, fb, r, data),
            ENC_ZLIB => zlib::zlib(&mut self.zlib, fb, r, data),
            ENC_ZRLE => zlib::zrle(&mut self.zrle, fb, r, data),
            ENC_TIGHT => tight::tight(&mut self.tight, fb, r, data),
            other => Err(format!("Unsupported encoding (encoding: {other})")),
        }
    }
}
