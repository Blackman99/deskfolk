//! The framebuffer (RGBA) and the 256x256 tile grid that tells the UI what changed.

pub const TILE: usize = 256;

/// A changed tile, encoded for the UI.
pub struct DirtyTile {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    pub bmp: Vec<u8>,
}

pub struct Framebuffer {
    pub w: usize,
    pub h: usize,
    pub rgba: Vec<u8>,
    dirty: Vec<bool>,
    tiles_x: usize,
    tiles_y: usize,
}

impl Framebuffer {
    pub fn empty() -> Self {
        Framebuffer { w: 0, h: 0, rgba: Vec::new(), dirty: Vec::new(), tiles_x: 0, tiles_y: 0 }
    }

    /// Resizes, keeping what overlaps at the top left (as noVNC's display does) and dirtying every tile.
    pub fn resize(&mut self, w: usize, h: usize) {
        let mut rgba = vec![0u8; w * h * 4];
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
        let (cw, ch) = (self.w.min(w), self.h.min(h));
        for y in 0..ch {
            rgba[y * w * 4..(y * w + cw) * 4].copy_from_slice(&self.rgba[y * self.w * 4..(y * self.w + cw) * 4]);
        }
        self.w = w;
        self.h = h;
        self.rgba = rgba;
        self.tiles_x = w.div_ceil(TILE);
        self.tiles_y = h.div_ceil(TILE);
        self.dirty = vec![true; self.tiles_x * self.tiles_y];
    }

    /// Marks the tiles a (clipped) rectangle touches.
    pub fn mark(&mut self, x: usize, y: usize, w: usize, h: usize) {
        if w == 0 || h == 0 || x >= self.w || y >= self.h {
            return;
        }
        let x1 = (x + w).min(self.w);
        let y1 = (y + h).min(self.h);
        for ty in y / TILE..=(y1 - 1) / TILE {
            for tx in x / TILE..=(x1 - 1) / TILE {
                self.dirty[ty * self.tiles_x + tx] = true;
            }
        }
    }

    /// Clips a rectangle to the framebuffer; `None` when nothing is left.
    fn clip(&self, x: usize, y: usize, w: usize, h: usize) -> Option<(usize, usize, usize, usize)> {
        if x >= self.w || y >= self.h || w == 0 || h == 0 {
            return None;
        }
        Some((x, y, w.min(self.w - x), h.min(self.h - y)))
    }

    pub fn fill_rect(&mut self, x: usize, y: usize, w: usize, h: usize, rgb: [u8; 3]) {
        let Some((x, y, cw, ch)) = self.clip(x, y, w, h) else { return };
        for row in y..y + ch {
            for px in self.rgba[(row * self.w + x) * 4..(row * self.w + x + cw) * 4].chunks_exact_mut(4) {
                px[..3].copy_from_slice(&rgb);
                px[3] = 255;
            }
        }
        self.mark(x, y, cw, ch);
    }

    /// Draws RGBA pixels (`w` wide, `h` high); the alpha is forced opaque.
    pub fn blit(&mut self, x: usize, y: usize, w: usize, h: usize, data: &[u8]) {
        if data.len() < w * h * 4 {
            return;
        }
        let Some((x, y, cw, ch)) = self.clip(x, y, w, h) else { return };
        for row in 0..ch {
            let src = &data[row * w * 4..(row * w + cw) * 4];
            let dst = &mut self.rgba[((y + row) * self.w + x) * 4..((y + row) * self.w + x + cw) * 4];
            dst.copy_from_slice(src);
            for px in dst.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }
        self.mark(x, y, cw, ch);
    }

    /// Draws tightly packed RGB pixels.
    pub fn blit_rgb(&mut self, x: usize, y: usize, w: usize, h: usize, rgb: &[u8]) {
        if rgb.len() < w * h * 3 {
            return;
        }
        let mut rgba = Vec::with_capacity(w * h * 4);
        for px in rgb[..w * h * 3].chunks_exact(3) {
            rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
        }
        self.blit(x, y, w, h, &rgba);
    }

    pub fn copy_rect(&mut self, sx: usize, sy: usize, dx: usize, dy: usize, w: usize, h: usize) {
        if sx >= self.w || sy >= self.h || dx >= self.w || dy >= self.h {
            return;
        }
        let w = w.min(self.w - sx).min(self.w - dx);
        let h = h.min(self.h - sy).min(self.h - dy);
        if w == 0 || h == 0 {
            return;
        }
        let mut region = Vec::with_capacity(w * h * 4);
        for row in 0..h {
            region.extend_from_slice(&self.rgba[((sy + row) * self.w + sx) * 4..((sy + row) * self.w + sx + w) * 4]);
        }
        for row in 0..h {
            self.rgba[((dy + row) * self.w + dx) * 4..((dy + row) * self.w + dx + w) * 4]
                .copy_from_slice(&region[row * w * 4..(row + 1) * w * 4]);
        }
        self.mark(dx, dy, w, h);
    }

    /// The tiles changed since the last call, as BMPs; clears the dirty set.
    pub fn take_dirty(&mut self) -> Vec<DirtyTile> {
        let mut out = Vec::new();
        for ty in 0..self.tiles_y {
            for tx in 0..self.tiles_x {
                let slot = ty * self.tiles_x + tx;
                if !self.dirty[slot] {
                    continue;
                }
                self.dirty[slot] = false;
                let (x, y) = (tx * TILE, ty * TILE);
                let (w, h) = (TILE.min(self.w - x), TILE.min(self.h - y));
                out.push(DirtyTile { x, y, w, h, bmp: self.encode_bmp(x, y, w, h) });
            }
        }
        out
    }

    /// 14-byte file header, 40-byte BITMAPINFOHEADER, 32bpp BGRA rows top-down (negative height).
    fn encode_bmp(&self, x: usize, y: usize, w: usize, h: usize) -> Vec<u8> {
        let image = w * h * 4;
        let mut bmp = Vec::with_capacity(54 + image);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&((54 + image) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&(w as i32).to_le_bytes());
        bmp.extend_from_slice(&(-(h as i32)).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&32u16.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&(image as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 16]);
        for row in y..y + h {
            for px in self.rgba[(row * self.w + x) * 4..(row * self.w + x + w) * 4].chunks_exact(4) {
                bmp.extend_from_slice(&[px[2], px[1], px[0], 255]);
            }
        }
        bmp
    }
}
