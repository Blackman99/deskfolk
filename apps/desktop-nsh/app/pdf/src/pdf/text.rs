//! A page's text, read back through hayro's `Device`: every glyph run the interpreter draws (the
//! invisible text of scans included) becomes one run with the Unicode of its glyphs and its box.

use hayro::hayro_interpret::font::{Glyph, GlyphRun};
use hayro::hayro_interpret::hayro_cmap::{BfString, WritingMode};
use hayro::hayro_interpret::hayro_syntax::object::Dict;
use hayro::hayro_interpret::kurbo::{Affine, BezPath, Rect};
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache, InterpreterSettings, SoftMask, TransformExt,
    interpret_page,
};
use serde::Serialize;

use super::Doc;

/// Glyph box in glyph units (1000 per em): from a fifth of an em below the baseline to 85% above,
/// the messenger's `textRunsFromItems`.
const DESCENT: f64 = -200.0;
const ASCENT: f64 = 850.0;
/// The advance assumed for a glyph the font gives none for.
const DEFAULT_ADVANCE: f64 = 500.0;
/// A gap wider than this share of an em between two glyphs of a run reads as a space.
const SPACE_GAP_EM: f64 = 0.2;

/// One run of text on a page.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Run {
    pub s: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Degrees clockwise the run reads (0, 90, 180, 270); null when it is slanted.
    pub a: Option<u16>,
    /// A line ends after it.
    pub e: bool,
}

/// The way a baseline direction `(dx, dy)` (y down) reads: snapped to an axis within about 10°.
fn reading_angle(dx: f64, dy: f64) -> Option<u16> {
    let len = dx.hypot(dy);
    if !len.is_finite() || len == 0.0 {
        return None;
    }
    let slack = (std::f64::consts::PI / 18.0).sin();
    if dy.abs() <= slack * len {
        return Some(if dx > 0.0 { 0 } else { 180 });
    }
    if dx.abs() <= slack * len {
        return Some(if dy > 0.0 { 90 } else { 270 });
    }
    None
}

struct Collector {
    runs: Vec<Run>,
    /// The page's size in points, to normalise by.
    size: (f64, f64),
    /// First glyph's transform and glyph count of the last run, to drop the stroke that follows an
    /// identical fill (fill-and-stroke text is drawn twice).
    last: Option<([f64; 6], usize)>,
}

impl Collector {
    fn add(&mut self, run: &GlyphRun<'_, '_>, base: Affine, mode: &DrawMode) {
        let glyphs = run.glyphs();
        let Some(first) = glyphs.first() else { return };
        let key = ((base * first.transform()).as_coeffs(), glyphs.len());
        let stroke = matches!(mode, DrawMode::Stroke(_));
        if stroke && self.last == Some(key) {
            return;
        }
        self.last = Some(key);
        let vertical = run.writing_mode() == WritingMode::Vertical;

        let mut text = String::new();
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        // Where the previous glyph ends (device points) and its em axis, to see a gap.
        let mut prev_end: Option<(f64, f64)> = None;
        let mut direction = (0.0, 0.0);
        let mut ended_with_space = true;
        for glyph in glyphs {
            let m = base * glyph.transform();
            let [a, b, _, _, e, f] = m.as_coeffs();
            let advance = if vertical { 1000.0 } else { advance_of(glyph) };
            let ch = glyph.as_unicode().map(|u| match u {
                BfString::Char(c) => c.to_string(),
                BfString::String(s) => s,
            });
            // The glyph's own box, whatever it draws as.
            for (gx, gy) in [(0.0, DESCENT), (advance, DESCENT), (0.0, ASCENT), (advance, ASCENT)] {
                let p = m * hayro::hayro_interpret::kurbo::Point::new(gx, gy);
                x0 = x0.min(p.x);
                y0 = y0.min(p.y);
                x1 = x1.max(p.x);
                y1 = y1.max(p.y);
            }
            let Some(ch) = ch else {
                prev_end = Some((e + a * advance, f + b * advance));
                continue;
            };
            let is_space = ch.chars().all(char::is_whitespace);
            if let Some((px, py)) = prev_end {
                // Distance from where the last glyph ended to this one's origin, along the line, in ems.
                let em = a.hypot(b) * 1000.0;
                if em > 0.0 && !is_space && !ended_with_space {
                    let along = ((e - px) * a + (f - py) * b) / (a.hypot(b));
                    if along / em > SPACE_GAP_EM {
                        text.push(' ');
                    }
                }
            }
            if text.is_empty() {
                direction = (a, b);
            }
            text.push_str(&ch);
            ended_with_space = is_space;
            prev_end = Some((e + a * advance, f + b * advance));
        }
        if text.trim().is_empty() || !x0.is_finite() {
            return;
        }
        let (pw, ph) = self.size;
        let clamp = |v: f64| v.clamp(0.0, 1.0);
        let (nx0, ny0, nx1, ny1) = (clamp(x0 / pw), clamp(y0 / ph), clamp(x1 / pw), clamp(y1 / ph));
        let angle = if vertical { Some(90) } else { reading_angle(direction.0, direction.1) };
        self.runs.push(Run { s: text, x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0, a: angle, e: false });
    }
}

