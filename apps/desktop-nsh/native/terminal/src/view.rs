//! The terminal's NSView: draws the screen state cell by cell (AppKit text drawing, runs of plain
//! characters at once, wide characters on their own two cells), and takes keys the way a Mac text
//! view does (`NSTextInputClient`): input methods compose in place at the cursor, with their
//! candidate window beside it.

use std::cell::RefCell;
use std::collections::HashMap;

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::{CursorShape, Rgb};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol, Sel};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSColor, NSEvent, NSEventModifierFlags, NSFont, NSFontAttributeName, NSFontWeightBold,
    NSFontWeightRegular, NSForegroundColorAttributeName, NSPasteboard, NSPasteboardTypeString, NSRectFill,
    NSResponder, NSStringDrawing, NSTextInputClient, NSUnderlineStyleAttributeName, NSView,
};
use objc2_foundation::{
    NSArray, NSAttributedString, NSAttributedStringKey, NSDictionary, NSNotFound, NSNumber, NSPoint,
    NSRange, NSRangePointer, NSRect, NSSize, NSString, NSUInteger,
};

use crate::keys;
use crate::palette::Palette;
use crate::session::{Session, Size};

const PAD: f64 = 8.0;

pub struct State {
    pub session: Option<Session>,
    font: Retained<NSFont>,
    bold: Retained<NSFont>,
    cell: NSSize,
    palette: Palette,
    marked: String,
    scroll: f64,
    pub on_size: Option<Box<dyn Fn(Size)>>,
}

pub struct Ivars {
    state: RefCell<State>,
}

define_class!(
    #[unsafe(super(NSView, NSResponder))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskfolkTerminalView"]
    #[ivars = Ivars]
    pub struct TerminalView;

    unsafe impl NSObjectProtocol for TerminalView {}

    impl TerminalView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            self.setNeedsDisplay(true);
            true
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            self.ivars().state.borrow_mut().marked.clear();
            self.setNeedsDisplay(true);
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            self.focus();
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            let started = std::time::Instant::now();
            self.draw();
            crate::perf::frame(started.elapsed());
        }

        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, size: NSSize) {
            let _: () = unsafe { msg_send![super(self), setFrameSize: size] };
            self.fit();
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            self.handle_key(event);
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            self.handle_scroll(event);
        }

        #[unsafe(method(paste:))]
        fn paste(&self, _sender: Option<&AnyObject>) {
            let text = unsafe { NSPasteboard::generalPasteboard().stringForType(NSPasteboardTypeString) };
            if let Some(text) = text {
                let bracketed = self.mode().contains(TermMode::BRACKETED_PASTE);
                self.send(keys::paste(&text.to_string(), bracketed));
            }
        }
    }

    unsafe impl NSTextInputClient for TerminalView {
        #[unsafe(method(insertText:replacementRange:))]
        fn insert_text(&self, string: &AnyObject, _range: NSRange) {
            let text: String = text_of(string).chars().filter(|c| !keys::is_key_character(*c)).collect();
            self.ivars().state.borrow_mut().marked.clear();
            self.send(text.into_bytes());
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(doCommandBySelector:))]
        fn do_command(&self, selector: Sel) {
            let app_cursor = self.mode().contains(TermMode::APP_CURSOR);
            if let Some(bytes) = keys::command(selector.name().to_str().unwrap_or_default(), app_cursor) {
                self.send(bytes.to_vec());
            }
        }

        #[unsafe(method(setMarkedText:selectedRange:replacementRange:))]
        fn set_marked_text(&self, string: &AnyObject, _selected: NSRange, _replacement: NSRange) {
            self.ivars().state.borrow_mut().marked = text_of(string);
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(unmarkText))]
        fn unmark_text(&self) {
            self.ivars().state.borrow_mut().marked.clear();
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(selectedRange))]
        fn selected_range(&self) -> NSRange {
            NSRange::new(self.marked_len(), 0)
        }

        #[unsafe(method(markedRange))]
        fn marked_range(&self) -> NSRange {
            match self.marked_len() {
                0 => NSRange::new(NSNotFound as NSUInteger, 0),
                len => NSRange::new(0, len),
            }
        }

        #[unsafe(method(hasMarkedText))]
        fn has_marked_text(&self) -> bool {
            self.marked_len() > 0
        }

        #[unsafe(method_id(attributedSubstringForProposedRange:actualRange:))]
        fn attributed_substring(&self, _range: NSRange, _actual: NSRangePointer) -> Option<Retained<NSAttributedString>> {
            None
        }

        #[unsafe(method_id(validAttributesForMarkedText))]
        fn valid_attributes(&self) -> Retained<NSArray<NSAttributedStringKey>> {
            NSArray::new()
        }

        #[unsafe(method(firstRectForCharacterRange:actualRange:))]
        fn first_rect(&self, _range: NSRange, _actual: NSRangePointer) -> NSRect {
            // Where the input method's candidates go: just under the cursor, on screen.
            let rect = self.cursor_rect();
            let in_window = self.convertRect_toView(rect, None);
            match self.window() {
                Some(window) => window.convertRectToScreen(in_window),
                None => in_window,
            }
        }

        #[unsafe(method(characterIndexForPoint:))]
        fn character_index(&self, _point: NSPoint) -> NSUInteger {
            0
        }
    }
);

