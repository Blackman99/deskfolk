//! A page's links: `/Link` annotations with a `/URI` action or a destination inside the document.

use hayro::hayro_interpret::TransformExt;
use hayro::hayro_interpret::hayro_syntax::object::{Array, Dict, MaybeRef, Name, Object, String as PdfString};
use hayro::hayro_interpret::kurbo::Point;
use serde::Serialize;

use super::Doc;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Link {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// 1-based.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
}

/// A PDF text string: UTF-16BE with a byte-order mark, otherwise taken as UTF-8 / Latin-1.
fn text_of(bytes: &[u8]) -> String {
    if let [0xFE, 0xFF, rest @ ..] = bytes {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// The page (0-based) a destination points at: `[page /XYZ …]` with a page object or, in a remote
/// style, its number; a name or string is looked up in the document's name tables.
fn dest_page(doc: &Doc, dest: &Object<'_>, depth: u8) -> Option<usize> {
    match dest {
        Object::Array(array) => array_dest_page(doc, array),
        Object::Name(name) => named_dest(doc, name.as_ref(), depth),
        Object::String(string) => named_dest(doc, string.as_bytes(), depth),
        Object::Dict(dict) => dict.get::<Object<'_>>("D").and_then(|d| dest_page(doc, &d, depth)),
        _ => None,
    }
}

fn array_dest_page(doc: &Doc, array: &Array<'_>) -> Option<usize> {
    let first = array.raw_iter().next()?;
    match first {
        MaybeRef::Ref(r) => doc.pdf.pages().iter().position(|page| page.raw().obj_id().is_some_and(|id| id.obj_number == r.obj_number)),
        MaybeRef::NotRef(Object::Number(n)) => usize::try_from(n.as_i64()).ok().filter(|&i| i < doc.pdf.pages().len()),
        _ => None,
    }
}

/// A named destination, from the catalog's `/Dests` dictionary or its `/Names /Dests` name tree.
fn named_dest(doc: &Doc, name: &[u8], depth: u8) -> Option<usize> {
    if depth > 2 {
        return None;
    }
    let xref = doc.pdf.xref();
    let catalog = xref.get::<Dict<'_>>(xref.root_id())?;
    if let Some(dests) = catalog.get::<Dict<'_>>("Dests")
        && let Some(found) = dests.get::<Object<'_>>(name)
    {
        return dest_page(doc, &found, depth + 1);
    }
    let tree = catalog.get::<Dict<'_>>("Names")?.get::<Dict<'_>>("Dests")?;
    let found = tree_lookup(&tree, name, 0)?;
    dest_page(doc, &found, depth + 1)
}

fn tree_lookup<'a>(node: &Dict<'a>, name: &[u8], depth: u8) -> Option<Object<'a>> {
    if let Some(names) = node.get::<Array<'a>>("Names") {
        let mut items = names.flex_iter();
        while let Some(key) = items.next::<PdfString<'a>>() {
            let value = items.next::<Object<'a>>()?;
            if key.as_bytes() == name {
                return Some(value);
            }
        }
    }
    if depth < 6
        && let Some(kids) = node.get::<Array<'a>>("Kids")
    {
        for kid in kids.iter::<Dict<'a>>() {
            if let Some(found) = tree_lookup(&kid, name, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

pub fn page_links(doc: &Doc, index: usize) -> Result<Vec<Link>, String> {
    let pages = doc.pdf.pages();
    let page = pages.get(index).ok_or("no such page")?;
    let (pw, ph) = page.render_dimensions();
    let (pw, ph) = (pw as f64, ph as f64);
    let transform = page.initial_transform(true).to_kurbo();
    let mut out = Vec::new();
    let Some(annots) = page.raw().get::<Array<'_>>("Annots") else { return Ok(out) };
    for annot in annots.iter::<Dict<'_>>() {
        if annot.get::<Name<'_>>("Subtype").is_none_or(|n| n.as_ref() != b"Link") {
            continue;
        }
        let Some(rect) = annot.get::<Array<'_>>("Rect") else { continue };
        let numbers: Vec<f32> = rect.iter::<f32>().collect();
        let [x0, y0, x1, y1] = numbers[..] else { continue };
        let corners = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)].map(|(x, y)| transform * Point::new(x as f64, y as f64));
        let left = corners.iter().map(|p| p.x).fold(f64::INFINITY, f64::min).clamp(0.0, pw);
        let right = corners.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max).clamp(0.0, pw);
        let top = corners.iter().map(|p| p.y).fold(f64::INFINITY, f64::min).clamp(0.0, ph);
        let bottom = corners.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max).clamp(0.0, ph);
        if right <= left || bottom <= top {
            continue;
        }
        let (x, y, w, h) = (left / pw, top / ph, (right - left) / pw, (bottom - top) / ph);
        let mut uri = None;
        let mut target = None;
        if let Some(action) = annot.get::<Dict<'_>>("A") {
            match action.get::<Name<'_>>("S").map(|n| n.as_ref().to_vec()).as_deref() {
                Some(b"URI") => uri = action.get::<PdfString<'_>>("URI").map(|s| text_of(s.as_bytes())),
                Some(b"GoTo") => target = action.get::<Object<'_>>("D").and_then(|d| dest_page(doc, &d, 0)),
                _ => {}
            }
        } else if let Some(dest) = annot.get::<Object<'_>>("Dest") {
            target = dest_page(doc, &dest, 0);
        }
        if uri.is_some() {
            out.push(Link { x, y, w, h, uri, page: None });
        } else if let Some(page) = target {
            out.push(Link { x, y, w, h, uri: None, page: Some(page + 1) });
        }
    }
    Ok(out)
}

pub fn page_links_json(doc: &Doc, index: usize) -> Result<String, String> {
    serde_json::to_string(&page_links(doc, index)?).map_err(|e| e.to_string())
}
