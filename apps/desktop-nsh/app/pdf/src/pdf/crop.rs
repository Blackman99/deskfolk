//! A rectangle of a page as a PNG: the crop an annotation carries.

use hayro::hayro_interpret::kurbo::Affine;
use hayro::hayro_interpret::{InterpreterSettings, TransformExt};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::vello_cpu::{self, Pixmap, RenderContext};
use hayro::{RenderCache, RenderSettings, render_into};

use super::Doc;

/// Page `index` taken as `natural_width` pixels wide, the rectangle `[sx, sy, sw, sh]` of it
/// (natural pixels) drawn into an `out[0]` × `out[1]` picture, PNG-encoded.
pub fn crop_pixmap(doc: &Doc, index: usize, natural_width: f64, rect: [f64; 4], out: [f64; 2]) -> Result<Pixmap, String> {
    let pages = doc.pdf.pages();
    let page = pages.get(index).ok_or("no such page")?;
    let (page_width, _) = page.render_dimensions();
    let [sx, sy, sw, sh] = rect;
    let (out_w, out_h) = (out[0].round().clamp(1.0, 4096.0), out[1].round().clamp(1.0, 4096.0));
    if natural_width <= 0.0 || sw <= 0.0 || sh <= 0.0 {
        return Err("empty region".to_string());
    }
    let natural = natural_width / page_width as f64;
    let transform = Affine::scale_non_uniform(out_w / sw, out_h / sh) * Affine::translate((-sx, -sy)) * Affine::scale(natural) * page.initial_transform(true).to_kurbo();
    let mut ctx = RenderContext::new(out_w as u16, out_h as u16);
    render_into(page, &RenderCache::new(), &InterpreterSettings::default(), &RenderSettings::default(), &mut ctx, transform);
    ctx.flush();
    let mut pixmap = Pixmap::new(ctx.width(), ctx.height());
    ctx.render_with(
        &mut pixmap,
        &mut vello_cpu::Resources::default(),
        vello_cpu::RasterizerSettings { target_init: vello_cpu::TargetInit::Clear(WHITE), ..Default::default() },
    );
    Ok(pixmap)
}

/// The same, PNG-encoded.
pub fn crop_png(doc: &Doc, index: usize, natural_width: f64, rect: [f64; 4], out: [f64; 2]) -> Result<Vec<u8>, String> {
    crop_pixmap(doc, index, natural_width, rect, out)?.into_png().map_err(|e| format!("cannot encode the crop: {e:?}"))
}
