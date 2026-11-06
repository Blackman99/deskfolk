//! The client-to-server messages (noVNC's `RFB.messages`) and the numbers both directions share.

pub const ENC_RAW: i32 = 0;
pub const ENC_COPYRECT: i32 = 1;
pub const ENC_RRE: i32 = 2;
pub const ENC_HEXTILE: i32 = 5;
pub const ENC_ZLIB: i32 = 6;
pub const ENC_TIGHT: i32 = 7;
pub const ENC_ZRLE: i32 = 16;
pub const PSEUDO_QUALITY_0: i32 = -32;
pub const PSEUDO_COMPRESS_0: i32 = -256;
pub const PSEUDO_DESKTOP_SIZE: i32 = -223;
pub const PSEUDO_EXTENDED_DESKTOP_SIZE: i32 = -308;

/// noVNC's defaults.
pub const QUALITY_LEVEL: i32 = 6;
pub const COMPRESS_LEVEL: i32 = 2;

pub const SEC_NONE: u32 = 1;
pub const SEC_VNC: u32 = 2;
pub const SEC_ARD: u32 = 30;

pub fn version_message(minor: u32) -> Vec<u8> {
    format!("RFB 003.00{minor}\n").into_bytes()
}

/// 32bpp, depth 24, little-endian true colour, shifts r0 g8 b16 (noVNC's `pixelFormat(24, true)`):
/// a pixel is the bytes R, G, B, X.
pub fn pixel_format() -> Vec<u8> {
    let mut m = vec![0, 0, 0, 0, 32, 24, 0, 1];
    for _ in 0..3 {
        m.extend_from_slice(&255u16.to_be_bytes());
    }
    m.extend_from_slice(&[0, 8, 16, 0, 0, 0]);
    m
}

/// Only the encodings this client decodes, in noVNC's preference order.
pub fn encodings() -> Vec<u8> {
    let encs = [
        ENC_COPYRECT,
        ENC_TIGHT,
        ENC_ZRLE,
        ENC_HEXTILE,
        ENC_RRE,
        ENC_ZLIB,
        ENC_RAW,
        PSEUDO_QUALITY_0 + QUALITY_LEVEL,
        PSEUDO_COMPRESS_0 + COMPRESS_LEVEL,
        PSEUDO_DESKTOP_SIZE,
        PSEUDO_EXTENDED_DESKTOP_SIZE,
    ];
    let mut m = vec![2, 0];
    m.extend_from_slice(&(encs.len() as u16).to_be_bytes());
    for e in encs {
        m.extend_from_slice(&e.to_be_bytes());
    }
    m
}

pub fn update_request(incremental: bool, w: usize, h: usize) -> Vec<u8> {
    let mut m = vec![3, incremental as u8, 0, 0, 0, 0];
    m.extend_from_slice(&(w.min(65535) as u16).to_be_bytes());
    m.extend_from_slice(&(h.min(65535) as u16).to_be_bytes());
    m
}

pub fn key_event(keysym: u32, down: bool) -> Vec<u8> {
    let mut m = vec![4, down as u8, 0, 0];
    m.extend_from_slice(&keysym.to_be_bytes());
    m
}

pub fn pointer_event(x: u16, y: u16, mask: u8) -> Vec<u8> {
    let mut m = vec![5, mask & 0x7f];
    m.extend_from_slice(&x.to_be_bytes());
    m.extend_from_slice(&y.to_be_bytes());
    m
}

/// Latin-1; what does not fit becomes `?`.
pub fn client_cut_text(text: &str) -> Vec<u8> {
    let bytes: Vec<u8> = text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect();
    let mut m = vec![6, 0, 0, 0];
    m.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    m.extend_from_slice(&bytes);
    m
}

pub fn be16(b: &[u8], at: usize) -> usize {
    u16::from_be_bytes([b[at], b[at + 1]]) as usize
}

pub fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
