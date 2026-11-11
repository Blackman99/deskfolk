//! Office files on every target, in pure Rust, without a web view: Excel through `calamine`
//! (`sheet`), Word (`word`) and PowerPoint (`slides`) through `zip` and `quick-xml`. The file comes
//! from the runtime (`/v1/workspace/file`), fetched here as `Documents::open_pdf` fetches a PDF,
//! its package checked as the messenger checks it (`archive`), and the model handed back as JSON
//! for TSX to draw. Pictures stay in the package: the model names them (`office-image:<part>`) and
//! `office_image` turns one into a data URL when the view needs it.

mod archive;
mod color;
mod sheet;
mod slides;
mod word;
mod xml;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;

pub use archive::{Kind, OFFICE_MAX_BYTES};

thread_local! {
    static OPEN: RefCell<HashMap<String, Rc<RefCell<archive::Package>>>> = RefCell::new(HashMap::new());
}

/// The model of `data` as JSON, and the package when pictures are to be read from it later.
pub fn model(kind: Kind, data: Vec<u8>) -> Result<(String, Option<archive::Package>), String> {
    if data.len() > OFFICE_MAX_BYTES {
        return Err(archive::LIMIT.into());
    }
    let json = |v: serde_json::Value| serde_json::to_string(&v).map_err(|e| e.to_string());
    match kind {
        Kind::Spreadsheet => {
            // xlsx and ods are packages (and checked as one); xls is not.
            if data.starts_with(b"PK") {
                archive::Package::open_with(data.clone(), &["xl/workbook.xml", "xl/workbook.bin", "content.xml"])?;
            }
            let book = sheet::read(&data)?;
            Ok((json(serde_json::to_value(book).map_err(|e| e.to_string())?)?, None))
        }
        Kind::Word => {
            let mut pkg = archive::Package::open(data, kind)?;
            let value = word::read(&mut pkg)?;
            Ok((json(value)?, Some(pkg)))
        }
        Kind::Presentation => {
            let mut pkg = archive::Package::open(data, kind)?;
            let value = slides::read(&mut pkg)?;
            Ok((json(value)?, Some(pkg)))
        }
    }
}

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
        let kind = Kind::parse(&kind)?;
        let response = fetch(HttpRequest::get(url).header("Authorization", format!("Bearer {token}"))).await?;
        if !response.ok() {
            return Err(format!("the runtime answered {}", response.status()));
        }
        Self::open_office_bytes(id, kind_name(kind).into(), B64.encode(&response.body))
    }

    /// As `open_office`, from the file's bytes in Base64.
    pub fn open_office_bytes(id: String, kind: String, base64: String) -> Result<String, String> {
        let kind = Kind::parse(&kind)?;
        let data = B64.decode(base64.trim()).map_err(|_| archive::INVALID.to_string())?;
        let (json, pkg) = model(kind, data)?;
        OPEN.with_borrow_mut(|open| {
            open.remove(&id);
            if let Some(pkg) = pkg {
                open.insert(id, Rc::new(RefCell::new(pkg)));
            }
        });
        Ok(json)
    }

    /// The picture `part` of Office document `id` as a data URL.
    pub fn office_image(id: String, part: String) -> Result<String, String> {
        let pkg = OPEN.with_borrow(|open| open.get(&id).cloned()).ok_or("the document is not open")?;
        let bytes = pkg.borrow_mut().read(&part).ok_or("no such picture")?;
        Ok(format!("data:{};base64,{}", archive::mime_of(&part), B64.encode(bytes)))
    }

    /// Forgets Office document `id`.
    pub fn close_office(id: String) {
        OPEN.with_borrow_mut(|open| open.remove(&id));
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Word => "word",
        Kind::Spreadsheet => "spreadsheet",
        Kind::Presentation => "presentation",
    }
}

#[cfg(test)]
mod tests;
