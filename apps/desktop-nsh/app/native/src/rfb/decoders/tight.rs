//! Tight: fill, JPEG, and the basic compression (copy, palette and gradient filters) over four
//! zlib streams the server may reset per rect. TightPNG is not advertised, so is not decoded.

use super::{Decoded, Rect};
use crate::rfb::inflate::Inflator;
use crate::rfb::tiles::Framebuffer;

/// Where a rect's data sits, found without changing anything.
enum Body {
    Fill,
    Jpeg { data: (usize, usize) },
    Basic { stream: usize, filter: u8, palette: Vec<[u8; 3]>, data: (usize, usize), compressed: bool, size: usize },
}

/// A compact length (1 to 3 bytes) at `pos`: the length and the bytes it took.
fn compact_len(data: &[u8], pos: usize) -> Option<(usize, usize)> {
    let b0 = *data.get(pos)? as usize;
    let mut len = b0 & 0x7f;
    if b0 & 0x80 == 0 {
        return Some((len, 1));
    }
    let b1 = *data.get(pos + 1)? as usize;
    len |= (b1 & 0x7f) << 7;
    if b1 & 0x80 == 0 {
        return Some((len, 2));
    }
    let b2 = *data.get(pos + 2)? as usize;
    Some((len | (b2 << 14), 3))
}

/// `(ctl, body, total bytes)`; `Ok(None)` while incomplete.
fn measure(r: Rect, data: &[u8]) -> Result<Option<(u8, Body, usize)>, String> {
    let Some(&ctl) = data.first() else { return Ok(None) };
    let comp = ctl >> 4;
    let mut pos = 1;
    match comp {
        8 => Ok((data.len() >= 4).then_some((ctl, Body::Fill, 4))),
        9 => {
            let Some((len, n)) = compact_len(data, pos) else { return Ok(None) };
            pos += n;
            Ok((data.len() >= pos + len).then_some((ctl, Body::Jpeg { data: (pos, len) }, pos + len)))
        }
        10 => Err("PNG received in standard Tight rect".into()),
        c if c & 8 == 0 => {
            let mut filter = 0;
            if c & 4 != 0 {
                let Some(&f) = data.get(pos) else { return Ok(None) };
                filter = f;
                pos += 1;
            }
            let mut palette = Vec::new();
            let size = match filter {
                0 | 2 => r.w * r.h * 3,
                1 => {
                    let Some(&n) = data.get(pos) else { return Ok(None) };
                    let colors = n as usize + 1;
                    if colors < 2 {
                        return Err("Tight palette with a single colour".into());
                    }
                    let Some(p) = data.get(pos + 1..pos + 1 + colors * 3) else { return Ok(None) };
                    palette = p.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
                    pos += 1 + colors * 3;
                    let bits = if colors <= 2 { 1 } else { 8 };
                    (r.w * bits).div_ceil(8) * r.h
                }
                _ => return Err(format!("Illegal tight filter received (ctl: {filter})")),
            };
            let stream = (c & 3) as usize;
            if size == 0 {
                return Ok(Some((ctl, Body::Basic { stream, filter, palette, data: (pos, 0), compressed: false, size }, pos)));
            }
            if size < 12 {
                let ok = data.len() >= pos + size;
                return Ok(ok.then_some((ctl, Body::Basic { stream, filter, palette, data: (pos, size), compressed: false, size }, pos + size)));
            }
            let Some((len, n)) = compact_len(data, pos) else { return Ok(None) };
            pos += n;
            let ok = data.len() >= pos + len;
            Ok(ok.then_some((ctl, Body::Basic { stream, filter, palette, data: (pos, len), compressed: true, size }, pos + len)))
        }
        other => Err(format!("Illegal tight compression received (ctl: {other})")),
    }
}

