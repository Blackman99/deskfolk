//! A Mac's screens one at a time (`displays`): the layout, the default to the main screen, the
//! page's choice, and the whole-screen request after every layout. The geometry is the Mac this was
//! measured on: a 5K main screen, a 4K one left of it and the built-in one below that.

use serde_json::{Value, json};

use super::displays::{Want, parse_layout};
use super::protocol::{auto_update, encodings, set_display, update_request};
use super::session::Session;
use super::tests::server_init;

const COMBINED: (u16, u16) = (9728, 4826);
const MAIN: (u16, u16) = (5120, 2880);

/// (id, main, mirrored, top, left, bottom, right) in points.
type Screen = (u32, bool, bool, i16, i16, i16, i16);

const SCREENS: [Screen; 3] = [
    (3, true, false, 0, 0, 1440, 2560),
    (1, false, false, 1296, -2056, 2413, -328),
    (2, false, false, 0, -2304, 1296, 0),
];

fn payload(current: Option<u32>, fb: (u16, u16), screens: &[Screen]) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend(5u16.to_be_bytes());
    p.extend(4864u16.to_be_bytes());
    p.extend(2413u16.to_be_bytes());
    p.extend(fb.0.to_be_bytes());
    p.extend(fb.1.to_be_bytes());
    p.extend(current.unwrap_or(u32::MAX).to_be_bytes());
    p.extend(4u32.to_be_bytes());
    p.extend((screens.len() as u16).to_be_bytes());
    for &(id, main, mirrored, top, left, bottom, right) in screens {
        let mut r = Vec::new();
        r.extend(2f64.to_be_bytes());
        r.extend(1f64.to_be_bytes());
        r.extend(id.to_be_bytes());
        for edge in [top, left, bottom, right] {
            r.extend(edge.to_be_bytes());
        }
        for edge in [top, left, bottom, right] {
            r.extend((edge.wrapping_mul(2)).to_be_bytes());
        }
        r.extend((u32::from(main) | (u32::from(mirrored) << 1)).to_be_bytes());
        r.extend([0u8; 16]);
        assert_eq!(r.len(), 0x38);
        p.extend(r);
    }
    p
}

/// A FramebufferUpdate holding only the layout, as the Mac sends it.
fn layout_update(current: Option<u32>, fb: (u16, u16), screens: &[Screen]) -> Vec<u8> {
    let body = payload(current, fb, screens);
    let mut m = vec![0, 0, 0, 1];
    m.extend([0u8; 8]);
    m.extend(0x451i32.to_be_bytes());
    m.extend((body.len() as u16).to_be_bytes());
    m.extend(body);
    m
}

fn mac(want: Option<Want>) -> Session {
    let mut s = Session::new();
    if let Some(want) = want {
        s.select_display(want);
    }
    let mut hello = b"RFB 003.889\n".to_vec();
    hello.extend([1, 1, 0, 0, 0, 0]);
    hello.extend(server_init(COMBINED.0, COMBINED.1, "Mac"));
    s.feed(&hello);
    assert!(s.connected());
    s.out.clear();
    s
}

fn types(events: &[Value]) -> Vec<&str> {
    events.iter().map(|e| e["type"].as_str().unwrap()).collect()
}

fn full(fb: (u16, u16)) -> Vec<u8> {
    let mut m = update_request(false, fb.0 as usize, fb.1 as usize);
    m.extend(auto_update(fb.0 as usize, fb.1 as usize));
    m
}

#[test]
fn auto_update_bytes() {
    assert_eq!(auto_update(5120, 2880), [0x09, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x14, 0x00, 0x0b, 0x40]);
}

#[test]
fn only_a_mac_is_asked_for_its_displays() {
    let mut s = Session::new();
    let mut hello = b"RFB 003.889\n".to_vec();
    hello.extend([1, 1, 0, 0, 0, 0]);
    hello.extend(server_init(8, 8, "Mac"));
    s.feed(&hello);
    let asked = encodings(true);
    assert!(s.out.windows(asked.len()).any(|w| w == asked.as_slice()));
    assert_eq!(&asked[2..4], &13u16.to_be_bytes());
    assert!(asked.ends_with(&[0, 0, 0x04, 0x4d, 0, 0, 0x04, 0x51]));
    // Anything else (a Windows or Linux VNC server) gets the list it always got.
    let plain = encodings(false);
    assert_eq!(&plain[2..4], &11u16.to_be_bytes());
}

