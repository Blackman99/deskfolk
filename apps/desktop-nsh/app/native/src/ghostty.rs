//! Ghostty's terminal emulator (libghostty-vt, built from Ghostty's Zig sources) behind NSH's
//! `TerminalEmulator`: what `RuntimeTerminals` hands its terminals on the desktops when the crate is
//! built with the `ghostty` feature. Over NSH's own `VtEmulator` it keeps grapheme clusters
//! (combining marks, emoji sequences), reflows the primary screen when the width changes, and
//! covers what programs send as Ghostty does.
//!
//! `Terminal` asks for lines by number, the scrollback's oldest first, as its list shows them.
//! Ghostty's fast way to read is its render state, which reads the viewport, so a line is read with
//! the page of the screen around it: the viewport moved to that page, read whole, kept until the
//! next output or resize, and moved back to the live screen. A list showing the live screen reads
//! one page per change; scrolled into the history, one or two more.
//!
//! The program's queries are not answered (no `on_pty_write`): the runtime's screen answers them.

use std::cell::RefCell;
use std::collections::HashMap;

use libghostty_vt::render::{CellIterator, RowIterator};
use libghostty_vt::screen::{CellContentTag, CellWide};
use libghostty_vt::style::{Style, StyleColor, Underline};
use libghostty_vt::terminal::{Mode, ScrollViewport};
use libghostty_vt::{RenderState, Terminal, TerminalOptions};
use nsh_base::{
    TerminalColor, TerminalCursor, TerminalEmulator, TerminalEmulatorEvent, TerminalLine, TerminalModes, TerminalRun,
    TerminalSize, TerminalStyle,
};

/// Ghostty keeps history by bytes, not lines (`max_scrollback`, whatever its C header says:
/// `src/terminal/Screen.zig`), about 9 bytes a cell: its own default of 10 MB kept 9 205 lines at
/// 120 columns. A line here is a 200-column row's worth with room to spare, so the lines asked for
/// hold up to that width; memory is taken only as the history fills.
const BYTES_PER_LINE: usize = 2_400;

/// A cell's size in pixels as Ghostty is told it: only reports of the window's pixel size read it,
/// and the runtime's screen answers those.
const CELL_PIXELS: (u32, u32) = (8, 16);

pub struct GhosttyEmulator {
    inner: RefCell<Inner>,
}

struct Inner {
    terminal: Terminal<'static, 'static>,
    render: RenderState<'static>,
    rows: RowIterator<'static>,
    cells: CellIterator<'static>,
    /// The size last asked for: never fewer lines than its rows are reported.
    size: TerminalSize,
    /// Lines read since the last output or resize, by number.
    lines: HashMap<usize, TerminalLine>,
    /// A cell's grapheme cluster, when it is more than one codepoint.
    cluster: String,
    /// The title last reported.
    title: String,
}

impl GhosttyEmulator {
    pub fn new(size: TerminalSize, scrollback: usize) -> Self {
        let options = TerminalOptions {
            cols: size.cols.max(1),
            rows: size.rows.max(1),
            max_scrollback: scrollback.saturating_mul(BYTES_PER_LINE),
        };
        Self {
            inner: RefCell::new(Inner {
                terminal: Terminal::new(options).expect("a Ghostty terminal"),
                render: RenderState::new().expect("a Ghostty render state"),
                rows: RowIterator::new().expect("a Ghostty row iterator"),
                cells: CellIterator::new().expect("a Ghostty cell iterator"),
                size,
                lines: HashMap::new(),
                cluster: String::new(),
                title: String::new(),
            }),
        }
    }
}

fn color(color: StyleColor) -> Option<TerminalColor> {
    match color {
        StyleColor::None => None,
        StyleColor::Palette(index) => Some(TerminalColor::Indexed(index.0)),
        StyleColor::Rgb(c) => Some(TerminalColor::Rgb(c.r, c.g, c.b)),
    }
}

fn style_of(style: &Style, bg: Option<TerminalColor>) -> TerminalStyle {
    let mut out = TerminalStyle::default();
    out.fg = color(style.fg_color);
    out.bg = bg;
    out.bold = style.bold;
    out.dim = style.faint;
    out.italic = style.italic;
    out.underline = !matches!(style.underline, Underline::None);
    out.strikethrough = style.strikethrough;
    out.inverse = style.inverse;
    out.hidden = style.invisible;
    out
}

