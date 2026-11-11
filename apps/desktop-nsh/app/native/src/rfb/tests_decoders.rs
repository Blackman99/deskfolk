//! Every decoder on small hand-built rects. Each is fed whole and byte by byte; the byte-by-byte
//! run proves the need-more path touches neither the framebuffer nor a zlib stream.

use miniz_oxide::MZFlush;
use miniz_oxide::deflate::core::{CompressorOxide, create_comp_flags_from_zip_params};
use miniz_oxide::deflate::stream::deflate;

use super::session::Session;
use super::tests::connected;

/// A zlib stream that continues across calls, each ending in a sync flush (as servers send).
struct Deflater(CompressorOxide);

impl Deflater {
    fn new() -> Self {
        Deflater(CompressorOxide::new(create_comp_flags_from_zip_params(6, 15, 0)))
    }

    fn sync(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 1 << 16];
        let r = deflate(&mut self.0, data, &mut out, MZFlush::Sync);
        assert_eq!(r.bytes_consumed, data.len());
        out.truncate(r.bytes_written);
        out
    }
}

fn rect(x: u16, y: u16, w: u16, h: u16, enc: i32, body: &[u8]) -> Vec<u8> {
    let mut m = Vec::new();
    for v in [x, y, w, h] {
        m.extend(v.to_be_bytes());
    }
    m.extend(enc.to_be_bytes());
    m.extend(body);
    m
}

fn update(rects: &[Vec<u8>]) -> Vec<u8> {
    let mut m = vec![0, 0];
    m.extend((rects.len() as u16).to_be_bytes());
    for r in rects {
        m.extend(r);
    }
    m
}

fn lengthed(data: &[u8]) -> Vec<u8> {
    let mut m = (data.len() as u32).to_be_bytes().to_vec();
    m.extend(data);
    m
}

fn px(s: &Session, x: usize, y: usize) -> [u8; 3] {
    let i = (y * s.fb.w + x) * 4;
    assert_eq!(s.fb.rgba[i + 3], 255);
    [s.fb.rgba[i], s.fb.rgba[i + 1], s.fb.rgba[i + 2]]
}

/// Runs `setup` on two fresh sessions; feeds `bytes` whole to one and one byte at a time to the
/// other; they must agree, and no failure may happen. Returns the byte-wise one.
fn run(w: u16, h: u16, bytes: &[u8]) -> Session {
    let mut whole = connected(w, h);
    let ev = whole.feed(bytes);
    assert!(ev.iter().all(|e| e["type"] != "failed"), "{ev:?}");
    let mut stepwise = connected(w, h);
    for b in bytes {
        let ev = stepwise.feed(&[*b]);
        assert!(ev.iter().all(|e| e["type"] != "failed"), "{ev:?}");
    }
    assert_eq!(whole.fb.rgba, stepwise.fb.rgba);
    assert_eq!(whole.rects_remaining, 0);
    assert_eq!(whole.out, stepwise.out);
    stepwise
}

fn fails(w: u16, h: u16, bytes: &[u8]) -> String {
    let mut s = connected(w, h);
    let ev = s.feed(bytes);
    assert_eq!(ev[0]["type"], "failed", "{ev:?}");
    ev[0]["reason"].as_str().unwrap().to_owned()
}

#[test]
fn raw() {
    let mut body = Vec::new();
    for i in 0..6u8 {
        body.extend([i, i + 1, i + 2, 77]); // the fourth byte is ignored
    }
    let s = run(10, 10, &update(&[rect(2, 3, 3, 2, 0, &body)]));
    assert_eq!(px(&s, 2, 3), [0, 1, 2]);
    assert_eq!(px(&s, 4, 3), [2, 3, 4]);
    assert_eq!(px(&s, 4, 4), [5, 6, 7]);
    assert_eq!(px(&s, 5, 4), [0, 0, 0]);
    // Only the first tile is dirty, and only once.
    let mut s = s;
    assert_eq!(s.fb.take_dirty().len(), 1);
    assert!(s.fb.take_dirty().is_empty());
}