fn advance_of(glyph: &Glyph<'_>) -> f64 {
    match glyph {
        Glyph::Outline(g) => g.advance_width().map(f64::from).unwrap_or(DEFAULT_ADVANCE),
        Glyph::Type3(g) => g.advance_width().map(f64::from).unwrap_or(DEFAULT_ADVANCE),
    }
}

impl<'a> Device<'a> for Collector {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, mode: &DrawMode) {
        self.add(run, props.transform, mode);
    }
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
    fn begin_marked_content(&mut self, _: &[u8], _: Option<&Dict<'_>>) {}
}

/// Marks where a line ends: the next run is on another line when it sits across the reading
/// direction by more than half a line, or starts back along it.
fn mark_line_ends(runs: &mut [Run]) {
    for i in 0..runs.len().saturating_sub(1) {
        let (a, b) = (&runs[i], &runs[i + 1]);
        // Along the line / across it, in the first run's reading frame.
        let vertical = matches!(a.a, Some(90) | Some(270));
        let (a_across, a_size, b_across) = if vertical { (a.x + a.w / 2.0, a.w, b.x + b.w / 2.0) } else { (a.y + a.h / 2.0, a.h, b.y + b.h / 2.0) };
        let (a_along_end, b_along_start) = if vertical {
            (if a.a == Some(270) { a.y } else { a.y + a.h }, if a.a == Some(270) { b.y + b.h } else { b.y })
        } else {
            (if a.a == Some(180) { a.x } else { a.x + a.w }, if a.a == Some(180) { b.x + b.w } else { b.x })
        };
        let new_line = (b_across - a_across).abs() > a_size * 0.5;
        let backwards = if matches!(a.a, Some(180) | Some(270)) { b_along_start > a_along_end + a_size } else { b_along_start < a_along_end - a_size };
        runs[i].e = new_line || backwards;
    }
    if let Some(last) = runs.last_mut() {
        last.e = true;
    }
}

/// Page `index`'s runs, interpreted once.
pub fn page_runs(doc: &Doc, index: usize) -> Result<Vec<Run>, String> {
    let pages = doc.pdf.pages();
    let page = pages.get(index).ok_or("no such page")?;
    let (w, h) = page.render_dimensions();
    let transform = page.initial_transform(true).to_kurbo();
    let cache = InterpreterCache::new();
    let mut context = Context::new(transform, Rect::new(0.0, 0.0, w as f64, h as f64), &cache, page.xref(), InterpreterSettings::default());
    let mut collector = Collector { runs: Vec::new(), size: (w as f64, h as f64), last: None };
    interpret_page(page, &mut context, &mut collector);
    mark_line_ends(&mut collector.runs);
    Ok(collector.runs)
}

pub fn page_text_json(doc: &Doc, index: usize) -> Result<String, String> {
    let runs = page_runs(doc, index)?;
    serde_json::to_string(&runs).map_err(|e| e.to_string())
}
