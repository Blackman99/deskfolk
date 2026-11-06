//! Handshake, authentication, events, input messages, tiles. Decoders are in `tests_decoders`.

use serde_json::{Value, json};

use super::auth;
use super::session::Session;
use super::tiles::Framebuffer;

pub fn server_init(w: u16, h: u16, name: &str) -> Vec<u8> {
    let mut m = Vec::new();
    m.extend(w.to_be_bytes());
    m.extend(h.to_be_bytes());
    m.extend([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
    m.extend((name.len() as u32).to_be_bytes());
    m.extend(name.as_bytes());
    m
}

pub fn connected(w: u16, h: u16) -> Session {
    let mut s = Session::new();
    let mut hello = b"RFB 003.008\n".to_vec();
    hello.extend([1, 1, 0, 0, 0, 0]);
    hello.extend(server_init(w, h, "test"));
    s.feed(&hello);
    assert!(s.connected());
    s.out.clear();
    s.fb.take_dirty();
    s
}

fn types(events: &[Value]) -> Vec<&str> {
    events.iter().map(|e| e["type"].as_str().unwrap()).collect()
}

const PIXEL_FORMAT: [u8; 20] = [0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0];

fn encodings() -> Vec<u8> {
    let mut m = vec![2, 0, 0, 11];
    for e in [1i32, 7, 16, 5, 2, 6, 0, -26, -254, -223, -308] {
        m.extend(e.to_be_bytes());
    }
    m
}

#[test]
fn version_3_8_none_connects_with_the_exact_replies() {
    let mut s = Session::new();
    assert!(s.feed(b"RFB 003.008\n").is_empty());
    assert!(s.feed(&[1, 1]).is_empty());
    assert!(s.feed(&[0, 0, 0, 0]).is_empty());
    let ev = s.feed(&server_init(640, 480, "Desk"));
    assert_eq!(ev, vec![json!({"type": "connected", "width": 640, "height": 480, "name": "Desk"})]);
    let mut want = b"RFB 003.008\n".to_vec();
    want.push(1); // security type None
    want.push(1); // ClientInit: shared
    want.extend(PIXEL_FORMAT);
    want.extend(encodings());
    want.extend([3, 0, 0, 0, 0, 0, 2, 128, 1, 224]); // full update request, 640x480
    assert_eq!(s.out, want);
}

#[test]
fn version_3_3_server_dictates_the_scheme() {
    let mut s = Session::new();
    let mut input = b"RFB 003.003\n".to_vec();
    input.extend(1u32.to_be_bytes()); // None: no SecurityResult in 3.3
    input.extend(server_init(8, 8, "x"));
    let ev = s.feed(&input);
    assert_eq!(types(&ev), ["connected"]);
    assert!(s.out.starts_with(b"RFB 003.003\n\x01\x00\x00\x00\x00"));
}

#[test]
fn version_3_7_none_has_no_security_result() {
    let mut s = Session::new();
    let mut input = b"RFB 003.007\n".to_vec();
    input.extend([2, 2, 1]); // VNC and None offered: the server's first supported wins, VNC
    s.feed(&input);
    assert_eq!(s.out, b"RFB 003.007\n\x02");
    assert_eq!(types(&s.feed(&[0; 16])), ["credentials"]);
    let mut s = Session::new();
    let mut input = b"RFB 003.007\n".to_vec();
    input.extend([1, 1]);
    input.extend(server_init(8, 8, "x"));
    let ev = s.feed(&input);
    assert_eq!(types(&ev), ["connected"]);
    assert!(s.out.starts_with(b"RFB 003.007\n\x01\x01"));
}

#[test]
fn newer_server_versions_get_3_8() {
    let mut s = Session::new();
    s.feed(b"RFB 003.889\n");
    assert_eq!(s.out, b"RFB 003.008\n");
}

#[test]
fn garbage_version_fails() {
    let mut s = Session::new();
    let ev = s.feed(b"HTTP/1.1 400");
    assert_eq!(ev, vec![json!({"type": "failed", "reason": "Invalid server version HTTP/1.1 400"})]);
    assert!(s.feed(b"more").is_empty());
}

#[test]
fn security_failure_carries_the_reason() {
    let mut s = Session::new();
    s.feed(b"RFB 003.008\n");
    s.feed(&[1, 1]);
    let mut m = 1u32.to_be_bytes().to_vec();
    m.extend(4u32.to_be_bytes());
    m.extend(b"nope");
    let ev = s.feed(&m);
    assert_eq!(ev, vec![json!({"type": "failed", "reason": "nope", "securityFailure": true})]);
}

#[test]
fn no_security_types_fails_with_the_servers_reason() {
    let mut s = Session::new();
    s.feed(b"RFB 003.008\n");
    let mut m = vec![0];
    m.extend(8u32.to_be_bytes());
    m.extend(b"too many");
    assert!(s.feed(&m[..8]).is_empty());
    let ev = s.feed(&m[8..]);
    assert_eq!(ev, vec![json!({"type": "failed", "reason": "too many", "securityFailure": true})]);
}

#[test]
fn unsupported_security_types_fail() {
    let mut s = Session::new();
    s.feed(b"RFB 003.008\n");
    let ev = s.feed(&[2, 16, 19]);
    assert_eq!(ev, vec![json!({"type": "failed", "reason": "Unsupported security types (types: 16,19)"})]);
}

#[test]
fn security_failure_in_3_7_has_no_reason() {
    let mut s = Session::new();
    s.feed(b"RFB 003.007\n");
    s.feed(&[1, 2]);
    s.credentials = Some((String::new(), "pw".into()));
    assert!(s.feed(&[0; 16]).is_empty());
    let ev = s.feed(&[0, 0, 0, 1]);
    assert_eq!(ev, vec![json!({"type": "failed", "reason": "Security handshake failed", "securityFailure": true})]);
}

fn challenge() -> [u8; 16] {
    std::array::from_fn(|i| (i * 7 + 1) as u8)
}

#[test]
fn vnc_auth_matches_novncs_des() {
    // Computed with noVNC's own des.js (run under bun) on the same input.
    let want = |hex: &str| -> Vec<u8> { (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect() };
    assert_eq!(auth::vnc_response("password", &challenge()).to_vec(), want("d4b2717a75ea153ee6cc4458b59566ca"));
    assert_eq!(auth::vnc_response("abc", &challenge()).to_vec(), want("bbc7ff1d89c242020009f2aa3cb1169c"));
    // Only the first 8 characters count.
    assert_eq!(auth::vnc_response("longerthan8chars", &challenge()).to_vec(), want("af0e8ada8e4d38c17a41b05413c61e6b"));
    assert_eq!(auth::vnc_response("longerth", &challenge()), auth::vnc_response("longerthan8chars", &challenge()));
}

#[test]
fn vnc_auth_flow_asks_for_a_password_then_answers() {
    let mut s = Session::new();
    s.feed(b"RFB 003.008\n");
    s.feed(&[1, 2]);
    assert_eq!(s.out, b"RFB 003.008\n\x02");
    s.out.clear();
    let ev = s.feed(&challenge());
    assert_eq!(ev, vec![json!({"type": "credentials", "needs": ["password"]})]);
    assert!(s.out.is_empty());
    // Asked once only.
    assert!(s.feed(&[]).iter().all(|e| e["type"] != "credentials"));
}

#[test]
fn vnc_auth_flow_full() {
    let mut s = Session::new();
    s.feed(b"RFB 003.008\n");
    s.feed(&[1, 2]);
    s.out.clear();
    let ev = s.feed(&challenge());
    assert_eq!(types(&ev), ["credentials"]);
    s.credentials = Some(("ignored".into(), "password".into()));
    assert!(s.pump().is_empty());
    assert_eq!(s.out, auth::vnc_response("password", &challenge()));
    s.out.clear();
    let mut rest = vec![0, 0, 0, 0];
    rest.extend(server_init(4, 4, "vnc"));
    assert_eq!(types(&s.feed(&rest)), ["connected"]);
    assert_eq!(s.out[0], 1);
}

#[test]
fn wrong_password_is_a_security_failure() {
    let mut s = Session::new();
    s.feed(b"RFB 003.008\n");
    s.feed(&[1, 2]);
    s.credentials = Some((String::new(), "bad".into()));
    s.feed(&challenge());
    let mut m = 1u32.to_be_bytes().to_vec();
    m.extend(25u32.to_be_bytes());
    m.extend(b"Authentication failed.   ".iter().take(25));
    let ev = s.feed(&m);
    assert_eq!(ev[0]["securityFailure"], true);
    assert_eq!(ev[0]["type"], "failed");
}

// ARD: a small prime and a known server key, the answer decrypted here.
#[test]
fn ard_answer_decrypts_to_the_credentials() {
    use aes::Aes128;
    use aes::cipher::{Array, BlockCipherDecrypt, KeyInit};
    use md5::{Digest, Md5};
    use num_bigint::BigUint;

    let prime: u64 = 0xFFFF_FFFF_FFFF_FFC5; // 2^64 - 59
    let key_len = 8usize;
    let g = BigUint::from(2u8);
    let p = BigUint::from(prime);
    let server_private = BigUint::from(0x1234_5678_9abc_u64);
    let server_public = g.modpow(&server_private, &p);
    let pad = |n: &BigUint| {
        let mut b = n.to_bytes_be();
        while b.len() < key_len {
            b.insert(0, 0);
        }
        b
    };

    let mut s = Session::new();
    s.seed = Some(vec![7; 16]);
    s.feed(b"RFB 003.008\n");
    let ev = s.feed(&[1, 30]);
    assert_eq!(ev, vec![json!({"type": "credentials", "needs": ["username", "password"]})]);
    s.out.clear();
    let mut ard = vec![0, 2, 0, key_len as u8];
    ard.extend(pad(&p));
    ard.extend(pad(&server_public));
    s.credentials = Some(("alice".into(), "s3cret".into()));
    s.feed(&ard[..9]);
    assert!(s.out.is_empty());
    s.pump();
    s.feed(&ard[9..]);
    assert_eq!(s.out.len(), 128 + key_len);

    let client_public = BigUint::from_bytes_be(&s.out[128..]);
    let shared = pad(&client_public.modpow(&server_private, &p));
    let key: [u8; 16] = Md5::digest(&shared).into();
    let cipher = Aes128::new(&Array::from(key));
    let mut plain = s.out[..128].to_vec();
    for block in plain.chunks_exact_mut(16) {
        let mut b = Array::<u8, _>::try_from(&*block).unwrap();
        cipher.decrypt_block(&mut b);
        block.copy_from_slice(&b);
    }
    assert_eq!(&plain[..6], b"alice\0");
    assert_eq!(&plain[64..71], b"s3cret\0");
    // The bytes after the terminators are fill, not zeros.
    assert!(plain[6..64].iter().any(|&b| b != 0));
    // Deterministic for a fixed seed.
    let again = auth::ard_response(&[0, 2], &pad(&p), &pad(&server_public), "alice", "s3cret", &[7; 16]).unwrap();
    assert_eq!(again, s.out);
}

#[test]
fn ard_rejects_a_zero_prime() {
    assert!(auth::ard_response(&[0, 2], &[0; 8], &[1; 8], "a", "b", &[1; 16]).is_err());
}

#[test]
fn ard_success_connects() {
    let mut s = Session::new();
    s.feed(b"RFB 003.008\n");
    s.feed(&[1, 30]);
    s.credentials = Some(("u".into(), "p".into()));
    let mut ard = vec![0, 2, 0, 8];
    ard.extend(0xFFFF_FFFF_FFFF_FFC5u64.to_be_bytes());
    ard.extend(3u64.to_be_bytes());
    s.feed(&ard);
    let mut rest = vec![0, 0, 0, 0];
    rest.extend(server_init(2, 2, "mac"));
    assert_eq!(types(&s.feed(&rest)), ["connected"]);
}

// Messages from the server in the normal phase.

#[test]
fn bell_clipboard_and_colour_map() {
    let mut s = connected(16, 16);
    let mut m = vec![2];
    m.extend([3, 0, 0, 0, 0, 0, 0, 3, 0xe9, b'h', b'i']);
    m.extend([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    let ev = s.feed(&m);
    assert_eq!(ev, vec![json!({"type": "bell"}), json!({"type": "clipboard", "text": "\u{e9}hi"})]);
    // Extended clipboard (negative length) is skipped whole.
    let mut m = vec![3, 0, 0, 0];
    m.extend((-6i32).to_be_bytes());
    m.extend([0, 0, 0, 1, 9, 9]);
    m.push(2);
    assert_eq!(s.feed(&m), vec![json!({"type": "bell"})]);
}

#[test]
fn unknown_message_fails_without_panicking() {
    let mut s = connected(16, 16);
    let ev = s.feed(&[99]);
    assert_eq!(ev, vec![json!({"type": "failed", "reason": "Unexpected server message (type 99)"})]);
}

#[test]
fn unsupported_encoding_fails() {
    let mut s = connected(16, 16);
    let mut m = vec![0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1];
    m.extend(50i32.to_be_bytes());
    let ev = s.feed(&m);
    assert_eq!(ev[0]["type"], "failed");
}

#[test]
fn an_update_continues_the_next_request_and_spans_feeds() {
    let mut s = connected(16, 16);
    // One FBU, two rects, split between the rects' bytes.
    let mut m = vec![0, 0, 0, 2];
    let px = [10u8, 20, 30, 0];
    m.extend([0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
    m.extend(px);
    m.extend([0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0]);
    m.extend([40, 50, 60, 0]);
    // The first rect is whole: it shows at once, but the next request waits for the whole update.
    let ev = s.feed(&m[..30]);
    assert_eq!(ev, vec![json!({"type": "update"})]);
    assert!(s.out.is_empty());
    let ev = s.feed(&m[30..]);
    assert_eq!(ev, vec![json!({"type": "update"})]);
    assert_eq!(s.out, [3, 1, 0, 0, 0, 0, 0, 16, 0, 16]); // incremental
    assert_eq!(&s.fb.rgba[..4], &[10, 20, 30, 255]);
    assert_eq!(&s.fb.rgba[(16 + 1) * 4..(16 + 1) * 4 + 4], &[40, 50, 60, 255]);
}

#[test]
fn desktop_size_resizes_and_keeps_pixels() {
    let mut s = connected(4, 4);
    s.fb.fill_rect(0, 0, 4, 4, [1, 2, 3]);
    let mut m = vec![0, 0, 0, 1, 0, 0, 0, 0, 0, 8, 0, 6];
    m.extend((-223i32).to_be_bytes());
    let ev = s.feed(&m);
    assert_eq!(ev, vec![json!({"type": "resized", "width": 8, "height": 6}), json!({"type": "update"})]);
    assert_eq!(&s.fb.rgba[..4], &[1, 2, 3, 255]);
    assert_eq!(s.fb.w, 8);
    // ExtendedDesktopSize: one screen; x=0 (server's own change).
    let mut m = vec![0, 0, 0, 1, 0, 0, 0, 0, 0, 5, 0, 5];
    m.extend((-308i32).to_be_bytes());
    m.extend([1, 0, 0, 0]);
    m.extend([0; 16]);
    let ev = s.feed(&m);
    assert_eq!(ev[0], json!({"type": "resized", "width": 5, "height": 5}));
    // A refused request of ours (x=1, y=2) changes nothing.
    let mut m = vec![0, 0, 0, 1, 0, 1, 0, 2, 0, 9, 0, 9];
    m.extend((-308i32).to_be_bytes());
    m.extend([0, 0, 0, 0]);
    s.feed(&m);
    assert_eq!(s.fb.w, 5);
}

#[test]
fn closing_the_transport() {
    let mut s = connected(4, 4);
    assert_eq!(s.feed(&[]), vec![json!({"type": "closed"})]);
    let mut s = Session::new();
    assert_eq!(s.feed(&[])[0]["type"], "failed");
}

#[test]
fn random_garbage_never_panics() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for round in 0..300 {
        let mut s = if round % 2 == 0 { connected(20, 20) } else { Session::new() };
        let len = (next() % 400) as usize;
        let mut bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
        if round % 3 == 0 && !bytes.is_empty() {
            bytes[0] = 0; // look like an update
        }
        for chunk in bytes.chunks(7) {
            s.feed(chunk);
        }
        s.fb.take_dirty();
    }
}

// Input.

#[test]
fn input_messages() {
    let mut s = connected(100, 50);
    s.pointer(10.0, 20.0, 1.0);
    s.pointer(500.0, -5.0, 8.0 + 4.0);
    s.key(0xff0d as f64, true);
    s.key(65.0, false);
    s.cut_text("h\u{e9}\u{20ac}");
    s.request_update(false);
    s.request_update(true);
    let want: Vec<u8> = [
        &[5u8, 1, 0, 10, 0, 20][..],
        &[5, 12, 0, 99, 0, 0],
        &[4, 1, 0, 0, 0, 0, 0xff, 0x0d],
        &[4, 0, 0, 0, 0, 0, 0, 65],
        &[6, 0, 0, 0, 0, 0, 0, 3, b'h', 0xe9, b'?'],
        &[3, 1, 0, 0, 0, 0, 0, 100, 0, 50],
        &[3, 0, 0, 0, 0, 0, 0, 100, 0, 50],
    ]
    .concat();
    assert_eq!(s.out, want);
}

#[test]
fn input_before_connecting_is_dropped() {
    let mut s = Session::new();
    s.pointer(1.0, 1.0, 0.0);
    s.key(1.0, true);
    s.request_update(true);
    assert!(s.out.is_empty());
}

// Tiles.

#[test]
fn tiles_are_dirty_once_and_resize_dirties_all() {
    let mut fb = Framebuffer::empty();
    fb.resize(300, 260);
    let tiles = fb.take_dirty();
    assert_eq!(tiles.len(), 4);
    let sizes: Vec<_> = tiles.iter().map(|t| (t.x, t.y, t.w, t.h)).collect();
    assert_eq!(sizes, [(0, 0, 256, 256), (256, 0, 44, 256), (0, 256, 256, 4), (256, 256, 44, 4)]);
    assert!(fb.take_dirty().is_empty());
    fb.fill_rect(260, 10, 2, 2, [9, 8, 7]);
    let tiles = fb.take_dirty();
    assert_eq!(tiles.len(), 1);
    assert_eq!((tiles[0].x, tiles[0].y), (256, 0));
    // A rect across a seam dirties both tiles.
    fb.fill_rect(250, 250, 10, 10, [1, 1, 1]);
    assert_eq!(fb.take_dirty().len(), 4);
    fb.resize(300, 260);
    assert_eq!(fb.take_dirty().len(), 4);
}

#[test]
fn bmp_encoding() {
    let mut fb = Framebuffer::empty();
    fb.resize(2, 2);
    fb.fill_rect(0, 0, 1, 1, [10, 20, 30]);
    let bmp = &fb.take_dirty()[0].bmp;
    assert_eq!(&bmp[..2], b"BM");
    assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()), 54 + 16);
    assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 54);
    assert_eq!(u32::from_le_bytes(bmp[14..18].try_into().unwrap()), 40);
    assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 2);
    assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -2);
    assert_eq!(u16::from_le_bytes(bmp[26..28].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(bmp[28..30].try_into().unwrap()), 32);
    assert_eq!(&bmp[54..58], &[30, 20, 10, 255]); // BGRA
    assert_eq!(bmp.len(), 70);
}

#[test]
fn the_module_surface_round_trips() {
    use super::Screens;
    Screens::open("t".into());
    let mut hello = b"RFB 003.008\n".to_vec();
    hello.extend([1, 1, 0, 0, 0, 0]);
    hello.extend(server_init(3, 2, "m"));
    let ev: Value = serde_json::from_str(&Screens::feed("t".into(), hello)).unwrap();
    assert_eq!(ev[0]["type"], "connected");
    assert!(Screens::take_outgoing("t".into()).starts_with(b"RFB 003.008\n"));
    assert!(Screens::take_outgoing("t".into()).is_empty());
    assert_eq!(Screens::size("t".into()), vec![3.0, 2.0]);
    let tiles: Value = serde_json::from_str(&Screens::dirty_tiles("t".into())).unwrap();
    assert_eq!(tiles[0]["w"], 3);
    assert!(tiles[0]["uri"].as_str().unwrap().starts_with("data:image/bmp;base64,Qk"));
    assert_eq!(Screens::dirty_tiles("t".into()), "[]");
    Screens::close("t".into());
    assert_eq!(Screens::size("t".into()), vec![0.0, 0.0]);
    assert_eq!(Screens::feed("t".into(), vec![1]), "[]");
}
