//! The emulator NSH's own `Terminal` (`nsh/base`) runs on for the runtime's terminals: NSH's
//! `VtEmulator`, as the runtime's terminals need it ([`RuntimeEmulator`]):
//!
//! - It never answers the program's queries (the cursor's position, the device's attributes). The
//!   runtime's screen (`apps/daemon/src/terminal-screen.ts`) answers those for every pane at once,
//!   and a pane that answered too would type a second answer into the program; `Terminal` sends its
//!   emulator's answers through `onData`, with the keys, where TSX cannot tell them apart.
//! - Its colours are the app's (`palette.rs`, as the canvas terminal draws them): the sixteen ANSI
//!   colours, the default text and an inverse cell's default ground, in the appearance the
//!   terminal is shown in. `Terminal` itself has VS Code's sixteen and the theme's foreground.
//!
//! TSX puts the terminal inside [`RuntimeTerminals`], which hands this emulator to the terminals
//! below it and lays the palette's ground under them.

use nsh_base::{
    TerminalColor, TerminalCursor, TerminalEmulator, TerminalEmulatorEvent, TerminalEmulatorFactory, TerminalLine,
    TerminalModes, TerminalSize, TerminalStyle, VtEmulator,
};
use nsh_core::prelude::*;

use crate::palette::{Palette, Rgb, hex};

/// `E` as the runtime's terminals show it: its replies to the program dropped (the title and the
/// bell kept), its lines in the app's palette for the appearance `dark` holds.
pub struct RuntimeEmulator<E> {
    inner: E,
    dark: Memo<bool>,
}

impl<E> RuntimeEmulator<E> {
    pub fn new(inner: E, dark: Memo<bool>) -> Self {
        Self { inner, dark }
    }
}

fn rgb_of((r, g, b): Rgb) -> TerminalColor {
    TerminalColor::Rgb(r, g, b)
}

/// `style` in `palette`: the sixteen ANSI colours as the palette has them (the cube, the greys and
/// 24-bit colours stay as asked), text with no colour in the palette's ink, and an inverse cell with
/// no ground on the palette's ground, so that swapped it reads as the palette's ink.
pub fn recolour(style: TerminalStyle, palette: &Palette) -> TerminalStyle {
    let ansi = |color: Option<TerminalColor>| match color {
        Some(TerminalColor::Indexed(index)) if index < 16 => Some(rgb_of(palette.indexed(index))),
        other => other,
    };
    let mut out = style;
    out.fg = ansi(style.fg).or(Some(rgb_of(palette.foreground)));
    out.bg = ansi(style.bg);
    if style.inverse && out.bg.is_none() {
        out.bg = Some(rgb_of(palette.background));
    }
    out
}

/// Drops the program's replies from `events`.
fn without_replies(mut events: Vec<TerminalEmulatorEvent>) -> Vec<TerminalEmulatorEvent> {
    events.retain(|event| !matches!(event, TerminalEmulatorEvent::Reply(_)));
    events
}

impl<E: TerminalEmulator> TerminalEmulator for RuntimeEmulator<E> {
    fn feed(&mut self, bytes: &[u8]) {
        self.inner.feed(bytes);
    }

    fn resize(&mut self, size: TerminalSize) {
        self.inner.resize(size);
    }

    fn line_count(&self) -> usize {
        self.inner.line_count()
    }

    /// Read where `Terminal` draws a row, so the row follows the appearance (`dark` is tracked).
    fn line(&self, index: usize) -> TerminalLine {
        let palette = Palette::new(self.dark.get());
        let mut line = self.inner.line(index);
        for run in &mut line.runs {
            run.style = recolour(run.style, &palette);
        }
        line
    }

    fn cursor(&self) -> Option<TerminalCursor> {
        self.inner.cursor()
    }

    fn take_events(&mut self) -> Vec<TerminalEmulatorEvent> {
        without_replies(self.inner.take_events())
    }

    fn modes(&self) -> TerminalModes {
        self.inner.modes()
    }
}

/// The props of [`RuntimeTerminals`].
#[derive(Clone, PartialEq, Props)]
pub struct RuntimeTerminalsProps {
    /// Shown on the dark ground: the palette's dark colours.
    pub dark: Prop<bool>,
    /// The terminals (and whatever holds them).
    pub children: Prop<Children>,
}

