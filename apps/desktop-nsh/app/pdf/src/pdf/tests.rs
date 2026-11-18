//! Tests with PDFs written by hand: text, find-ready runs, links, passwords and crops.

use super::*;
use md5::{Digest, Md5};

/// An object of a test file: a dictionary / value as text, or a stream (dictionary entries + data).
enum Obj {
    Plain(String),
    Stream(String, Vec<u8>),
}

fn plain(s: &str) -> Obj {
    Obj::Plain(s.to_string())
}

fn stream(entries: &str, data: &str) -> Obj {
    Obj::Stream(entries.to_string(), data.as_bytes().to_vec())
}

const PADDING: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE,
    0x64, 0x53, 0x69, 0x7A,
];

fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut s: Vec<u8> = (0..=255).collect();
    let mut j = 0usize;
    for i in 0..256 {
        j = (j + s[i] as usize + key[i % key.len()] as usize) % 256;
        s.swap(i, j);
    }
    let (mut i, mut j) = (0usize, 0usize);
    data.iter()
        .map(|byte| {
            i = (i + 1) % 256;
            j = (j + s[i] as usize) % 256;
            s.swap(i, j);
            byte ^ s[(s[i] as usize + s[j] as usize) % 256]
        })
        .collect()
}

fn md5(data: &[u8]) -> Vec<u8> {
    Md5::digest(data).to_vec()
}

/// The file key of the standard security handler, revision 2 (40-bit RC4), for `password`.
fn file_key(password: &str, owner: &[u8], permissions: i32, id: &[u8]) -> Vec<u8> {
    let mut padded = password.as_bytes().to_vec();
    padded.extend_from_slice(&PADDING);
    padded.truncate(32);
    let mut input = padded;
    input.extend_from_slice(owner);
    input.extend_from_slice(&permissions.to_le_bytes());
    input.extend_from_slice(id);
    md5(&input)[..5].to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes the objects (numbered from 1) with a cross-reference table; `trailer` is the rest of the
/// trailer dictionary. With `password`, streams are encrypted with it (user password) and the
/// encryption dictionary is added as the last object.
fn build(objs: &[Obj], trailer: &str, password: Option<&str>) -> Vec<u8> {
    let id = b"0123456789abcdef";
    let owner = [7u8; 32];
    let permissions = -4i32;
    let key = password.map(|p| file_key(p, &owner, permissions, id));
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, obj) in objs.iter().enumerate() {
        let number = i + 1;
        offsets.push(out.len());
        out.extend_from_slice(format!("{number} 0 obj\n").as_bytes());
        match obj {
            Obj::Plain(s) => out.extend_from_slice(s.as_bytes()),
            Obj::Stream(entries, data) => {
                let data = match &key {
                    Some(key) => {
                        let mut k = key.clone();
                        k.extend_from_slice(&(number as u32).to_le_bytes()[..3]);
                        k.extend_from_slice(&[0, 0]);
                        rc4(&md5(&k)[..10], data)
                    }
                    None => data.clone(),
                };
                out.extend_from_slice(format!("<< {entries} /Length {} >>\nstream\n", data.len()).as_bytes());
                out.extend_from_slice(&data);
                out.extend_from_slice(b"\nendstream");
            }
        }
        out.extend_from_slice(b"\nendobj\n");
    }
    let mut extra = String::new();
    if let Some(key) = &key {
        let number = objs.len() + 1;
        offsets.push(out.len());
        let user = rc4(key, &PADDING);
        out.extend_from_slice(
            format!("{number} 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <{}> /U <{}> /P {permissions} >>\nendobj\n", hex(&owner), hex(&user)).as_bytes(),
        );
        extra = format!(" /Encrypt {number} 0 R /ID [<{}> <{}>]", hex(id), hex(id));
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).as_bytes());
    for offset in &offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R{extra} {trailer} >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1).as_bytes());
    out
}

