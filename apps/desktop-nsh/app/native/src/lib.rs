//! The app's own Rust, built for every target NSH builds the app for — the desktops' hosts and the
//! web's wasm alike — so what NSH lacks is filled once, on NSH, rather than per platform.
//!
//! TSX imports it as `deskfolk/native`.

use nsh_core::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
mod office;
// The web's `Office`: the same functions, answering that there are no previews there yet
// (`office_web.rs`, and the note on `zip` in `Cargo.toml`).
#[cfg(target_arch = "wasm32")]
#[path = "office_web.rs"]
mod office;
mod markdown;
mod palette;
mod pdf;
mod rfb;
mod terminal;

pub use markdown::Markdown;
pub use office::Office;
pub use pdf::Documents;
pub use rfb::Screens;
pub use terminal::{TerminalGrid, TerminalGridElement, TerminalGridEvent, TerminalGridProps, Terminals, terminal_grid};

/// What TSX may import from `deskfolk/native`.
#[native_module("deskfolk/native")]
fn native(registry: &mut Registry) {
    registry.register::<TerminalGrid>().module::<Terminals>().module::<Documents>().module::<Markdown>().module::<Office>().module::<Screens>();
}
