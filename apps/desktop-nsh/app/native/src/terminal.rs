//! A runtime terminal, held and drawn on NSH itself so it runs on every target: `vt100` keeps the
//! screen (pure Rust, builds for wasm), a `canvas` draws it — runs of plain characters that share a
//! look as one text each, wide characters on their own two cells — and TSX feeds it the runtime's
//! bytes (`Terminals.reset` / `Terminals.feed`, deduplicated by stream offset).
//!
//! The module's functions change the screen only; they touch no signal (a plain module call runs
//! outside the reactive runtime). TSX moves the grid's `version` prop after each change, which
//! makes the drawing again.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use nsh_core::canvas::CanvasTextBaseline;
use nsh_core::prelude::*;

use crate::palette::{Palette, Rgb, hex};

const PAD: f32 = 8.0;
const SCROLLBACK: usize = 10_000;

struct Screen {
    parser: vt100::Parser,
    /// The stream offset the screen has reached.
    next: u64,
    /// A cell's size in points, as the grid last drew it (`Terminals.caret`).
    cell: Option<(f32, f32)>,
}

thread_local! {
    static SCREENS: RefCell<HashMap<String, Rc<RefCell<Screen>>>> = RefCell::new(HashMap::new());
}

fn screen(id: &str) -> Rc<RefCell<Screen>> {
    SCREENS.with_borrow_mut(|screens| {
        screens
            .entry(id.to_owned())
            .or_insert_with(|| {
                Rc::new(RefCell::new(Screen { parser: vt100::Parser::new(24, 80, SCROLLBACK), next: 0, cell: None }))
            })
            .clone()
    })
}

/// Bytes of a frame not seen yet: `None` when the whole frame was.
pub fn unseen(next: u64, offset: u64, bytes: &[u8]) -> Option<&[u8]> {
    let end = offset + bytes.len() as u64;
    if end <= next {
        None
    } else if offset >= next {
        Some(bytes)
    } else {
        Some(&bytes[(next - offset) as usize..])
    }
}

/// The runtime's terminals as screens: what the app feeds them.
#[module]
pub struct Terminals;

#[module]
impl Terminals {
    /// Starts terminal `id` over from the runtime's replay of its screen (`GET …/screen`): its
    /// size, its bytes (base64) and the offset the stream goes on from.
    pub fn reset(id: String, rows: f64, cols: f64, data: String, offset: f64) {
        let screen = screen(&id);
        let mut screen = screen.borrow_mut();
        screen.parser = vt100::Parser::new(rows.max(1.0) as u16, cols.max(1.0) as u16, SCROLLBACK);
        screen.parser.process(&B64.decode(data.as_bytes()).unwrap_or_default());
        screen.next = offset as u64;
    }

    /// Bytes of the runtime's stream for `id` (base64), from `offset`; what the screen already
    /// has is skipped. Returns whether anything was new.
    pub fn feed(id: String, data: String, offset: f64) -> bool {
        let bytes = B64.decode(data.as_bytes()).unwrap_or_default();
        let screen = screen(&id);
        let mut screen = screen.borrow_mut();
        let Some(fresh) = unseen(screen.next, offset as u64, &bytes) else { return false };
        screen.parser.process(fresh);
        screen.next = offset as u64 + bytes.len() as u64;
        // Output returns the view to the live screen, as in every terminal.
        screen.parser.screen_mut().set_scrollback(0);
        true
    }

    /// Scrolls `id`'s view `lines` into its history (negative: back toward the live screen).
    pub fn scroll(id: String, lines: f64) {
        let screen = screen(&id);
        let mut screen = screen.borrow_mut();
        let now = screen.parser.screen().scrollback() as f64;
        screen.parser.screen_mut().set_scrollback((now + lines).max(0.0) as usize);
    }

    /// Whether the program asked for application cursor keys, and for bracketed paste.
    pub fn modes(id: String) -> Vec<bool> {
        let screen = screen(&id);
        let screen = screen.borrow();
        vec![screen.parser.screen().application_cursor(), screen.parser.screen().bracketed_paste()]
    }

    /// Where the cursor of `id` is drawn, in points from the grid's top-left: `[x, y, cell width,
    /// cell height]`, or empty while the view is back in the history or before the grid has drawn
    /// (it measures the cells: a module call cannot, outside the reactive runtime). A program that
    /// hides the cursor still has one: an input method composes there.
    pub fn caret(id: String) -> Vec<f64> {
        let screen = screen(&id);
        let screen = screen.borrow();
        let Some(cell) = screen.cell else { return Vec::new() };
        let s = screen.parser.screen();
        caret_box(s.cursor_position(), s.size().0, s.scrollback() == 0, cell)
    }

