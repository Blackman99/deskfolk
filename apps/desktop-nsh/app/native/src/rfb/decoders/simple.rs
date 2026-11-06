//! Raw, CopyRect, RRE and Hextile. Pixels arrive as the bytes R, G, B, X.

use super::{Decoded, Rect};
use crate::rfb::protocol::{be16, be32};
use crate::rfb::tiles::Framebuffer;

pub fn raw(fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    let size = r.w * r.h * 4;
    if data.len() < size {
        return Ok(None);
    }
    fb.blit(r.x, r.y, r.w, r.h, &data[..size]);
    Ok(Some(size))
}

pub fn copy_rect(fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    if data.len() < 4 {
        return Ok(None);
    }
    fb.copy_rect(be16(data, 0), be16(data, 2), r.x, r.y, r.w, r.h);
    Ok(Some(4))
}

pub fn rre(fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    if data.len() < 8 {
        return Ok(None);
    }
    let subrects = be32(data, 0) as usize;
    if subrects > (1 << 24) {
        return Err("RRE rect with an absurd number of subrects".into());
    }
    let total = 8 + subrects * 12;
    if data.len() < total {
        return Ok(None);
    }
    fb.fill_rect(r.x, r.y, r.w, r.h, [data[4], data[5], data[6]]);
    for s in data[8..total].chunks_exact(12) {
        fb.fill_rect(r.x + be16(s, 4), r.y + be16(s, 6), be16(s, 8), be16(s, 10), [s[0], s[1], s[2]]);
    }
    Ok(Some(total))
}

/// Hextile's colours and last sub-encoding carry over from rect to rect, as in noVNC.
#[derive(Default)]
pub struct HextileState {
    background: [u8; 4],
    foreground: [u8; 4],
    last: u8,
}

pub fn hextile(st: &mut HextileState, fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    let Some(total) = walk_hextile(None, fb, r, data)? else { return Ok(None) };
    walk_hextile(Some(st), fb, r, data)?;
    Ok(Some(total))
}

/// Walks the tiles; with a state it draws, without one it only measures.
fn walk_hextile(mut st: Option<&mut HextileState>, fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    let (tiles_x, tiles_y) = (r.w.div_ceil(16), r.h.div_ceil(16));
    let mut pos = 0;
    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let Some(&sub) = data.get(pos) else { return Ok(None) };
            if sub > 30 {
                return Err(format!("Illegal hextile subencoding (subencoding: {sub})"));
            }
            pos += 1;
            let (x, y) = (r.x + tx * 16, r.y + ty * 16);
            let (w, h) = (16.min(r.x + r.w - x), 16.min(r.y + r.h - y));
            if sub & 1 != 0 {
                let size = w * h * 4;
                if data.len() < pos + size {
                    return Ok(None);
                }
                if st.is_some() {
                    fb.blit(x, y, w, h, &data[pos..pos + size]);
                }
                pos += size;
            } else {
                let mut bg = None;
                let mut fg = None;
                if sub & 2 != 0 {
                    let Some(c) = data.get(pos..pos + 4) else { return Ok(None) };
                    bg = Some([c[0], c[1], c[2], c[3]]);
                    pos += 4;
                }
                if sub & 4 != 0 {
                    let Some(c) = data.get(pos..pos + 4) else { return Ok(None) };
                    fg = Some([c[0], c[1], c[2], c[3]]);
                    pos += 4;
                }
                let mut subrects = 0usize;
                if sub & 8 != 0 {
                    let Some(&n) = data.get(pos) else { return Ok(None) };
                    subrects = n as usize;
                    pos += 1;
                }
                let coloured = sub & 0x10 != 0;
                let size = subrects * if coloured { 6 } else { 2 };
                if data.len() < pos + size {
                    return Ok(None);
                }
                if let Some(st) = st.as_deref_mut() {
                    if let Some(c) = bg {
                        st.background = c;
                    }
                    if let Some(c) = fg {
                        st.foreground = c;
                    }
                    if sub == 0 {
                        // noVNC: a blank tile after a raw one is left alone.
                        if st.last & 1 == 0 {
                            fb.fill_rect(x, y, w, h, [st.background[0], st.background[1], st.background[2]]);
                        }
                    } else {
                        draw_hextile(st, fb, (x, y, w, h), &data[pos..pos + size], subrects, coloured);
                    }
                }
                pos += size;
            }
            if let Some(st) = st.as_deref_mut() {
                st.last = sub;
            }
        }
    }
    Ok(Some(pos))
}

fn draw_hextile(st: &HextileState, fb: &mut Framebuffer, tile: (usize, usize, usize, usize), subs: &[u8], count: usize, coloured: bool) {
    let (x, y, w, h) = tile;
    fb.fill_rect(x, y, w, h, [st.background[0], st.background[1], st.background[2]]);
    let step = if coloured { 6 } else { 2 };
    for s in subs.chunks_exact(step).take(count) {
        let (color, xy, wh) = if coloured { ([s[0], s[1], s[2]], s[4], s[5]) } else { ([st.foreground[0], st.foreground[1], st.foreground[2]], s[0], s[1]) };
        let (sx, sy) = ((xy >> 4) as usize, (xy & 15) as usize);
        let (sw, sh) = ((wh >> 4) as usize + 1, (wh & 15) as usize + 1);
        if sx < w && sy < h {
            fb.fill_rect(x + sx, y + sy, sw.min(w - sx), sh.min(h - sy), color);
        }
    }
}