/// One 612×792 page with `content`, Helvetica as /F1, and extra page entries.
fn one_page(content: &str, page_extra: &str, more: Vec<Obj>) -> Vec<Obj> {
    let mut objs = vec![
        plain("<< /Type /Catalog /Pages 2 0 R >>"),
        plain("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        plain(&format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> {page_extra} >>")),
        stream("", content),
        plain("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ];
    objs.extend(more);
    objs
}

fn open_bytes(id: &str, data: Vec<u8>) -> Rc<Doc> {
    open(id.to_string(), data, "", false).expect("opens");
    doc(id).unwrap()
}

fn runs(doc: &Doc, index: usize) -> Vec<text::Run> {
    text::page_runs(doc, index).unwrap()
}

#[test]
fn text_comes_back_with_its_box_in_page_fractions() {
    let doc = open_bytes("t-text", build(&one_page("BT /F1 24 Tf 72 692 Td (Page 1 of 3) Tj ET", "", vec![]), "", None));
    let found = runs(&doc, 0);
    assert_eq!(found.len(), 1);
    let run = &found[0];
    assert_eq!(run.s, "Page 1 of 3");
    assert_eq!(run.a, Some(0));
    assert!(run.e);
    // Starts at x = 72pt of 612, the baseline at 692pt from the bottom: the box spans -0.2..0.85 em of 24pt.
    assert!((run.x - 72.0 / 612.0).abs() < 0.002, "x {}", run.x);
    let top = (792.0 - 692.0 - 0.85 * 24.0) / 792.0;
    assert!((run.y - top).abs() < 0.003, "y {}", run.y);
    assert!((run.h - 1.05 * 24.0 / 792.0).abs() < 0.003, "h {}", run.h);
    // Helvetica's widths for "Page 1 of 3": 5115 units, so 122.8pt at 24pt.
    assert!((run.w * 612.0 - 122.8).abs() < 1.5, "w {}", run.w * 612.0);
}

#[test]
fn lines_end_and_stay_apart_in_order() {
    let content = "BT /F1 12 Tf 72 700 Td (first line) Tj 0 -20 Td (second line) Tj ET BT /F1 12 Tf 200 700 Td (beside) Tj ET";
    let doc = open_bytes("t-lines", build(&one_page(content, "", vec![]), "", None));
    let found = runs(&doc, 0);
    let texts: Vec<_> = found.iter().map(|r| r.s.as_str()).collect();
    assert_eq!(texts, ["first line", "second line", "beside"]);
    assert!(found[0].e && found[1].e && found[2].e);
}

#[test]
fn a_gap_in_a_run_reads_as_a_space() {
    // A TJ with a wide kern between two words that have no space glyph.
    let content = "BT /F1 12 Tf 72 700 Td [(Hello) -600 (World)] TJ ET";
    let doc = open_bytes("t-gap", build(&one_page(content, "", vec![]), "", None));
    assert_eq!(runs(&doc, 0)[0].s, "Hello World");
    let tight = "BT /F1 12 Tf 72 700 Td [(Hel) 20 (lo)] TJ ET";
    let doc = open_bytes("t-tight", build(&one_page(tight, "", vec![]), "", None));
    assert_eq!(runs(&doc, 0)[0].s, "Hello");
}

#[test]
fn a_tounicode_map_gives_cjk_text() {
    let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def \
        1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <41> <4E2D> <42> <6587> endbfchar endcmap end end";
    let mut objs = one_page("BT /F1 12 Tf 72 700 Td (AB) Tj ET", "", vec![stream("", cmap)]);
    objs[4] = plain("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>");
    let doc = open_bytes("t-cjk", build(&objs, "", None));
    assert_eq!(runs(&doc, 0)[0].s, "中文");
}

#[test]
fn fill_and_stroke_text_is_read_once() {
    let doc = open_bytes("t-bold", build(&one_page("BT /F1 12 Tf 2 Tr 72 700 Td (Bold) Tj ET", "", vec![]), "", None));
    let found = runs(&doc, 0);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].s, "Bold");
}

#[test]
fn invisible_text_is_read() {
    let doc = open_bytes("t-ocr", build(&one_page("BT /F1 12 Tf 3 Tr 72 700 Td (scanned words) Tj ET", "", vec![]), "", None));
    assert_eq!(runs(&doc, 0)[0].s, "scanned words");
}

#[test]
fn a_turned_page_reports_the_text_as_it_is_shown() {
    let doc = open_bytes("t-rot", build(&one_page("BT /F1 12 Tf 72 700 Td (turned) Tj ET", "/Rotate 90", vec![]), "", None));
    let run = &runs(&doc, 0)[0];
    // Shown turned a quarter clockwise: the line reads top to bottom, near the right edge.
    assert_eq!(run.a, Some(90));
    assert!(run.x > 0.8, "x {}", run.x);
    assert!(run.h > run.w);
}