#[test]
fn copyrect_with_overlap() {
    let mut body = Vec::new();
    for i in 0..4u8 {
        body.extend([i * 10, 0, 0, 0]);
    }
    let s = run(10, 10, &update(&[rect(0, 0, 4, 1, 0, &body), rect(1, 0, 4, 1, 1, &[0, 0, 0, 0])]));
    // The source [0,10,20,30] lands on x=1..5 as it was before the copy.
    assert_eq!(px(&s, 0, 0)[0], 0);
    assert_eq!([1, 2, 3, 4].map(|x| px(&s, x, 0)[0]), [0, 10, 20, 30]);
}

#[test]
fn rre() {
    let mut body = 2u32.to_be_bytes().to_vec();
    body.extend([1, 2, 3, 0]); // background
    body.extend([200, 0, 0, 0, 0, 1, 0, 1, 0, 2, 0, 1]); // (1,1) 2x1
    body.extend([0, 200, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1]); // (0,0) 1x1
    let s = run(10, 10, &update(&[rect(4, 4, 5, 3, 2, &body)]));
    assert_eq!(px(&s, 4, 4), [0, 200, 0]);
    assert_eq!(px(&s, 5, 5), [200, 0, 0]);
    assert_eq!(px(&s, 6, 5), [200, 0, 0]);
    assert_eq!(px(&s, 7, 5), [1, 2, 3]);
    assert_eq!(px(&s, 8, 6), [1, 2, 3]);
}

#[test]
fn hextile_all_subencodings_and_state_across_rects() {
    let mut body = Vec::new();
    // Tile 0 (16x16): background red, foreground green, one subrect at (1,1) 3x2.
    body.extend([2 | 4 | 8, 255, 0, 0, 0, 0, 255, 0, 0, 1, 0x11, 0x21]);
    // Tile 1 (4x16): coloured subrects, the background carries over; one blue pixel at (0,0).
    body.extend([8 | 16, 1, 0, 0, 255, 0, 0x00, 0x00]);
    // Tile 2 (16x2): raw.
    body.push(1);
    for _ in 0..32 {
        body.extend([1, 2, 3, 0]);
    }
    // Tile 3 (4x2): blank right after a raw tile is left alone (noVNC's quirk).
    body.push(0);
    // A second rect: its blank tile fills with the remembered background.
    let second = [0u8];
    let s = run(40, 40, &update(&[rect(0, 0, 20, 18, 5, &body), rect(20, 20, 16, 16, 5, &second)]));
    assert_eq!(px(&s, 0, 0), [255, 0, 0]);
    assert_eq!(px(&s, 1, 1), [0, 255, 0]);
    assert_eq!(px(&s, 3, 2), [0, 255, 0]);
    assert_eq!(px(&s, 4, 1), [255, 0, 0]);
    assert_eq!(px(&s, 16, 0), [0, 0, 255]);
    assert_eq!(px(&s, 17, 0), [255, 0, 0]);
    assert_eq!(px(&s, 5, 16), [1, 2, 3]);
    assert_eq!(px(&s, 17, 16), [0, 0, 0]);
    assert_eq!(px(&s, 25, 25), [255, 0, 0]);
}

#[test]
fn hextile_illegal_subencoding_fails() {
    assert!(fails(20, 20, &update(&[rect(0, 0, 16, 16, 5, &[0x40])])).contains("hextile"));
}

#[test]
fn zlib_stream_carries_over_between_rects() {
    let mut d = Deflater::new();
    let a: Vec<u8> = (0..4 * 2).flat_map(|i| [i as u8 * 3, 9, 9, 0]).collect();
    let b: Vec<u8> = (0..4 * 2).flat_map(|i| [9, i as u8 * 5, 9, 0]).collect();
    let (ca, cb) = (d.sync(&a), d.sync(&b));
    let s = run(10, 10, &update(&[rect(0, 0, 4, 2, 6, &lengthed(&ca)), rect(0, 4, 4, 2, 6, &lengthed(&cb))]));
    assert_eq!(px(&s, 3, 1), [21, 9, 9]);
    assert_eq!(px(&s, 3, 5), [9, 35, 9]);
}

