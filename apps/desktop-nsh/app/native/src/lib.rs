//! The app's own Rust, built for every target NSH builds the app for — the desktops' hosts and the
//! web's wasm alike — so what NSH lacks is filled once, on NSH, rather than per platform.
//!
//! TSX imports it as `deskfolk/native`. PDF pages are a crate of their own, `app/pdf` (`deskfolk/pdf`).

use nsh_core::prelude::*;

/// NSH's `blocking` runs a closure on the runtime's blocking threads; WebAssembly has none, so NSH
/// leaves it out there and the phone's build (`nsh package Hosted.tsx --target web`) did not compile.
/// On the web the closure runs where it is called, and the caller's `.await` gets its value as the
/// desktop's `JoinHandle` gives it (`Ok`, never a join error).
#[cfg(target_arch = "wasm32")]
pub(crate) fn blocking<R>(f: impl FnOnce() -> R) -> std::future::Ready<Result<R, std::convert::Infallible>> {
    std::future::ready(Ok(f()))
}

#[cfg(not(target_arch = "wasm32"))]
mod office;
// The web's `Office`: the same functions, answering that there are no previews there yet
// (`office_web.rs`, and the note on `zip` in `Cargo.toml`).
#[cfg(target_arch = "wasm32")]
#[path = "office_web.rs"]
mod office;
// Ghostty's emulator for `RuntimeTerminals` (`nsh_terminal.rs`), with the `ghostty` feature.
#[cfg(all(feature = "ghostty", not(target_arch = "wasm32")))]
mod ghostty;
mod files;
mod highlight;
mod markdown;
mod nsh_terminal;
mod palette;
mod rfb;

pub use files::Files;
pub use highlight::{CodeColors, CodeColorsElement, CodeColorsProps, Highlight, code_colors};
pub use markdown::Markdown;
pub use nsh_terminal::{RuntimeEmulator, RuntimeTerminals, RuntimeTerminalsElement, RuntimeTerminalsProps, runtime_terminals};
pub use office::Office;
pub use rfb::Screens;

/// What TSX may import from `deskfolk/native`.
#[native_module("deskfolk/native")]
fn native(registry: &mut Registry) {
    registry.register::<RuntimeTerminals>().register::<CodeColors>().module::<Markdown>().module::<Highlight>().module::<Office>().module::<Screens>().module::<Files>();
}