#[test]
fn links_carry_uris_and_pages() {
    let annots = "/Annots [6 0 R 7 0 R 8 0 R 9 0 R]";
    let more = vec![
        plain("<< /Type /Annot /Subtype /Link /Rect [72 700 172 720] /A << /S /URI /URI (https://example.com/a) >> >>"),
        plain("<< /Type /Annot /Subtype /Link /Rect [72 600 172 620] /A << /S /GoTo /D [10 0 R /XYZ 0 792 0] >> >>"),
        plain("<< /Type /Annot /Subtype /Link /Rect [72 500 172 520] /Dest (chapter) >>"),
        plain("<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (note) >>"),
        plain("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
    ];
    let mut objs = one_page("BT /F1 12 Tf 72 700 Td (go) Tj ET", annots, more);
    objs[0] = plain("<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(chapter) [10 0 R /Fit]] >> >> >>");
    objs[1] = plain("<< /Type /Pages /Kids [3 0 R 10 0 R] /Count 2 >>");
    let doc = open_bytes("t-links", build(&objs, "", None));
    let links = links::page_links(&doc, 0).unwrap();
    assert_eq!(links.len(), 3, "{links:?}");
    assert_eq!(links[0].uri.as_deref(), Some("https://example.com/a"));
    assert!((links[0].x - 72.0 / 612.0).abs() < 1e-6);
    assert!((links[0].y - (792.0 - 720.0) / 792.0).abs() < 1e-6);
    assert!((links[0].w - 100.0 / 612.0).abs() < 1e-6 && (links[0].h - 20.0 / 792.0).abs() < 1e-6);
    assert_eq!(links[1].page, Some(2));
    assert_eq!(links[2].page, Some(2));
    assert!(links::page_links(&doc, 1).unwrap().is_empty());
}

#[test]
fn a_password_protected_file_asks_then_opens() {
    let bytes = build(&one_page("BT /F1 12 Tf 72 700 Td (secret words) Tj ET", "", vec![]), "", Some("open sesame"));
    let b64 = B64.encode(&bytes);
    assert_eq!(Documents::open_pdf_bytes("t-lock".into(), b64.clone(), String::new()).unwrap_err(), PASSWORD_REQUIRED);
    assert_eq!(Documents::unlock_pdf("t-lock".into(), "nope".into()).unwrap_err(), WRONG_PASSWORD);
    let sizes = Documents::unlock_pdf("t-lock".into(), "open sesame".into()).unwrap();
    assert_eq!(sizes, vec![612.0, 792.0]);
    let json = Documents::pdf_page_text("t-lock".into(), 0.0).unwrap();
    assert!(json.contains("secret words"), "{json}");
    // Straight in with the right password, and a file that is not a PDF at all.
    assert!(Documents::open_pdf_bytes("t-lock2".into(), b64, "open sesame".into()).is_ok());
    let broken = Documents::open_pdf_bytes("t-broken".into(), B64.encode("this is not a pdf"), String::new()).unwrap_err();
    assert!(broken.starts_with("not a readable PDF"), "{broken}");
    Documents::close_pdf("t-lock".into());
    assert_eq!(Documents::unlock_pdf("t-lock".into(), "open sesame".into()).unwrap_err(), "the PDF is not waiting for a password");
}

#[test]
fn a_crop_is_a_png_of_the_asked_size_with_the_page_in_it() {
    let doc = open_bytes("t-crop", build(&one_page("0 0 0 rg 100 100 200 200 re f", "", vec![]), "", None));
    // The page at twice its CSS size (612pt is 816px, so 1632px); the black square spans x 100..300pt, y (from the top) 492..692pt.
    let natural = 1632.0;
    let k = natural / 612.0;
    let png = crop::crop_png(&doc, 0, natural, [90.0 * k, 482.0 * k, 220.0 * k, 220.0 * k], [110.0, 110.0]).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let (width, height) = (u32::from_be_bytes(png[16..20].try_into().unwrap()), u32::from_be_bytes(png[20..24].try_into().unwrap()));
    assert_eq!((width, height), (110, 110));
    // The square fills the middle of the picture, the margin around it is the page's white.
    let pixmap = crop::crop_pixmap(&doc, 0, natural, [90.0 * k, 482.0 * k, 220.0 * k, 220.0 * k], [110.0, 110.0]).unwrap();
    let (middle, corner) = (pixmap.sample(55, 55), pixmap.sample(2, 2));
    assert_eq!((middle.r, middle.g, middle.b), (0, 0, 0));
    assert_eq!((corner.r, corner.g, corner.b), (255, 255, 255));
    let text = Documents::crop_pdf_region("t-crop".into(), 0.0, natural, 0.0, 0.0, natural, 100.0, 306.0, 20.0).unwrap();
    assert!(B64.decode(text).is_ok());
    assert!(Documents::crop_pdf_region("t-crop".into(), 5.0, natural, 0.0, 0.0, 10.0, 10.0, 10.0, 10.0).is_err());
}

/// Prints the encrypted file the story `files-pdf` embeds (password `open sesame`):
/// `cargo test print_locked_fixture -- --ignored --nocapture`.
#[test]
#[ignore]
fn print_locked_fixture() {
    let objs = one_page("BT /F1 24 Tf 72 692 Td (Secret page words) Tj ET", "", vec![]);
    println!("LOCKED={}", B64.encode(build(&objs, "", Some("open sesame"))));
}