#[test]
fn zlib_corrupt_data_fails() {
    let reason = fails(10, 10, &update(&[rect(0, 0, 4, 2, 6, &lengthed(&[1, 2, 3, 4, 5, 6]))]));
    assert!(reason.contains("zlib"), "{reason}");
}

fn cpix(c: [u8; 3]) -> Vec<u8> {
    c.to_vec()
}

#[test]
fn zrle_every_tile_kind_and_stream_state() {
    let (red, green, blue, white) = ([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]);
    let mut d = Deflater::new();

    // 130x2: three tiles per row of tiles (64 + 64 + 2 wide), one row of tiles (2 high).
    let mut z = Vec::new();
    // Tile 0 (64x2): packed palette of 2 colours, 1 bit per pixel, rows padded to bytes.
    z.push(2);
    z.extend(cpix(red));
    z.extend(cpix(blue));
    for row in 0..2 {
        // 64 pixels: 8 bytes per row; first pixel of the row is blue (index 1) for row 1 only.
        let first = if row == 1 { 0b1000_0000 } else { 0 };
        z.push(first);
        z.extend([0; 7]);
    }
    // Tile 1 (64x2): solid green.
    z.push(1);
    z.extend(cpix(green));
    // Tile 2 (2x2): raw.
    z.push(0);
    for c in [red, green, blue, white] {
        z.extend(cpix(c));
    }
    let first = d.sync(&z);

    // Second rect, same stream: 6x2, plain RLE (128) then, in another rect, palette RLE.
    let mut z2 = vec![128];
    z2.extend(cpix(blue));
    z2.push(5); // run of 6
    z2.extend(cpix(red));
    z2.push(5);
    let second = d.sync(&z2);

    // Third: 4x2 palette RLE (130 = 2 colours): index 0 run of 3, index 1 single, 0 run of 4.
    let mut z3 = vec![130];
    z3.extend(cpix(white));
    z3.extend(cpix(green));
    z3.extend([128, 2, 1, 128, 3]);
    let third = d.sync(&z3);

    // Fourth: 3x1, packed palette of 4 colours (2 bits per pixel): indices 3, 2, 1.
    let mut z4 = vec![4];
    for c in [red, green, blue, white] {
        z4.extend(cpix(c));
    }
    z4.push(0b1110_0100);
    let fourth = d.sync(&z4);

    let bytes = update(&[
        rect(0, 0, 130, 2, 16, &lengthed(&first)),
        rect(0, 4, 6, 2, 16, &lengthed(&second)),
        rect(0, 8, 4, 2, 16, &lengthed(&third)),
        rect(0, 12, 3, 1, 16, &lengthed(&fourth)),
    ]);
    let s = run(140, 20, &bytes);
    assert_eq!(px(&s, 0, 0), red);
    assert_eq!(px(&s, 1, 0), red);
    assert_eq!(px(&s, 0, 1), blue);
    assert_eq!(px(&s, 1, 1), red);
    assert_eq!(px(&s, 64, 0), green);
    assert_eq!(px(&s, 127, 1), green);
    assert_eq!(px(&s, 128, 0), red);
    assert_eq!(px(&s, 129, 1), white);
    assert_eq!(px(&s, 129, 0), green);
    assert_eq!(px(&s, 0, 4), blue);
    assert_eq!(px(&s, 5, 4), blue);
    assert_eq!(px(&s, 0, 5), red);
    assert_eq!(px(&s, 5, 5), red);
    // 4x2 = 8 pixels: white x3, green x1, white x4.
    assert_eq!([0, 1, 2, 3].map(|x| px(&s, x, 8)), [white, white, white, green]);
    assert_eq!([0, 1, 2, 3].map(|x| px(&s, x, 9)), [white; 4]);
    assert_eq!([0, 1, 2].map(|x| px(&s, x, 12)), [white, blue, green]);
}

