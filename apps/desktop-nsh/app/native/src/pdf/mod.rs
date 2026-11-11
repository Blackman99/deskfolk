//! PDF on every target, without a web view or a platform library: `hayro` (pure Rust) parses the
//! file and renders a page to a bitmap on demand, handed to an `Image` as a PNG data URL. The file
//! comes from the runtime (`/v1/workspace/file`), fetched here so its bytes never pass through JS.
//!
//! Besides pixels the module reads a page back, all in coordinates normalised to the page as it is
//! shown (0–1, origin at the top left, `y` down, the page's `/Rotate` applied):
//!
//! - `pdf_page_text` — the page's text as runs `{s, x, y, w, h, a, e}` (text, box, the way it reads
//!   in degrees clockwise or null when slanted, whether a line ends after it), collected from
//!   hayro's `Device::draw_glyph_run` with each glyph's Unicode (ToUnicode, encoding, glyph names);
//!   the TSX feeds them to the messenger's own find / quote code (`pdf-region.ts`).
//! - `pdf_page_links` — `/Link` annotations as `{x, y, w, h, uri | page}`.
//! - `crop_pdf_region` — a rectangle of the page rendered to a PNG, for an annotation's crop.
//! - encryption: `open_pdf` answers `"password required"` for a file that wants a password and
//!   keeps its bytes; `unlock_pdf` retries with one (`"wrong password"` when it is not it).
//!
//! Not yet: vector drawing through hayro's `Device` onto a canvas, fonts for CJK text the file does
//! not embed, JPEG for a crop that does not fit in a megabyte as PNG (no encoder in the
//! dependencies), named destinations in a name tree deeper than one level of `/Kids`, and text
//! drawn by Type3 glyph procedures.

mod crop;
mod links;
mod text;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::{DecryptionError, LoadPdfError};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};
use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;

/// An open document and what has been read from it so far (per page, as JSON).
pub(crate) struct Doc {
    /// Shared with the blocking threads a page is drawn on (`render_pdf_page_async`).
    pub(crate) pdf: Arc<Pdf>,
    texts: RefCell<HashMap<usize, Rc<String>>>,
    links: RefCell<HashMap<usize, Rc<String>>>,
}

thread_local! {
    static PDFS: RefCell<HashMap<String, Rc<Doc>>> = RefCell::new(HashMap::new());
    /// Files that asked for a password: their bytes, until `unlock_pdf` or `close_pdf`.
    static LOCKED: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
}

/// The error text of a file that needs a password, which the TSX tells from "broken".
pub const PASSWORD_REQUIRED: &str = "password required";
/// The error text of a password that is not the file's.
pub const WRONG_PASSWORD: &str = "wrong password";

fn doc(id: &str) -> Result<Rc<Doc>, String> {
    PDFS.with_borrow(|pdfs| pdfs.get(id).cloned()).ok_or_else(|| "the PDF is not open".to_string())
}

/// What reading a file's bytes as a PDF came to: the document and its pages' sizes in points
/// (`[w0, h0, w1, h1, …]`), a file that wants a password (its bytes, kept for `unlock_pdf`), or why
/// it is not one. Made on any thread; `keep` files it on the engine's.
enum Parsed {
    Ready(Pdf, Vec<f64>),
    Locked(Vec<u8>),
    Broken(String),
}

fn parse(data: Vec<u8>, password: &str) -> Parsed {
    match Pdf::new_with_password(data.clone(), password) {
        Ok(pdf) => {
            let sizes = pdf
                .pages()
                .iter()
                .flat_map(|page| {
                    let (w, h) = page.render_dimensions();
                    [w as f64, h as f64]
                })
                .collect();
            Parsed::Ready(pdf, sizes)
        }
        Err(LoadPdfError::Decryption(DecryptionError::PasswordProtected)) => Parsed::Locked(data),
        Err(e) => Parsed::Broken(format!("not a readable PDF: {e:?}")),
    }
}

/// Files `parsed` as `id`; its pages' sizes. `retry` says the password was typed by the reader,
/// so a refusal means a wrong one.
fn keep(id: String, parsed: Parsed, retry: bool) -> Result<Vec<f64>, String> {
    match parsed {
        Parsed::Ready(pdf, sizes) => {
            LOCKED.with_borrow_mut(|locked| locked.remove(&id));
            let doc = Doc { pdf: Arc::new(pdf), texts: RefCell::new(HashMap::new()), links: RefCell::new(HashMap::new()) };
            PDFS.with_borrow_mut(|pdfs| pdfs.insert(id, Rc::new(doc)));
            Ok(sizes)
        }
        Parsed::Locked(data) => {
            LOCKED.with_borrow_mut(|locked| locked.insert(id, data));
            Err(if retry { WRONG_PASSWORD } else { PASSWORD_REQUIRED }.to_string())
        }
        Parsed::Broken(why) => Err(why),
    }
}

/// Opens `data` with `password` as `id`, on this thread; its pages' sizes in points.
fn open(id: String, data: Vec<u8>, password: &str, retry: bool) -> Result<Vec<f64>, String> {
    keep(id, parse(data, password), retry)
}