fn text_of(string: &AnyObject) -> String {
    if let Some(s) = string.downcast_ref::<NSString>() {
        s.to_string()
    } else if let Some(s) = string.downcast_ref::<NSAttributedString>() {
        s.string().to_string()
    } else {
        String::new()
    }
}

fn mono(size: f64, bold: bool) -> Retained<NSFont> {
    let weight = unsafe { if bold { NSFontWeightBold } else { NSFontWeightRegular } };
    NSFont::monospacedSystemFontOfSize_weight(size, weight)
}

fn color(c: Rgb, alpha: f64) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(c.r as f64 / 255.0, c.g as f64 / 255.0, c.b as f64 / 255.0, alpha)
}

fn key(c: Rgb) -> u32 {
    (c.r as u32) << 16 | (c.g as u32) << 8 | c.b as u32
}

impl TerminalView {
    pub fn new(mtm: MainThreadMarker, size: f64, dark: bool) -> Retained<TerminalView> {
        let (font, bold) = (mono(size, false), mono(size, true));
        let cell = cell_size(&font);
        let this = TerminalView::alloc(mtm).set_ivars(Ivars {
            state: RefCell::new(State {
                session: None,
                font,
                bold,
                cell,
                palette: Palette::new(dark),
                marked: String::new(),
                scroll: 0.0,
                on_size: None,
            }),
        });
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(640.0, 400.0));
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    pub fn state(&self) -> std::cell::RefMut<'_, State> {
        self.ivars().state.borrow_mut()
    }

    pub fn set_font_size(&self, size: f64) {
        {
            let mut state = self.state();
            state.font = mono(size, false);
            state.bold = mono(size, true);
            state.cell = cell_size(&state.font);
        }
        self.fit();
        self.setNeedsDisplay(true);
    }

    pub fn set_dark(&self, dark: bool) {
        self.state().palette = Palette::new(dark);
        self.setNeedsDisplay(true);
    }

    pub fn focus(&self) {
        if let Some(window) = self.window() {
            window.makeFirstResponder(Some(self));
        }
    }

    /// The screen's rows and columns for the view's size; resizes the terminal (and its pty).
    pub fn fit(&self) {
        let state = self.ivars().state.borrow();
        let bounds = self.bounds();
        let cols = ((bounds.size.width - 2.0 * PAD) / state.cell.width).floor().max(2.0) as usize;
        let rows = ((bounds.size.height - 2.0 * PAD) / state.cell.height).floor().max(1.0) as usize;
        let size = Size { rows, cols };
        if let Some(session) = &state.session {
            session.resize(size);
        }
        if let Some(on_size) = &state.on_size {
            on_size(size);
        }
    }

    fn mode(&self) -> TermMode {
        match &self.ivars().state.borrow().session {
            Some(session) => *session.shared.term.lock().mode(),
            None => TermMode::empty(),
        }
    }

    fn marked_len(&self) -> NSUInteger {
        self.ivars().state.borrow().marked.encode_utf16().count() as NSUInteger
    }

    fn send(&self, bytes: Vec<u8>) {
        let state = self.ivars().state.borrow();
        if let Some(session) = &state.session {
            // Typing returns the view to the live screen from wherever the history was scrolled.
            session.shared.term.lock().scroll_display(Scroll::Bottom);
            session.input(bytes);
        }
        drop(state);
        self.setNeedsDisplay(true);
    }

    fn handle_key(&self, event: &NSEvent) {
        let flags = event.modifierFlags();
        let composing = self.marked_len() > 0;
        if !composing {
            let first = event.charactersIgnoringModifiers().and_then(|s| s.to_string().chars().next());
            if let Some(c) = first {
                if flags.contains(NSEventModifierFlags::Control) && !flags.contains(NSEventModifierFlags::Command) {
                    if let Some(byte) = keys::control(c) {
                        self.send(vec![byte]);
                        return;
                    }
                }
                if let Some(bytes) = keys::function_key(c) {
                    self.send(bytes.to_vec());
                    return;
                }
            }
        }
        self.interpretKeyEvents(&NSArray::from_slice(&[event]));
    }

    fn handle_scroll(&self, event: &NSEvent) {
        let lines = {
            let mut state = self.state();
            let step = if event.hasPreciseScrollingDeltas() { state.cell.height } else { 1.0 };
            state.scroll += event.scrollingDeltaY() / step;
            let whole = state.scroll.trunc();
            state.scroll -= whole;
            whole as i32
        };
        if lines != 0 {
            if let Some(session) = &self.ivars().state.borrow().session {
                session.shared.term.lock().scroll_display(Scroll::Delta(lines));
            }
            self.setNeedsDisplay(true);
        }
    }

    fn cursor_rect(&self) -> NSRect {
        let state = self.ivars().state.borrow();
        let (row, col) = match &state.session {
            Some(session) => {
                let term = session.shared.term.lock();
                let point = term.grid().cursor.point;
                (point.line.0.max(0) as f64, point.column.0 as f64)
            }
            None => (0.0, 0.0),
        };
        NSRect::new(
            NSPoint::new(PAD + col * state.cell.width, PAD + row * state.cell.height),
            NSSize::new(state.cell.width, state.cell.height),
        )
    }

    fn draw(&self) {
        let state = self.ivars().state.borrow();
        let bounds = self.bounds();
        let palette = &state.palette;
        color(palette.background, 1.0).set();
        NSRectFill(bounds);
        let Some(session) = &state.session else { return };
        let focused = self.window().and_then(|w| w.firstResponder()).is_some_and(|r| {
            std::ptr::eq(Retained::as_ptr(&r).cast::<u8>(), (self as *const TerminalView).cast::<u8>())
        });

        let term = session.shared.term.lock();
        let content = term.renderable_content();
        let offset = content.display_offset as i32;
        let (cw, ch) = (state.cell.width, state.cell.height);
        let mut painter = Painter::new(&state);

        for indexed in content.display_iter {
            let cell = indexed.cell;
            if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            let row = indexed.point.line.0 + offset;
            let col = indexed.point.column.0;
            let mut fg = palette.resolve(cell.fg, content.colors);
            let mut bg = palette.resolve(cell.bg, content.colors);
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
            let x = PAD + col as f64 * cw;
            let y = PAD + row as f64 * ch;
            if key(bg) != key(palette.background) {
                painter.flush();
                color(bg, 1.0).set();
                NSRectFill(NSRect::new(NSPoint::new(x, y), NSSize::new(cw * width as f64, ch)));
            }
            let visible = cell.c != ' ' && cell.c != '\0' && !cell.flags.contains(Flags::HIDDEN);
            let alpha = if cell.flags.contains(Flags::DIM) { 0.66 } else { 1.0 };
            if visible {
                let bold = cell.flags.contains(Flags::BOLD);
                let underline = cell.flags.contains(Flags::UNDERLINE);
                painter.put(row, col, width, cell.c, fg, alpha, bold, underline);
            }
        }
        painter.flush();

        // The cursor: a block while the view has the keyboard, an outline otherwise.
        let cursor = content.cursor;
        if cursor.shape != CursorShape::Hidden && content.mode.contains(TermMode::SHOW_CURSOR) {
            let row = cursor.point.line.0 + offset;
            if row >= 0 && (row as usize) < term.screen_lines() {
                let rect = NSRect::new(
                    NSPoint::new(PAD + cursor.point.column.0 as f64 * cw, PAD + row as f64 * ch),
                    NSSize::new(cw, ch),
                );
                if focused {
                    color(palette.cursor, 0.55).set();
                    NSRectFill(match cursor.shape {
                        CursorShape::Beam => NSRect::new(rect.origin, NSSize::new(2.0, ch)),
                        CursorShape::Underline => NSRect::new(NSPoint::new(rect.origin.x, rect.origin.y + ch - 2.0), NSSize::new(cw, 2.0)),
                        _ => rect,
                    });
                } else {
                    color(palette.cursor, 0.8).set();
                    objc2_app_kit::NSFrameRect(rect);
                }
            }
        }
        drop(term);

        // What an input method is composing, in place at the cursor.
        if !state.marked.is_empty() {
            let rect = self.cursor_rect_locked(&state, session);
            let text = NSString::from_str(&state.marked);
            let attrs = attributes(&state.font, &color(palette.foreground, 1.0), true);
            let size = unsafe { text.sizeWithAttributes(Some(&attrs)) };
            color(palette.background, 1.0).set();
            NSRectFill(NSRect::new(rect.origin, NSSize::new(size.width.max(cw), ch)));
            unsafe { text.drawAtPoint_withAttributes(rect.origin, Some(&attrs)) };
        }
    }

    fn cursor_rect_locked(&self, state: &State, session: &Session) -> NSRect {
        let point = session.shared.term.lock().grid().cursor.point;
        NSRect::new(
            NSPoint::new(PAD + point.column.0 as f64 * state.cell.width, PAD + point.line.0.max(0) as f64 * state.cell.height),
            NSSize::new(state.cell.width, state.cell.height),
        )
    }
}