#[test]
fn zrle_bad_subencoding_fails() {
    let mut d = Deflater::new();
    let c = d.sync(&[17]);
    let reason = fails(10, 10, &update(&[rect(0, 0, 4, 4, 16, &lengthed(&c))]));
    assert!(reason.contains("subencoding"), "{reason}");
}

// Tight

fn fill_body(color: [u8; 3]) -> Vec<u8> {
    let mut b = vec![0x80];
    b.extend(color);
    b
}

#[test]
fn tight_fill() {
    let s = run(10, 10, &update(&[rect(1, 1, 3, 3, 7, &fill_body([5, 6, 7]))]));
    assert_eq!(px(&s, 1, 1), [5, 6, 7]);
    assert_eq!(px(&s, 3, 3), [5, 6, 7]);
    assert_eq!(px(&s, 4, 4), [0, 0, 0]);
}

#[test]
fn tight_copy_filter_uncompressed_and_compressed_with_reset() {
    // 2x1 = 6 bytes: sent as is. Stream 0, no filter byte.
    let small = [0x00, 1, 2, 3, 4, 5, 6];
    let mut d = Deflater::new();
    // 4x4 = 48 bytes: compressed with a compact length.
    let big: Vec<u8> = (0..48).collect();
    let c = d.sync(&big);
    let mut b = vec![0x00];
    b.push(c.len() as u8);
    b.extend(&c);
    // The same stream again (state carried) for a second 4x4.
    let big2: Vec<u8> = (0..48).map(|i| 255 - i).collect();
    let c2 = d.sync(&big2);
    let mut b2 = vec![0x00, c2.len() as u8];
    b2.extend(&c2);
    // After a reset (bit 0 of ctl) the server starts a new stream.
    let mut d2 = Deflater::new();
    let c3 = d2.sync(&big);
    let mut b3 = vec![0x01, c3.len() as u8];
    b3.extend(&c3);
    let bytes = update(&[rect(0, 0, 2, 1, 7, &small), rect(0, 2, 4, 4, 7, &b), rect(4, 2, 4, 4, 7, &b2), rect(0, 6, 4, 4, 7, &b3)]);
    let s = run(10, 10, &bytes);
    assert_eq!(px(&s, 1, 0), [4, 5, 6]);
    assert_eq!(px(&s, 0, 2), [0, 1, 2]);
    assert_eq!(px(&s, 3, 5), [45, 46, 47]);
    assert_eq!(px(&s, 7, 5), [255 - 45, 255 - 46, 255 - 47]);
    assert_eq!(px(&s, 3, 9), [45, 46, 47]);
}

#[test]
fn tight_palette_filter_mono_and_indexed() {
    // 10x2, two colours: 1 bit per pixel, MSB first, rows of 2 bytes; 4 bytes is sent as is.
    let mut mono = vec![0x40, 1, 1, 10, 20, 30, 40, 50, 60];
    mono.extend([0b1010_0000, 0b0100_0000, 0xff, 0xc0]); // row 0: x=0,2,9 set; row 1: all set
    // 64x2 mono: 16 bytes, compressed. Row 0 all clear but x=63; row 1 all set.
    let mut bits = vec![0u8; 8];
    bits[7] = 1;
    bits.extend([0xff; 8]);
    let mut d = Deflater::new();
    let c = d.sync(&bits);
    let mut mono_big = vec![0x40, 1, 1, 1, 1, 1, 2, 2, 2, c.len() as u8];
    mono_big.extend(&c);
    // Indexed (3 colours): 3x1 = 3 bytes, sent as is.
    let indexed = [0x40, 1, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 0, 1];
    let bytes = update(&[rect(0, 0, 10, 2, 7, &mono), rect(0, 4, 3, 1, 7, &indexed), rect(0, 6, 64, 2, 7, &mono_big)]);
    let s = run(70, 10, &bytes);
    assert_eq!([0, 1, 2, 8, 9].map(|x| px(&s, x, 0)), [[40, 50, 60], [10, 20, 30], [40, 50, 60], [10, 20, 30], [40, 50, 60]]);
    assert_eq!([0, 5, 9].map(|x| px(&s, x, 1)), [[40, 50, 60]; 3]);
    assert_eq!([0, 1, 2].map(|x| px(&s, x, 4)), [[7, 8, 9], [1, 2, 3], [4, 5, 6]]);
    assert_eq!(px(&s, 0, 6), [1, 1, 1]);
    assert_eq!(px(&s, 63, 6), [2, 2, 2]);
    assert_eq!(px(&s, 0, 7), [2, 2, 2]);
}

