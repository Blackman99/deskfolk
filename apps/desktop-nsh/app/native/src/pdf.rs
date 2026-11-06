//! PDF on every target, without a web view or a platform library: `hayro` (pure Rust) parses the
//! file and renders a page to a bitmap on demand, handed to an `Image` as a PNG data URL. The file
//! comes from the runtime (`/v1/workspace/file`), fetched here so its bytes never pass through JS.
//!
//! Not yet: encrypted PDFs (hayro has no decryption; the platforms' own renderers will cover
//! them), vector drawing through hayro's `Device` onto a canvas, and fonts for CJK text the file
//! does not embed.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};
use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;

thread_local! {
    static PDFS: RefCell<HashMap<String, Rc<Pdf>>> = RefCell::new(HashMap::new());
}

/// Documents the app previews.
#[module]
pub struct Documents;

#[module]
impl Documents {
    /// Fetches `url` (the runtime's file endpoint) with `token` and opens it as PDF `id`; resolves
    /// with its pages' sizes in points, `[width0, height0, width1, height1, …]`.
    pub async fn open_pdf(id: String, url: String, token: String) -> Result<Vec<f64>, String> {
        let response = fetch(HttpRequest::get(url).header("Authorization", format!("Bearer {token}"))).await?;
        if !response.ok() {
            return Err(format!("the runtime answered {}", response.status()));
        }
        let pdf = Pdf::new(response.body).map_err(|e| format!("not a readable PDF: {e:?}"))?;
        let sizes = pdf
            .pages()
            .iter()
            .flat_map(|page| {
                let (w, h) = page.render_dimensions();
                [w as f64, h as f64]
            })
            .collect();
        PDFS.with_borrow_mut(|pdfs| pdfs.insert(id, Rc::new(pdf)));
        Ok(sizes)
    }

    /// Page `index` (from 0) of PDF `id`, `width` pixels wide, as a PNG data URL.
    pub fn render_pdf_page(id: String, index: f64, width: f64) -> Result<String, String> {
        let pdf = PDFS.with_borrow(|pdfs| pdfs.get(&id).cloned()).ok_or("the PDF is not open")?;
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

    /// Forgets PDF `id`.
    pub fn close_pdf(id: String) {
        PDFS.with_borrow_mut(|pdfs| pdfs.remove(&id));
    }
}
