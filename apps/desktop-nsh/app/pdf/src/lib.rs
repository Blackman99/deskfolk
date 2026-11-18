//! The app's PDF pages, built for every target NSH builds the app for, the desktops' hosts and the
//! web's wasm alike (`src/pdf`). TSX imports it as `deskfolk/pdf`.
//!
//! It was part of `app/native` (`deskfolk/native`) until 2026-11-18. On the web each of the app's
//! crates is a module of its own, which the page downloads when the first code that imports it
//! loads; PDF was nine tenths of `deskfolk/native` there (4.5 of 4.9 MB: hayro, the `brotli` its
//! CMaps take, the embedded fonts), and the phone downloaded it to show a conversation's Markdown.
//! Apart, it comes only with the PDF viewer (ADR 0107 addendum 62).

use nsh_core::prelude::*;

/// NSH's `blocking` runs a closure on the runtime's blocking threads; WebAssembly has none, so NSH
/// leaves it out there. On the web the closure runs where it is called, and the caller's `.await`
/// gets its value as the desktop's `JoinHandle` gives it (`Ok`, never a join error). As in
/// `app/native`.
#[cfg(target_arch = "wasm32")]
pub(crate) fn blocking<R>(f: impl FnOnce() -> R) -> std::future::Ready<Result<R, std::convert::Infallible>> {
    std::future::ready(Ok(f()))
}

mod pdf;

pub use pdf::Documents;

/// What TSX may import from `deskfolk/pdf`.
#[native_module("deskfolk/pdf")]
fn native(registry: &mut Registry) {
    registry.module::<Documents>();
}