fn cell_size(font: &NSFont) -> NSSize {
    let attrs = attributes(font, &NSColor::blackColor(), false);
    let m = unsafe { NSString::from_str("M").sizeWithAttributes(Some(&attrs)) };
    let height = (font.ascender() - font.descender() + font.leading()).ceil();
    NSSize::new(m.width, height.max(m.height.ceil()))
}

fn attributes(font: &NSFont, fg: &NSColor, underline: bool) -> Retained<NSDictionary<NSAttributedStringKey, AnyObject>> {
    unsafe {
        if underline {
            let single = NSNumber::new_isize(1);
            NSDictionary::from_slices(
                &[NSFontAttributeName, NSForegroundColorAttributeName, NSUnderlineStyleAttributeName],
                &[font.as_ref(), fg.as_ref(), single.as_ref()],
            )
        } else {
            NSDictionary::from_slices(&[NSFontAttributeName, NSForegroundColorAttributeName], &[font.as_ref(), fg.as_ref()])
        }
    }
}

/// Draws runs of plain characters that share a look as one string, and anything wider or outside
/// ASCII on its own at its column, so wide glyphs from fallback fonts never push the grid.
struct Painter<'a> {
    state: &'a State,
    run: String,
    at: (i32, usize),
    end: usize,
    look: Option<(u32, u8, bool, bool)>,
    fg: Option<(Rgb, f64)>,
    attrs: HashMap<(u32, u8, bool, bool), Retained<NSDictionary<NSAttributedStringKey, AnyObject>>>,
}