#[test]
fn set_display_bytes() {
    assert_eq!(set_display(Some(3)), [0x0d, 0, 0, 0, 0, 0, 0, 3]);
    assert_eq!(set_display(None), [0x0d, 1, 0, 0, 0, 0, 0, 0]);
}

#[test]
fn parses_the_measured_layout() {
    let layout = parse_layout(&payload(None, COMBINED, &SCREENS)).unwrap();
    assert_eq!(layout.current, None);
    assert_eq!((layout.width, layout.height), (9728, 4826));
    let shown: Vec<_> = layout.displays.iter().map(|d| (d.id, d.main, d.x, d.y, d.width, d.height)).collect();
    assert_eq!(shown, [(3, true, 0, 0, 2560, 1440), (1, false, -2056, 1296, 1728, 1117), (2, false, -2304, 0, 2304, 1296)]);
}

#[test]
fn the_combined_view_is_narrowed_to_the_main_screen() {
    let mut s = mac(None);
    let ev = s.feed(&layout_update(None, COMBINED, &SCREENS));
    assert_eq!(types(&ev), ["displays", "update"]);
    assert_eq!(ev[0]["current"], Value::Null);
    assert_eq!(ev[0]["asking"], true);
    assert_eq!(ev[0]["displays"][0], json!({"id": 3, "main": true, "x": 0, "y": 0, "width": 2560, "height": 1440}));
    // Only the ask: a request beside it would bring a second whole screen after the switch.
    assert_eq!(std::mem::take(&mut s.out), set_display(Some(3)));
    // A stale update of the combined view before the answer asks for nothing either.
    s.feed(&[0, 0, 0, 0]);
    assert!(s.out.is_empty());

    let ev = s.feed(&layout_update(Some(3), MAIN, &SCREENS));
    assert_eq!(types(&ev), ["resized", "displays", "update"]);
    assert_eq!(ev[0], json!({"type": "resized", "width": 5120, "height": 2880}));
    assert_eq!(ev[1]["current"], 3);
    assert_eq!(ev[1]["asking"], false);
    assert_eq!(std::mem::take(&mut s.out), full(MAIN));

    // Auto-updates are already active, so subsequent frames do not send another request.
    s.feed(&[0, 0, 0, 0]);
    assert!(s.out.is_empty());
}

#[test]
fn desktop_size_on_a_mac_reasks_for_a_full_frame_and_auto_updates() {
    let mut s = mac(Some(Want::All));
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    s.out.clear();
    let mut m = vec![0, 0, 0, 1, 0, 0, 0, 0, 0x14, 0x00, 0x0b, 0x40];
    m.extend((-223i32).to_be_bytes());
    s.feed(&m);
    assert_eq!(std::mem::take(&mut s.out), full(MAIN));
    s.feed(&[0, 0, 0, 0]);
    assert!(s.out.is_empty());
}

#[test]
fn the_screen_the_page_wants_is_asked_for_and_a_gone_one_falls_back_to_main() {
    let mut s = mac(Some(Want::Id(2)));
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    assert_eq!(s.out, set_display(Some(2)));

    let mut s = mac(Some(Want::Id(9)));
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    assert_eq!(s.out, set_display(Some(3)));
}

#[test]
fn all_screens_keeps_the_combined_view() {
    let mut s = mac(Some(Want::All));
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    assert_eq!(s.out, full(COMBINED));
}

#[test]
fn choosing_while_connected_asks_at_once() {
    let mut s = mac(None);
    s.feed(&layout_update(Some(3), MAIN, &SCREENS));
    s.out.clear();
    assert!(s.select_display(Want::Id(1)));
    assert_eq!(s.out, set_display(Some(1)));
    s.out.clear();
    assert!(s.select_display(Want::All));
    assert_eq!(s.out, set_display(None));
    s.out.clear();
    // The view already showing is not asked for again.
    assert!(!s.select_display(Want::Main));
    assert!(s.out.is_empty());
}