impl Inner {
    fn total(&self) -> usize {
        self.terminal.total_rows().unwrap_or(0).max(self.size.rows as usize)
    }

    /// Reads the page of the screen holding line `index` into `lines`.
    fn read_page(&mut self, index: usize) {
        let rows = self.terminal.rows().unwrap_or(self.size.rows).max(1) as usize;
        let total = self.terminal.total_rows().unwrap_or(rows);
        let top = index.min(total.saturating_sub(rows));
        self.terminal.scroll_viewport(ScrollViewport::Row(top));
        self.read_viewport(top);
        self.terminal.scroll_viewport(ScrollViewport::Bottom);
    }

    /// The viewport's rows, as lines `top`, `top + 1`, ….
    fn read_viewport(&mut self, top: usize) {
        let Ok(snapshot) = self.render.update(&self.terminal) else { return };
        let Ok(mut rows) = self.rows.update(&snapshot) else { return };
        let mut at = top;
        while let Some(row) = rows.next() {
            let Ok(mut cells) = self.cells.update(row) else { break };
            let mut runs: Vec<TerminalRun> = Vec::new();
            // Where the last cell that is not a default blank ends, in `runs`' text.
            let mut kept = (0_usize, 0_usize);
            while let Some(cell) = cells.next() {
                let Ok(raw) = cell.raw_cell() else { continue };
                match raw.wide() {
                    Ok(CellWide::Narrow | CellWide::Wide) => {}
                    // The right half of a wide character, or the gap a wide one left wrapping.
                    _ => continue,
                }
                let style = if cell.has_styling().unwrap_or(false) { cell.style().unwrap_or_default() } else { Style::default() };
                // A cell erased in a colour holds only that colour, outside any style.
                let bg = match raw.content_tag() {
                    Ok(CellContentTag::BgColorPalette) => raw.bg_color_palette().ok().map(|i| TerminalColor::Indexed(i.0)),
                    Ok(CellContentTag::BgColorRgb) => raw.bg_color_rgb().ok().map(|c| TerminalColor::Rgb(c.r, c.g, c.b)),
                    _ => color(style.bg_color),
                };
                let look = style_of(&style, bg);
                let text = match cell.graphemes_len().unwrap_or(0) {
                    0 => " ".to_owned(),
                    1 => raw.codepoint().ok().and_then(char::from_u32).unwrap_or(' ').to_string(),
                    _ => {
                        self.cluster.clear();
                        if cell.graphemes_utf8(&mut self.cluster).is_err() || self.cluster.is_empty() {
                            self.cluster.push(' ');
                        }
                        self.cluster.clone()
                    }
                };
                let blank = text == " " && look == TerminalStyle::default();
                match runs.last_mut() {
                    Some(run) if run.style == look => run.text.push_str(&text),
                    _ => runs.push(TerminalRun::new(text, look)),
                }
                if !blank {
                    kept = (runs.len(), runs.last().map_or(0, |r| r.text.len()));
                }
            }
            // Trailing default blanks are left out, as NSH's own emulator leaves them.
            runs.truncate(kept.0);
            if let Some(last) = runs.last_mut() {
                last.text.truncate(kept.1);
            }
            self.lines.insert(at, TerminalLine::new(runs));
            at += 1;
        }
    }
}

impl TerminalEmulator for GhosttyEmulator {
    fn feed(&mut self, bytes: &[u8]) {
        let inner = self.inner.get_mut();
        inner.terminal.vt_write(bytes);
        inner.lines.clear();
    }

    fn resize(&mut self, size: TerminalSize) {
        let inner = self.inner.get_mut();
        let resized = inner.terminal.resize(size.cols.max(1), size.rows.max(1), CELL_PIXELS.0, CELL_PIXELS.1);
        debug_assert!(resized.is_ok(), "Ghostty refused {}×{}: {resized:?}", size.cols, size.rows);
        inner.size = size;
        inner.lines.clear();
    }

    fn line_count(&self) -> usize {
        self.inner.borrow().total()
    }

    fn line(&self, index: usize) -> TerminalLine {
        let mut inner = self.inner.borrow_mut();
        if !inner.lines.contains_key(&index) && index < inner.total() {
            inner.read_page(index);
        }
        inner.lines.get(&index).cloned().unwrap_or_default()
    }

