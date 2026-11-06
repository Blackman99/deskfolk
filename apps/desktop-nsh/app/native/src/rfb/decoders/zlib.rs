//! Zlib (raw pixels in one zlib stream) and ZRLE (tiled, palettes, run lengths, in one zlib stream).

use super::{Decoded, Rect};
use crate::rfb::inflate::Inflator;
use crate::rfb::protocol::be32;
use crate::rfb::tiles::Framebuffer;

const MAX_PAYLOAD: usize = 1 << 28;

/// The 4-byte length prefix and the payload behind it.
fn payload(data: &[u8]) -> Result<Option<(&[u8], usize)>, String> {
    if data.len() < 4 {
        return Ok(None);
    }
    let len = be32(data, 0) as usize;
    if len > MAX_PAYLOAD {
        return Err("compressed rect too large".into());
    }
    Ok(data.get(4..4 + len).map(|p| (p, 4 + len)))
}

pub fn zlib(stream: &mut Inflator, fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    if r.w == 0 || r.h == 0 {
        return Ok(Some(0));
    }
    let Some((payload, used)) = payload(data)? else { return Ok(None) };
    let size = r.w * r.h * 4;
    let pixels = stream.inflate_all(payload, size)?;
    if pixels.len() < size {
        return Err("zlib rect shorter than its size".into());
    }
    fb.blit(r.x, r.y, r.w, r.h, &pixels[..size]);
    Ok(Some(used))
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn byte(&mut self) -> Result<u8, String> {
        let b = *self.data.get(self.pos).ok_or("ZRLE data ended early")?;
        self.pos += 1;
        Ok(b)
    }

    /// `n` CPIXELs (3 bytes each) as RGBA.
    fn pixels(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let bytes = self.data.get(self.pos..self.pos + n * 3).ok_or("ZRLE data ended early")?;
        self.pos += n * 3;
        let mut out = Vec::with_capacity(n * 4);
        for p in bytes.chunks_exact(3) {
            out.extend_from_slice(&[p[0], p[1], p[2], 255]);
        }
        Ok(out)
    }

    fn run_length(&mut self) -> Result<usize, String> {
        let mut len = 0;
        loop {
            let b = self.byte()?;
            len += b as usize;
            if b != 255 {
                return Ok(len + 1);
            }
        }
    }
}

pub fn zrle(stream: &mut Inflator, fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    let Some((payload, used)) = payload(data)? else { return Ok(None) };
    let tiles = r.w.div_ceil(64) * r.h.div_ceil(64);
    let raw = stream.inflate_all(payload, r.w * r.h * 4 + tiles * 128 + 1024)?;
    let mut c = Cursor { data: &raw, pos: 0 };
    for ty in (r.y..r.y + r.h).step_by(64) {
        let th = 64.min(r.y + r.h - ty);
        for tx in (r.x..r.x + r.w).step_by(64) {
            let tw = 64.min(r.x + r.w - tx);
            let size = tw * th;
            let sub = c.byte()?;
            let pixels = match sub {
                0 => c.pixels(size)?,
                1 => {
                    let p = c.pixels(1)?;
                    fb.fill_rect(tx, ty, tw, th, [p[0], p[1], p[2]]);
                    continue;
                }
                2..=16 => packed_palette(&mut c, sub as usize, tw, th)?,
                128 => {
                    let mut out = Vec::with_capacity(size * 4);
                    while out.len() < size * 4 {
                        let p = c.pixels(1)?;
                        let len = c.run_length()?;
                        if out.len() + len * 4 > size * 4 {
                            return Err("ZRLE run past the tile".into());
                        }
                        for _ in 0..len {
                            out.extend_from_slice(&p);
                        }
                    }
                    out
                }
                130..=255 => rle_palette(&mut c, sub as usize - 128, size)?,
                other => return Err(format!("Unknown subencoding: {other}")),
            };
            fb.blit(tx, ty, tw, th, &pixels);
        }
    }
    Ok(Some(used))
}

fn packed_palette(c: &mut Cursor, colors: usize, w: usize, h: usize) -> Result<Vec<u8>, String> {
    let palette = c.pixels(colors)?;
    let bits = if colors <= 2 { 1 } else if colors <= 4 { 2 } else { 4 };
    let mask = (1u8 << bits) - 1;
    let mut out = Vec::with_capacity(w * h * 4);
    for _ in 0..h {
        let mut byte = 0;
        let mut shift: i32 = -1;
        for _ in 0..w {
            if shift < 0 {
                byte = c.byte()?;
                shift = 8 - bits;
            }
            let index = ((byte >> shift) & mask) as usize;
            out.extend_from_slice(palette.get(index * 4..index * 4 + 4).ok_or("ZRLE palette index out of range")?);
            shift -= bits;
        }
    }
    Ok(out)
}

fn rle_palette(c: &mut Cursor, colors: usize, size: usize) -> Result<Vec<u8>, String> {
    let palette = c.pixels(colors)?;
    let mut out = Vec::with_capacity(size * 4);
    while out.len() < size * 4 {
        let mut index = c.byte()? as usize;
        let mut len = 1;
        if index >= 128 {
            index -= 128;
            len = c.run_length()?;
        }
        let color = palette.get(index * 4..index * 4 + 4).ok_or("ZRLE palette index out of range")?;
        if out.len() + len * 4 > size * 4 {
            return Err("ZRLE run past the tile".into());
        }
        for _ in 0..len {
            out.extend_from_slice(color);
        }
    }
    Ok(out)
}