/// Gives the `Terminal`s below it the runtime's emulator ([`RuntimeEmulator`] over `VtEmulator`),
/// on the palette's ground; fills its parent.
#[component]
pub fn RuntimeTerminals(props: RuntimeTerminalsProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let dark = computed(move || props.dark.get());
    provide_context(TerminalEmulatorFactory::new(move |size, scrollback| {
        Box::new(RuntimeEmulator::new(VtEmulator::new(size, scrollback), dark))
    }));
    view()
        .flex_1()
        .min_h(px(0.0))
        .bg(move || -> Hsla { nsh_core::color::rgb(hex(Palette::new(dark.get()).background)).into() })
        .child(props.children)
}

#[cfg(test)]
mod tests {
    use super::{recolour, without_replies};
    use crate::palette::Palette;
    use nsh_base::{TerminalColor, TerminalEmulator, TerminalEmulatorEvent, TerminalSize, TerminalStyle, VtEmulator};

    fn style(fg: Option<TerminalColor>, bg: Option<TerminalColor>, inverse: bool) -> TerminalStyle {
        let mut s = TerminalStyle::default();
        s.fg = fg;
        s.bg = bg;
        s.inverse = inverse;
        s
    }

    #[test]
    fn the_programs_queries_go_unanswered_and_its_title_and_bell_come_through() {
        let mut vt = VtEmulator::new(TerminalSize::new(20, 4), 100);
        // A title, the cursor's position asked (DSR 6), the device's attributes asked (DA1), a bell.
        vt.feed(b"\x1b]2;hi\x07ab\x1b[6n\x1b[c\x07");
        let events = vt.take_events();
        assert_eq!(events.len(), 4, "NSH's own emulator answers both queries");
        assert_eq!(without_replies(events), vec![TerminalEmulatorEvent::Title("hi".into()), TerminalEmulatorEvent::Bell]);
    }

    #[test]
    fn the_sixteen_and_the_default_text_take_the_palettes_colours() {
        let dark = Palette::new(true);
        let red = recolour(style(Some(TerminalColor::Indexed(1)), Some(TerminalColor::Indexed(4)), false), &dark);
        assert_eq!(red.fg, Some(TerminalColor::Rgb(0xef, 0x6b, 0x6b)));
        assert_eq!(red.bg, Some(TerminalColor::Rgb(0x60, 0xa5, 0xfa)));
        let plain = recolour(TerminalStyle::default(), &dark);
        assert_eq!(plain.fg, Some(TerminalColor::Rgb(0xee, 0xf2, 0xf3)), "the palette's ink");
        assert_eq!(plain.bg, None, "the ground stays the view's");
        let light = recolour(style(Some(TerminalColor::Indexed(1)), None, false), &Palette::new(false));
        assert_eq!(light.fg, Some(TerminalColor::Rgb(0xc6, 0x28, 0x28)));
    }

    #[test]
    fn the_cube_the_greys_and_24_bit_colours_stay_as_asked() {
        let dark = Palette::new(true);
        let cube = recolour(style(Some(TerminalColor::Indexed(16)), Some(TerminalColor::Indexed(244)), false), &dark);
        assert_eq!((cube.fg, cube.bg), (Some(TerminalColor::Indexed(16)), Some(TerminalColor::Indexed(244))));
        let true_colour = recolour(style(Some(TerminalColor::Rgb(1, 2, 3)), None, false), &dark);
        assert_eq!(true_colour.fg, Some(TerminalColor::Rgb(1, 2, 3)));
    }

    #[test]
    fn an_inverse_cell_with_no_colours_swaps_the_palettes_ink_and_ground() {
        let light = Palette::new(false);
        let inverse = recolour(style(None, None, true), &light);
        assert_eq!(inverse.fg, Some(TerminalColor::Rgb(0x12, 0x1c, 0x20)));
        assert_eq!(inverse.bg, Some(TerminalColor::Rgb(0xff, 0xff, 0xff)));
        assert!(inverse.inverse, "Terminal swaps them");
    }
}