    fn cursor(&self) -> Option<TerminalCursor> {
        let inner = self.inner.borrow();
        let t = &inner.terminal;
        if !t.is_cursor_visible().unwrap_or(true) {
            return None;
        }
        let mut cursor = TerminalCursor::default();
        cursor.col = t.cursor_x().ok()?;
        cursor.row = t.cursor_y().ok()?;
        Some(cursor)
    }

    fn take_events(&mut self) -> Vec<TerminalEmulatorEvent> {
        let inner = self.inner.get_mut();
        let title = inner.terminal.title().unwrap_or("");
        if title == inner.title {
            return Vec::new();
        }
        inner.title = title.to_owned();
        vec![TerminalEmulatorEvent::Title(inner.title.clone())]
    }

    fn modes(&self) -> TerminalModes {
        let inner = self.inner.borrow();
        let mut modes = TerminalModes::default();
        modes.application_cursor = inner.terminal.mode(Mode::DECCKM).unwrap_or(false);
        modes.bracketed_paste = inner.terminal.mode(Mode::BRACKETED_PASTE).unwrap_or(false);
        modes
    }
}

#[cfg(test)]
mod tests {
    use super::GhosttyEmulator as E;
    use libghostty_vt::terminal::{Point, PointCoordinate};
    use nsh_base::{TerminalColor, TerminalEmulator, TerminalEmulatorEvent, TerminalSize};

    fn term(cols: u16, rows: u16, scrollback: usize) -> E {
        E::new(TerminalSize::new(cols, rows), scrollback)
    }

    fn texts(e: &E) -> Vec<String> {
        (0..e.line_count()).map(|i| e.line(i).text()).collect()
    }

    /// Line `y` of the whole screen as Ghostty's own cell lookup reads it, trailing blanks dropped:
    /// the page reads are checked against it.
    fn oracle(e: &E, y: usize) -> String {
        let inner = e.inner.borrow();
        let cols = inner.terminal.cols().unwrap();
        let mut line = String::new();
        for x in 0..cols {
            let Ok(at) = inner.terminal.grid_ref(Point::Screen(PointCoordinate { x, y: y as u32 })) else { break };
            let cell = at.cell().unwrap();
            if !matches!(cell.wide(), Ok(libghostty_vt::screen::CellWide::Narrow | libghostty_vt::screen::CellWide::Wide)) {
                continue;
            }
            let mut chars = ['\0'; 16];
            let n = at.graphemes(&mut chars).unwrap_or(0);
            if n == 0 {
                line.push(' ');
            } else {
                line.extend(&chars[..n]);
            }
        }
        line.trim_end().to_owned()
    }

    fn agrees_with_ghostty(e: &E) {
        for y in 0..e.line_count() {
            assert_eq!(e.line(y).text(), oracle(e, y), "line {y}");
        }
    }

    #[test]
    fn lines_and_the_cursor() {
        let mut e = term(20, 4, 100);
        e.feed(b"hello\r\nworld");
        assert_eq!(texts(&e), ["hello", "world", "", ""]);
        let at = e.cursor().unwrap();
        assert_eq!((at.row, at.col), (1, 5));
        e.feed(b"\x1b[?25l");
        assert!(e.cursor().is_none(), "hidden");
    }

    #[test]
    fn history_comes_first_and_every_line_reads_as_ghostty_has_it() {
        let mut e = term(20, 4, 100);
        for i in 1..=30 {
            e.feed(format!("line {i}\r\n").as_bytes());
        }
        assert_eq!(e.line_count(), 31, "30 lines and the cursor's");
        assert_eq!(e.line(0).text(), "line 1");
        assert_eq!(e.line(29).text(), "line 30");
        // Read out of order: pages far apart, then back.
        assert_eq!(e.line(12).text(), "line 13");
        assert_eq!(e.line(2).text(), "line 3");
        agrees_with_ghostty(&e);
        let at = e.cursor().unwrap();
        assert_eq!(at.row, 3, "the cursor stays on the live screen after reading the history");
    }

    #[test]
    fn output_after_a_read_is_read_anew() {
        let mut e = term(20, 3, 10);
        e.feed(b"one");
        assert_eq!(e.line(0).text(), "one");
        e.feed(b"\r\x1b[Ktwo");
        assert_eq!(e.line(0).text(), "two");
    }