    /// Forgets terminal `id`.
    pub fn close(id: String) {
        SCREENS.with_borrow_mut(|screens| screens.remove(&id));
    }
}

/// The props of [`TerminalGrid`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TerminalGridProps {
    /// The runtime's terminal id (fixed for the element's life).
    pub id: Prop<SharedString>,
    /// The font size in points (13 when left out).
    #[prop(default = 13.0)]
    pub font_size: Prop<f64>,
    /// Draw on the dark ground.
    pub dark: Prop<bool>,
    /// Draw the cursor as the keyboard's (filled) rather than an outline.
    pub focused: Prop<bool>,
    /// Moved by the app after every change it makes through `Terminals`: the screen is drawn again.
    pub version: Prop<f64>,
    /// What an input method is composing (pinyin before a character is chosen): drawn at the
    /// cursor, underlined, the cursor after it.
    #[prop(default)]
    pub preedit: Prop<SharedString>,
}

/// The events of a [`TerminalGrid`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TerminalGridEvent {
    /// The grid that fits the element changed: the pty should take this size.
    #[args(rows, cols)]
    Resize(u32, u32),
}

fn font(size: f64) -> String {
    format!("{size}px Menlo, Consolas, \"DejaVu Sans Mono\", monospace")
}

/// A cell's width and height at `font_size`, in points.
fn cell_size(font_size: f64) -> (f32, f32) {
    let width = measure_text(&font(font_size), "M").0;
    (width.max(1.0), (font_size as f32 * 1.25).ceil())
}

/// The cursor's box (`Terminals.caret`): `[x, y, width, height]` of the cell at `(row, col)`, or
/// empty when it is not on the screen shown.
fn caret_box((row, col): (u16, u16), rows: u16, live: bool, (cw, ch): (f32, f32)) -> Vec<f64> {
    if !live || row >= rows {
        return Vec::new();
    }
    vec![(PAD + col as f32 * cw) as f64, (PAD + row as f32 * ch) as f64, cw as f64, ch as f64]
}

/// One of the runtime's terminals, drawn: fills its element; reports the rows and columns that fit.
#[component]
pub fn TerminalGrid(props: TerminalGridProps, cx: Scope<TerminalGridEvent>) -> impl IntoElement {
    let id = props.id.get_untracked().to_string();
    let shared = screen(&id);
    let area = signal((0.0_f32, 0.0_f32));
    // Moves when a layout changed the screen's size (after the screen is let go).
    let resized_tick = signal(0_u64);
    let cell = move || cell_size(props.font_size.get());
    let resized = {
        let shared = shared.clone();
        move |frame: &Bounds<Points>| {
            let (w, h) = (frame.size.width.0, frame.size.height.0);
            let (cw, ch) = cell();
            let cols = ((w - 2.0 * PAD) / cw).floor().max(2.0) as u16;
            let rows = ((h - 2.0 * PAD) / ch).floor().max(1.0) as u16;
            let grew = {
                let mut screen = shared.borrow_mut();
                let differs = screen.parser.screen().size() != (rows, cols);
                if differs {
                    screen.parser.screen_mut().set_size(rows, cols);
                }
                differs
            };
            area.set((w, h));
            if grew {
                resized_tick.update(|t| *t += 1);
                cx.emit(TerminalGridEvent::Resize(rows as u32, cols as u32));
            }
        }
    };
    let draw = move || {
        props.version.get();
        resized_tick.get();
        let mut screen = shared.borrow_mut();
        let palette = Palette::new(props.dark.get());
        let (w, h) = area.get();
        let (cw, ch) = cell();
        screen.cell = Some((cw, ch));
        let font = font(props.font_size.get());
        let preedit = props.preedit.get();
        paint(&screen.parser, &palette, &font, (cw, ch), (w, h), props.focused.get(), &preedit)
    };
    canvas(draw).flex_1().on_layout(resized)
}