impl<'a> Painter<'a> {
    fn new(state: &'a State) -> Self {
        Painter { state, run: String::new(), at: (0, 0), end: 0, look: None, fg: None, attrs: HashMap::new() }
    }

    #[allow(clippy::too_many_arguments)]
    fn put(&mut self, row: i32, col: usize, width: usize, c: char, fg: Rgb, alpha: f64, bold: bool, underline: bool) {
        let look = (key(fg), (alpha * 100.0) as u8, bold, underline);
        let plain = width == 1 && c.is_ascii();
        if !plain {
            self.flush();
            self.draw(row, col, &c.to_string(), look, fg, alpha);
            return;
        }
        if self.look != Some(look) || self.at.0 != row || self.end != col {
            self.flush();
            self.at = (row, col);
            self.look = Some(look);
        }
        self.run.push(c);
        self.end = col + 1;
        self.fg = Some((fg, alpha));
    }

    fn flush(&mut self) {
        if self.run.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.run);
        if let (Some(look), Some((fg, alpha))) = (self.look, self.fg) {
            self.draw(self.at.0, self.at.1, &text, look, fg, alpha);
        }
    }

    fn draw(&mut self, row: i32, col: usize, text: &str, look: (u32, u8, bool, bool), fg: Rgb, alpha: f64) {
        let state = self.state;
        let attrs = self.attrs.entry(look).or_insert_with(|| {
            let font = if look.2 { &state.bold } else { &state.font };
            attributes(font, &color(fg, alpha), look.3)
        });
        let point = NSPoint::new(PAD + col as f64 * state.cell.width, PAD + row as f64 * state.cell.height);
        unsafe { NSString::from_str(text).drawAtPoint_withAttributes(point, Some(attrs)) };
    }
}

/// So a session can be kept on the view and dropped with it.
pub fn attach(view: &TerminalView, session: Session) {
    view.state().session = Some(session);
    view.fit();
    view.setNeedsDisplay(true);
}

pub fn detach(view: &TerminalView) {
    view.state().session = None;
}