    #[test]
    fn the_history_prunes_at_its_size_and_still_reads_true() {
        let mut e = term(20, 4, 10);
        for i in 1..=5_000 {
            e.feed(format!("line {i}\r\n").as_bytes());
        }
        let count = e.line_count();
        assert!(count >= 4 + 10, "{count} lines kept");
        assert!(count < 5_000, "pruned: {count}");
        agrees_with_ghostty(&e);
        assert_eq!(e.line(count - 2).text(), "line 5000");
    }

    #[test]
    fn wide_characters_keep_their_text_once() {
        let mut e = term(10, 2, 0);
        e.feed("中文a".as_bytes());
        assert_eq!(e.line(0).text(), "中文a");
        assert_eq!(e.cursor().map(|c| c.col), Some(5));
    }

    #[test]
    fn colours_and_attributes() {
        let mut e = term(20, 2, 0);
        e.feed(b"\x1b[31mR\x1b[0m\x1b[48;5;100mB\x1b[0m\x1b[38;2;1;2;3mT\x1b[0m\x1b[1;7mX\x1b[0m\x1b[2;4;9mD\x1b[0m");
        let runs = e.line(0).runs;
        let style = |text: &str| runs.iter().find(|r| r.text == text).unwrap().style;
        assert_eq!(style("R").fg, Some(TerminalColor::Indexed(1)));
        assert_eq!(style("B").bg, Some(TerminalColor::Indexed(100)));
        assert_eq!(style("T").fg, Some(TerminalColor::Rgb(1, 2, 3)));
        let x = style("X");
        assert!(x.bold && x.inverse && !x.dim);
        let d = style("D");
        assert!(d.dim && d.underline && d.strikethrough && !d.bold);
    }

    #[test]
    fn cells_erased_in_a_colour_keep_it() {
        let mut e = term(6, 2, 0);
        e.feed(b"\x1b[42m\x1b[K\x1b[0m");
        let line = e.line(0);
        assert_eq!(line.text(), "      ");
        assert!(line.runs.iter().all(|r| r.style.bg == Some(TerminalColor::Indexed(2))));
    }

    #[test]
    fn modes_and_the_title() {
        let mut e = term(10, 2, 0);
        assert_eq!(e.modes(), Default::default());
        e.feed(b"\x1b[?1h\x1b[?2004h\x1b]2;work\x07");
        let modes = e.modes();
        assert!(modes.application_cursor && modes.bracketed_paste);
        assert_eq!(e.take_events(), vec![TerminalEmulatorEvent::Title("work".into())]);
        assert!(e.take_events().is_empty(), "reported once");
        // The program's queries are left to the runtime's screen.
        e.feed(b"\x1b[6n\x1b[c");
        assert!(e.take_events().is_empty());
    }

    #[test]
    fn the_alternate_screen_has_no_history_and_gives_the_primary_back() {
        let mut e = term(20, 3, 100);
        for i in 1..=10 {
            e.feed(format!("line {i}\r\n").as_bytes());
        }
        let primary = e.line_count();
        e.feed(b"\x1b[?1049h\x1b[2J\x1b[Hvim");
        assert_eq!(e.line_count(), 3);
        assert_eq!(e.line(0).text(), "vim");
        agrees_with_ghostty(&e);
        e.feed(b"\x1b[?1049l");
        assert_eq!(e.line_count(), primary);
        assert_eq!(e.line(0).text(), "line 1");
    }

    #[test]
    fn the_primary_screen_reflows_and_the_count_follows_the_size() {
        let mut e = term(10, 4, 100);
        e.feed(b"0123456789abc");
        e.resize(TerminalSize::new(5, 4));
        assert_eq!(&texts(&e)[..3], ["01234", "56789", "abc"]);
        agrees_with_ghostty(&e);
        e.resize(TerminalSize::new(20, 6));
        assert_eq!(e.line(0).text(), "0123456789abc");
        assert!(e.line_count() >= 6, "never fewer lines than the rows asked for");
    }

    #[test]
    fn combining_marks_and_emoji_sequences_stay_whole() {
        let mut e = term(20, 2, 0);
        e.feed("e\u{301}x".as_bytes());
        assert_eq!(e.line(0).text(), "e\u{301}x");
        let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
        let mut e = term(20, 2, 0);
        e.feed(format!("\x1b[?2027h{family}x").as_bytes());
        assert_eq!(e.line(0).text(), format!("{family}x"));
    }
}