/// The drawing of a screen: the ground, the cells by runs, what an input method composes, the cursor.
fn paint(parser: &vt100::Parser, palette: &Palette, font: &str, cell: (f32, f32), area: (f32, f32), focused: bool, preedit: &str) -> Painter {
    let (cw, ch) = cell;
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let mut p = Painter::new()
        .fill_color(rgb(hex(palette.background)))
        .fill_rect(0.0, 0.0, area.0, area.1)
        .font(font)
        .text_baseline(CanvasTextBaseline::Top);
    for row in 0..rows {
        let y = PAD + row as f32 * ch;
        let mut run = String::new();
        let mut run_at = 0_u16;
        let mut run_look: Option<(Rgb, bool)> = None;
        let mut col = 0_u16;
        while col < cols {
            let Some(c) = screen.cell(row, col) else { break };
            if c.is_wide_continuation() {
                col += 1;
                continue;
            }
            let width = if c.is_wide() { 2 } else { 1 };
            let mut fg = palette.resolve(c.fgcolor(), palette.foreground);
            let mut bg = palette.resolve(c.bgcolor(), palette.background);
            if c.inverse() {
                std::mem::swap(&mut fg, &mut bg);
            }
            if c.dim() {
                fg = ((fg.0 as u16 * 2 / 3) as u8, (fg.1 as u16 * 2 / 3) as u8, (fg.2 as u16 * 2 / 3) as u8);
            }
            let x = PAD + col as f32 * cw;
            if bg != palette.background {
                p = p.fill_color(rgb(hex(bg))).fill_rect(x, y, cw * width as f32, ch);
            }
            let text = c.contents();
            let look = (fg, c.bold());
            let plain = width == 1 && text.len() == 1 && text.is_ascii();
            if !plain || run_look != Some(look) || run_at + run.len() as u16 != col {
                p = flush(p, &mut run, run_at, run_look, y, cw, font);
                run_at = col;
                run_look = Some(look);
            }
            if plain {
                run.push_str(text);
            } else if !text.is_empty() && text != " " {
                p = draw_text(p, text, x, y, look, font);
                run_at = col + width;
            } else {
                run_at = col + width;
            }
            col += width;
        }
        p = flush(p, &mut run, run_at, run_look, y, cw, font);
    }
    let (cursor_row, cursor_col) = screen.cursor_position();
    let live = screen.scrollback() == 0 && cursor_row < rows;
    let mut x = PAD + cursor_col as f32 * cw;
    let y = PAD + cursor_row as f32 * ch;
    // A composition covers the cells from the cursor on, on the ground, underlined (as AppKit marks
    // it); the cursor follows it. Drawn even where a program hides the cursor: it composes there.
    if live && !preedit.is_empty() {
        let width = measure_text(font, preedit).0.max(cw);
        let (fg, bg) = (palette.foreground, palette.background);
        p = p
            .fill_color(rgb(hex(bg)))
            .fill_rect(x, y, width, ch)
            .fill_color(rgb(hex(fg)))
            .fill_text(preedit, x, y)
            .fill_rect(x, y + ch - 1.5, width, 1.0);
        x += width;
    }
    if !screen.hide_cursor() && live {
        let (r, g, b) = palette.cursor;
        p = if focused {
            p.fill_color(rgba(r, g, b, 0.55)).fill_rect(x, y, cw, ch)
        } else {
            p.stroke_color(rgba(r, g, b, 0.8)).line_width(1.0).stroke_rect(bounds(point(px(x + 0.5), px(y + 0.5)), size(px(cw - 1.0), px(ch - 1.0))))
        };
    }
    p
}

fn rgba(r: u8, g: u8, b: u8, a: f32) -> Rgba {
    rgb(hex((r, g, b))).opacity(a)
}

fn flush(p: Painter, run: &mut String, at: u16, look: Option<(Rgb, bool)>, y: f32, cw: f32, font: &str) -> Painter {
    let trimmed = run.trim_end();
    let p = match look {
        Some(look) if !trimmed.trim().is_empty() => draw_text(p, trimmed, PAD + at as f32 * cw, y, look, font),
        _ => p,
    };
    run.clear();
    p
}

fn draw_text(p: Painter, text: &str, x: f32, y: f32, look: (Rgb, bool), font: &str) -> Painter {
    let p = p.fill_color(rgb(hex(look.0)));
    if look.1 { p.font(&format!("bold {font}")).fill_text(text, x, y).font(font) } else { p.fill_text(text, x, y) }
}

#[cfg(test)]
mod tests {
    use super::{caret_box, unseen};

    #[test]
    fn the_caret_is_the_cursor_cell_on_the_live_screen_only() {
        assert_eq!(caret_box((2, 3), 24, true, (8.0, 17.0)), vec![32.0, 42.0, 8.0, 17.0]);
        assert_eq!(caret_box((0, 0), 24, true, (8.0, 17.0)), vec![8.0, 8.0, 8.0, 17.0]);
        assert!(caret_box((2, 3), 24, false, (8.0, 17.0)).is_empty(), "back in the history");
        assert!(caret_box((24, 0), 24, true, (8.0, 17.0)).is_empty(), "below the screen");
    }

    #[test]
    fn frames_already_on_screen_are_dropped_and_overlaps_trimmed() {
        assert_eq!(unseen(10, 0, b"0123456789"), None);
        assert_eq!(unseen(10, 5, b"56789abc"), Some(&b"abc"[..]));
        assert_eq!(unseen(10, 10, b"abc"), Some(&b"abc"[..]));
        assert_eq!(unseen(10, 20, b"xyz"), Some(&b"xyz"[..]));
    }
}