#[test]
fn choosing_before_the_first_layout_sends_nothing() {
    let mut s = mac(None);
    assert!(!s.select_display(Want::Id(2)));
    assert!(s.out.is_empty());
    let mut before = Session::new();
    assert!(!before.select_display(Want::All));
    assert!(before.out.is_empty());
}

#[test]
fn a_refused_ask_is_not_repeated_until_the_mac_changes_again() {
    let mut s = mac(None);
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    assert_eq!(s.out, set_display(Some(3)));
    s.out.clear();
    // The Mac answers with the combined view all the same: shown, not asked again.
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    assert_eq!(s.out, full(COMBINED));
    s.out.clear();
    // Its next change of its own (a lock, a login) is asked about once more.
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    assert_eq!(s.out, set_display(Some(3)));
}

#[test]
fn one_screen_is_left_as_it_is() {
    let mut s = mac(None);
    s.feed(&layout_update(None, COMBINED, &SCREENS[..1]));
    assert_eq!(s.out, full(COMBINED));
    // Mirrors share an origin and count once.
    let mirrored = [(3, true, true, 0, 0, 1440, 2560), (4, false, true, 0, 0, 1440, 2560)];
    let layout = parse_layout(&payload(None, MAIN, &mirrored)).unwrap();
    assert_eq!(layout.displays.len(), 1);
    let mut s = mac(None);
    s.feed(&layout_update(None, MAIN, &mirrored));
    assert_eq!(s.out, full(MAIN));
}

#[test]
fn a_layout_split_across_reads() {
    let mut s = mac(None);
    let bytes = layout_update(None, COMBINED, &SCREENS);
    let mut seen = Vec::new();
    for b in &bytes {
        seen.extend(s.feed(std::slice::from_ref(b)));
    }
    assert_eq!(types(&seen), ["displays", "update"]);
    assert_eq!(s.out, set_display(Some(3)));
}

#[test]
fn an_unreadable_layout_is_passed_over() {
    let mut s = mac(None);
    let mut body = payload(None, COMBINED, &SCREENS);
    body[0x12..0x14].copy_from_slice(&30u16.to_be_bytes());
    let mut m = vec![0, 0, 0, 1];
    m.extend([0u8; 8]);
    m.extend(0x451i32.to_be_bytes());
    m.extend((body.len() as u16).to_be_bytes());
    m.extend(body);
    let ev = s.feed(&m);
    assert_eq!(types(&ev), ["update"]);
    assert!(s.connected());
    assert_eq!(s.out, full(COMBINED));
}

#[test]
fn the_older_display_list_is_stepped_over() {
    let mut s = mac(None);
    let mut m = vec![0, 0, 0, 1];
    m.extend([0u8; 8]);
    m.extend(0x44di32.to_be_bytes());
    m.extend([0u8; 8]);
    m.extend(2u16.to_be_bytes());
    m.extend([0u8; 2 * 0x1c]);
    let ev = s.feed(&m);
    assert_eq!(types(&ev), ["update"]);
    assert!(s.connected());
}

#[test]
fn a_server_that_is_not_a_mac_does_not_read_apples_layout() {
    let mut s = super::tests::connected(64, 64);
    let ev = s.feed(&layout_update(None, (64, 64), &SCREENS));
    assert_eq!(types(&ev), ["failed"]);
}

#[test]
fn a_request_from_the_page_ends_a_wait_the_mac_never_answers() {
    let mut s = mac(None);
    s.feed(&layout_update(None, COMBINED, &SCREENS));
    s.out.clear();
    s.request_update(true);
    assert_eq!(s.out, full(COMBINED));
    s.out.clear();
    // Auto-updates are now active; no extra request follows an incoming update.
    s.feed(&[0, 0, 0, 0]);
    assert!(s.out.is_empty());
}