/// Page `index` (from 0) of `pdf`, `width` pixels wide, as a PNG data URL.
fn render_page(pdf: &Pdf, index: f64, width: f64) -> Result<String, String> {
    let pages = pdf.pages();
    let page = pages.get(index as usize).ok_or("no such page")?;
    let (page_width, _) = page.render_dimensions();
    let scale = (width as f32 / page_width).clamp(0.1, 8.0);
    let pixmap = render(
        page,
        &RenderCache::new(),
        &InterpreterSettings::default(),
        &RenderSettings::default(),
        &PixmapSettings { x_scale: scale, y_scale: scale, bg_color: WHITE },
    );
    let png = pixmap.into_png().map_err(|e| format!("cannot encode the page: {e:?}"))?;
    Ok(format!("data:image/png;base64,{}", B64.encode(png)))
}

/// Documents the app previews.
#[module]
pub struct Documents;

#[module]
impl Documents {
    /// Fetches `url` (the runtime's file endpoint) with `token` and opens it as PDF `id`; resolves
    /// with its pages' sizes in points, `[width0, height0, width1, height1, …]`. A file that needs a
    /// password rejects with `"password required"` (and stays held for `unlock_pdf`).
    pub async fn open_pdf(id: String, url: String, token: String) -> Result<Vec<f64>, String> {
        let response = fetch(HttpRequest::get(url).header("Authorization", format!("Bearer {token}"))).await?;
        if !response.ok() {
            return Err(format!("the runtime answered {}", response.status()));
        }
        // Read on a blocking thread: a large file's cross-reference table holds the engine otherwise.
        let body = response.body;
        let parsed = blocking(move || parse(body, "")).await.map_err(|e| e.to_string())?;
        keep(id, parsed, false)
    }

    /// The same for a file whose bytes the caller has (base64), optionally with a password.
    pub fn open_pdf_bytes(id: String, base64: String, password: String) -> Result<Vec<f64>, String> {
        let data = B64.decode(base64.trim()).map_err(|e| format!("not a readable PDF: {e}"))?;
        open(id, data, &password, !password.is_empty())
    }

    /// Opens the file `id` that asked for a password with `password`: the pages' sizes as `open_pdf`,
    /// or `"wrong password"` (the file stays held for another try).
    pub fn unlock_pdf(id: String, password: String) -> Result<Vec<f64>, String> {
        let data = LOCKED.with_borrow(|locked| locked.get(&id).cloned()).ok_or("the PDF is not waiting for a password")?;
        open(id, data, &password, true)
    }

    /// Page `index` (from 0) of PDF `id`, `width` pixels wide, as a PNG data URL.
    pub fn render_pdf_page(id: String, index: f64, width: f64) -> Result<String, String> {
        render_page(&doc(&id)?.pdf, index, width)
    }

    /// The same, drawn on a blocking thread: a page of a scanned file takes 100 ms or more, which
    /// held the engine on every page scrolled into view.
    pub async fn render_pdf_page_async(id: String, index: f64, width: f64) -> Result<String, String> {
        let pdf = doc(&id)?.pdf.clone();
        blocking(move || render_page(&pdf, index, width)).await.map_err(|e| e.to_string())?
    }

    /// The text of page `index` (from 0) as JSON: `[{"s": text, "x", "y", "w", "h": box normalised
    /// to the page, "a": 0 | 90 | 180 | 270 | null, "e": a line ends after it}]`, in the order the
    /// file draws it.
    pub fn pdf_page_text(id: String, index: f64) -> Result<String, String> {
        let doc = doc(&id)?;
        let index = index as usize;
        if let Some(found) = doc.texts.borrow().get(&index) {
            return Ok(found.as_str().to_string());
        }
        let json = Rc::new(text::page_text_json(&doc, index)?);
        doc.texts.borrow_mut().insert(index, json.clone());
        Ok(json.as_str().to_string())
    }

    /// The links on page `index` (from 0) as JSON: `[{"x", "y", "w", "h": box normalised to the
    /// page, "uri": string | "page": 1-based number}]`.
    pub fn pdf_page_links(id: String, index: f64) -> Result<String, String> {
        let doc = doc(&id)?;
        let index = index as usize;
        if let Some(found) = doc.links.borrow().get(&index) {
            return Ok(found.as_str().to_string());
        }
        let json = Rc::new(links::page_links_json(&doc, index)?);
        doc.links.borrow_mut().insert(index, json.clone());
        Ok(json.as_str().to_string())
    }

    /// A rectangle of page `index` as a base64 PNG. The page is taken as `natural_width` pixels wide
    /// (the crop is cut from the page at twice its 100% size); `sx, sy, sw, sh` is the rectangle in
    /// those pixels and `out_width` × `out_height` the picture's size.
    #[allow(clippy::too_many_arguments)]
    pub fn crop_pdf_region(
        id: String,
        index: f64,
        natural_width: f64,
        sx: f64,
        sy: f64,
        sw: f64,
        sh: f64,
        out_width: f64,
        out_height: f64,
    ) -> Result<String, String> {
        let doc = doc(&id)?;
        crop::crop_png(&doc, index as usize, natural_width, [sx, sy, sw, sh], [out_width, out_height]).map(|png| B64.encode(png))
    }

    /// Forgets PDF `id`.
    pub fn close_pdf(id: String) {
        PDFS.with_borrow_mut(|pdfs| pdfs.remove(&id));
        LOCKED.with_borrow_mut(|locked| locked.remove(&id));
    }
}