#[test]
fn tight_gradient_filter() {
    // 2x2 (12 bytes, so compressed). Row 0 predicts from the left; row 1 from left + upper - upper-left.
    let data = [10, 20, 30, 1, 1, 1, 5, 5, 5, 0, 0, 0];
    let c = Deflater::new().sync(&data);
    let mut body = vec![0x40, 2, c.len() as u8];
    body.extend(&c);
    let s = run(4, 4, &update(&[rect(0, 0, 2, 2, 7, &body)]));
    assert_eq!(px(&s, 0, 0), [10, 20, 30]);
    assert_eq!(px(&s, 1, 0), [11, 21, 31]);
    assert_eq!(px(&s, 0, 1), [15, 25, 35]); // upper + 5
    assert_eq!(px(&s, 1, 1), [16, 26, 36]); // left 15 + upper 11 - upper-left 10 = 16, plus 0
}

#[test]
fn tight_jpeg() {
    let jpeg = include_bytes!("test_red.jpg");
    let mut body = vec![0x90];
    // Compact length: 777 = 0x309 -> low 7 bits | 0x80, then the rest.
    body.push((jpeg.len() & 0x7f) as u8 | 0x80);
    body.push((jpeg.len() >> 7) as u8);
    body.extend(jpeg.iter());
    let s = run(12, 12, &update(&[rect(2, 2, 8, 8, 7, &body)]));
    let [r, g, b] = px(&s, 5, 5);
    assert!(r > 240 && g < 20 && b < 20, "{r} {g} {b}");
    assert_eq!(px(&s, 1, 1), [0, 0, 0]);
    assert_eq!(px(&s, 10, 10), [0, 0, 0]);
}

#[test]
fn tight_png_and_bad_control_fail() {
    assert!(fails(8, 8, &update(&[rect(0, 0, 2, 2, 7, &[0xa0])])).contains("PNG"));
    assert!(fails(8, 8, &update(&[rect(0, 0, 2, 2, 7, &[0xb0])])).contains("Illegal tight"));
    assert!(fails(8, 8, &update(&[rect(0, 0, 2, 2, 7, &[0x40, 9])])).contains("filter"));
}

#[test]
fn rect_outside_the_framebuffer_fails() {
    assert!(fails(8, 8, &update(&[rect(6, 6, 4, 4, 0, &[0; 64])])).contains("outside"));
}

#[test]
fn compact_length_of_two_bytes() {
    // 100x1 copy filter: 300 bytes, whose compressed form is made long by incompressible data.
    let mut x = 0x1234_5678u32;
    let plain: Vec<u8> = (0..300)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect();
    let c = Deflater::new().sync(&plain);
    assert!(c.len() > 127, "{}", c.len());
    let mut body = vec![0x00, (c.len() & 0x7f) as u8 | 0x80, (c.len() >> 7) as u8];
    body.extend(&c);
    let s = run(100, 1, &update(&[rect(0, 0, 100, 1, 7, &body)]));
    assert_eq!(px(&s, 99, 0), [plain[297], plain[298], plain[299]]);
}
