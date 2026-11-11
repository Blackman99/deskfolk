//! Office documents on the web: not yet. `src/office` reads them with `calamine` and `zip`, and on
//! wasm32 `zip` 9 turns on `getrandom` 0.4's `wasm_js`, which does not compile under the
//! `getrandom_backend="custom"` cfg NSH adds to every web build (ADR 0107, Phase 1c). Until that is
//! fixed upstream the web keeps the module's shape — the same functions, so `deskfolk/native`'s
//! `Office` is there on every target — and each one answers that there is no preview here; the
//! viewer shows that as its error state.

use nsh_core::prelude::*;

const UNAVAILABLE: &str = "Office previews are not available on the web yet";

/// Office documents the app previews.
#[module]
pub struct Office;

#[module]
impl Office {
    /// Fetches `url` (the runtime's file endpoint) with `token` and opens it as Office document
    /// `id` of `kind` (`word`, `spreadsheet` or `presentation`); resolves with its model as JSON.
    /// Rejects with `office-limit` (too large, or an archive that expands too far), `office-invalid`
    /// (not a package of that kind) or the reason it could not be read.
    pub async fn open_office(id: String, url: String, token: String, kind: String) -> Result<String, String> {
        let _ = (id, url, token, kind);
        Err(UNAVAILABLE.into())
    }

    /// As `open_office`, from the file's bytes in Base64.
    pub fn open_office_bytes(id: String, kind: String, base64: String) -> Result<String, String> {
        let _ = (id, kind, base64);
        Err(UNAVAILABLE.into())
    }

    /// The picture `part` of Office document `id` as a data URL.
    pub fn office_image(id: String, part: String) -> Result<String, String> {
        let _ = (id, part);
        Err(UNAVAILABLE.into())
    }

    /// Forgets Office document `id`.
    pub fn close_office(id: String) {
        let _ = id;
    }
}
