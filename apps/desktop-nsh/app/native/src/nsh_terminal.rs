//! The emulator NSH's own `Terminal` (`nsh/base`) runs on for the runtime's terminals: NSH's
//! `VtEmulator`, minus its answers to the program's queries (the cursor's position, the device's
//! attributes). The runtime's screen (`apps/daemon/src/terminal-screen.ts`) answers those for
//! every pane at once, and a pane that answered too would type a second answer into the program;
//! `Terminal` sends its emulator's answers through `onData`, with the keys, where TSX cannot tell
//! them apart. TSX puts the terminal inside [`RuntimeTerminals`], which hands this emulator to the
//! terminals below it.

use nsh_base::{
    TerminalCursor, TerminalEmulator, TerminalEmulatorEvent, TerminalEmulatorFactory, TerminalLine, TerminalModes,
    TerminalSize, VtEmulator,
};
use nsh_core::prelude::*;

/// An emulator that never answers the program: its replies are dropped, the title and the bell kept.
pub struct Quiet<E>(pub E);

impl<E: TerminalEmulator> TerminalEmulator for Quiet<E> {
    fn feed(&mut self, bytes: &[u8]) {
        self.0.feed(bytes);
    }

    fn resize(&mut self, size: TerminalSize) {
        self.0.resize(size);
    }

    fn line_count(&self) -> usize {
        self.0.line_count()
    }

    fn line(&self, index: usize) -> TerminalLine {
        self.0.line(index)
    }

    fn cursor(&self) -> Option<TerminalCursor> {
        self.0.cursor()
    }

    fn take_events(&mut self) -> Vec<TerminalEmulatorEvent> {
        let mut events = self.0.take_events();
        events.retain(|event| !matches!(event, TerminalEmulatorEvent::Reply(_)));
        events
    }

    fn modes(&self) -> TerminalModes {
        self.0.modes()
    }
}

/// The props of [`RuntimeTerminals`].
#[derive(Clone, PartialEq, Props)]
pub struct RuntimeTerminalsProps {
    /// The terminals (and whatever holds them).
    pub children: Prop<Children>,
}

/// Gives the `Terminal`s below it the runtime's emulator ([`Quiet`] `VtEmulator`); fills its parent.
#[component]
pub fn RuntimeTerminals(props: RuntimeTerminalsProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    provide_context(TerminalEmulatorFactory::new(|size, scrollback| Box::new(Quiet(VtEmulator::new(size, scrollback)))));
    view().flex_1().min_h(px(0.0)).child(props.children)
}

#[cfg(test)]
mod tests {
    use super::Quiet;
    use nsh_base::{TerminalEmulator, TerminalEmulatorEvent, TerminalSize, VtEmulator};

    #[test]
    fn the_programs_queries_go_unanswered_and_its_title_and_bell_come_through() {
        let mut vt = Quiet(VtEmulator::new(TerminalSize::new(20, 4), 100));
        // A title, the cursor's position asked (DSR 6), the device's attributes asked (DA1), a bell.
        vt.feed(b"\x1b]2;hi\x07ab\x1b[6n\x1b[c\x07");
        assert_eq!(vt.take_events(), vec![TerminalEmulatorEvent::Title("hi".into()), TerminalEmulatorEvent::Bell]);
        // NSH's own emulator would have answered both.
        let mut loud = VtEmulator::new(TerminalSize::new(20, 4), 100);
        loud.feed(b"\x1b[6n\x1b[c");
        assert_eq!(loud.take_events().len(), 2);
    }

    #[test]
    fn the_screen_is_the_emulators() {
        let mut vt = Quiet(VtEmulator::new(TerminalSize::new(10, 2), 100));
        vt.feed(b"one\r\ntwo\r\nthree");
        assert_eq!(vt.line_count(), 3);
        assert_eq!(vt.line(0).text(), "one");
        assert_eq!(vt.line(2).text(), "three");
        assert_eq!(vt.cursor().map(|c| (c.row, c.col)), Some((1, 5)));
    }
}
