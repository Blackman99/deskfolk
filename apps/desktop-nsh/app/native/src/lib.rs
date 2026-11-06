//! The app's own Rust, built for every target NSH builds the app for — the desktops' hosts and the
//! web's wasm alike — so what NSH lacks is filled once, on NSH, rather than per platform.
//!
//! TSX imports it as `deskfolk/native`.

use nsh_core::prelude::*;

mod palette;
mod pdf;
mod terminal;

pub use pdf::Documents;
pub use terminal::{TerminalGrid, TerminalGridElement, TerminalGridEvent, TerminalGridProps, Terminals, terminal_grid};

/// What TSX may import from `deskfolk/native`.
#[native_module("deskfolk/native")]
fn native(registry: &mut Registry) {
    registry.register::<TerminalGrid>().module::<Terminals>().module::<Documents>();
}