pub fn tight(streams: &mut [Inflator; 4], fb: &mut Framebuffer, r: Rect, data: &[u8]) -> Decoded {
    let Some((ctl, body, total)) = measure(r, data)? else { return Ok(None) };
    for (i, s) in streams.iter_mut().enumerate() {
        if (ctl >> i) & 1 == 1 {
            s.reset();
        }
    }
    match body {
        Body::Fill => fb.fill_rect(r.x, r.y, r.w, r.h, [data[1], data[2], data[3]]),
        Body::Jpeg { data: (at, len) } => draw_jpeg(fb, r, &data[at..at + len])?,
        Body::Basic { stream, filter, palette, data: (at, len), compressed, size } => {
            if size == 0 {
                return Ok(Some(total));
            }
            let raw;
            let pixels: &[u8] = if compressed {
                raw = streams[stream].inflate_all(&data[at..at + len], size)?;
                if raw.len() < size {
                    return Err("Tight rect shorter than its size".into());
                }
                &raw[..size]
            } else {
                &data[at..at + len]
            };
            match filter {
                0 => fb.blit_rgb(r.x, r.y, r.w, r.h, pixels),
                1 => draw_palette(fb, r, pixels, &palette),
                _ => fb.blit_rgb(r.x, r.y, r.w, r.h, &gradient(pixels, r.w, r.h)),
            }
        }
    }
    Ok(Some(total))
}

fn draw_palette(fb: &mut Framebuffer, r: Rect, indices: &[u8], palette: &[[u8; 3]]) {
    let mut rgb = Vec::with_capacity(r.w * r.h * 3);
    let mono = palette.len() == 2;
    let row_size = if mono { r.w.div_ceil(8) } else { r.w };
    for y in 0..r.h {
        for x in 0..r.w {
            let i = if mono { (indices[y * row_size + x / 8] >> (7 - x % 8)) & 1 } else { indices[y * row_size + x] } as usize;
            rgb.extend_from_slice(palette.get(i).unwrap_or(&[0, 0, 0]));
        }
    }
    fb.blit_rgb(r.x, r.y, r.w, r.h, &rgb);
}

/// Undoes the gradient filter: each byte is the difference from left + upper - upper-left, clamped.
fn gradient(data: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let at = (y * w + x) * 3 + c;
                let left = if x > 0 { out[at - 3] as i32 } else { 0 };
                let upper = if y > 0 { out[at - w * 3] as i32 } else { 0 };
                let upper_left = if x > 0 && y > 0 { out[at - w * 3 - 3] as i32 } else { 0 };
                let prediction = (left + upper - upper_left).clamp(0, 255) as u8;
                out[at] = data[at].wrapping_add(prediction);
            }
        }
    }
    out
}

fn draw_jpeg(fb: &mut Framebuffer, r: Rect, jpeg: &[u8]) -> Result<(), String> {
    use jpeg_decoder::{Decoder, PixelFormat};
    let mut decoder = Decoder::new(jpeg);
    let pixels = decoder.decode().map_err(|e| format!("Error decoding rect: JPEG: {e}"))?;
    let info = decoder.info().ok_or("JPEG without a header")?;
    let (w, h) = (info.width as usize, info.height as usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    match info.pixel_format {
        PixelFormat::RGB24 => pixels.chunks_exact(3).for_each(|p| rgba.extend_from_slice(&[p[0], p[1], p[2], 255])),
        PixelFormat::L8 => pixels.iter().for_each(|&l| rgba.extend_from_slice(&[l, l, l, 255])),
        PixelFormat::L16 => pixels.chunks_exact(2).for_each(|p| rgba.extend_from_slice(&[p[0], p[0], p[0], 255])),
        PixelFormat::CMYK32 => return Err("Error decoding rect: CMYK JPEG".into()),
    }
    // Draw at the image's own size, no further than the rect.
    let (dw, dh) = (w.min(r.w), h.min(r.h));
    if dw == w {
        fb.blit(r.x, r.y, dw, dh, &rgba[..dw * dh * 4]);
    } else {
        let mut cropped = Vec::with_capacity(dw * dh * 4);
        for row in 0..dh {
            cropped.extend_from_slice(&rgba[row * w * 4..(row * w + dw) * 4]);
        }
        fb.blit(r.x, r.y, dw, dh, &cropped);
    }
    Ok(())
}
