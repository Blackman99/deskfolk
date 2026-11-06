//! The package checks of `apps/messenger/src/lib/overlays/office/archive.ts`, in Rust: a file over
//! 50 MiB, an archive of more than 4000 entries, an entry over 32 MiB or all of them over 128 MiB
//! expanded is `office-limit`; a package without `[Content_Types].xml` and its main part is
//! `office-invalid`. The numbers come from the entries' headers, and reading an entry stops at the
//! limit anyway, so a header that lies cannot run a zip bomb.

use std::io::{Cursor, Read};

use zip::ZipArchive;

pub const OFFICE_MAX_BYTES: usize = 50 * 1024 * 1024;
const MAX_EXPANDED: u64 = 128 * 1024 * 1024;
pub const MAX_ENTRY: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 4000;

pub const LIMIT: &str = "office-limit";
pub const INVALID: &str = "office-invalid";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Word,
    Spreadsheet,
    Presentation,
}

impl Kind {
    pub fn parse(name: &str) -> Result<Kind, String> {
        match name {
            "word" => Ok(Kind::Word),
            "spreadsheet" => Ok(Kind::Spreadsheet),
            "presentation" => Ok(Kind::Presentation),
            other => Err(format!("unknown Office kind {other}")),
        }
    }

    fn main_part(self) -> &'static str {
        match self {
            Kind::Word => "word/document.xml",
            Kind::Spreadsheet => "xl/workbook.xml",
            Kind::Presentation => "ppt/presentation.xml",
        }
    }
}

/// An opened, checked package: its parts are read on demand.
#[derive(Debug)]
pub struct Package {
    zip: ZipArchive<Cursor<Vec<u8>>>,
}

impl Package {
    /// Checks `data` as a package of `kind` and opens it.
    pub fn open(data: Vec<u8>, kind: Kind) -> Result<Package, String> {
        Package::open_with(data, &[kind.main_part()])
    }

    /// As `open`, for a package whose main part is any one of `mains`.
    pub fn open_with(data: Vec<u8>, mains: &[&str]) -> Result<Package, String> {
        if data.len() > OFFICE_MAX_BYTES {
            return Err(LIMIT.into());
        }
        let mut zip = ZipArchive::new(Cursor::new(data)).map_err(|_| INVALID.to_string())?;
        if zip.len() > MAX_ENTRIES {
            return Err(LIMIT.into());
        }
        let mut expanded = 0u64;
        let mut has_types = false;
        let mut has_main = false;
        for i in 0..zip.len() {
            let file = zip.by_index_raw(i).map_err(|_| INVALID.to_string())?;
            expanded += file.size();
            if file.size() > MAX_ENTRY || expanded > MAX_EXPANDED {
                return Err(LIMIT.into());
            }
            has_types |= file.name_raw() == b"[Content_Types].xml";
            has_main |= mains.iter().any(|m| file.name_raw() == m.as_bytes());
        }
        if !has_types || !has_main {
            return Err(INVALID.into());
        }
        Ok(Package { zip })
    }

    /// A part's bytes, or None when there is no such part (or it cannot be read).
    pub fn read(&mut self, name: &str) -> Option<Vec<u8>> {
        let mut file = self.zip.by_name(name).ok()?;
        let mut out = Vec::new();
        file.by_ref().take(MAX_ENTRY + 1).read_to_end(&mut out).ok()?;
        if out.len() as u64 > MAX_ENTRY { None } else { Some(out) }
    }

    /// A part read as XML.
    pub fn xml(&mut self, name: &str) -> Option<super::xml::Node> {
        super::xml::parse(&self.read(name)?).ok()
    }
}

/// The part a relationship `target` names, from the part `base` it was written in.
pub fn resolve(base: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for seg in target.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// The relationships of `part` (`word/document.xml` → `word/_rels/document.xml.rels`): id → (target, external).
pub fn relationships(pkg: &mut Package, part: &str) -> std::collections::HashMap<String, (String, bool)> {
    let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
    let rels = if dir.is_empty() { format!("_rels/{file}.rels") } else { format!("{dir}/_rels/{file}.rels") };
    let mut map = std::collections::HashMap::new();
    if let Some(root) = pkg.xml(&rels) {
        for rel in root.kids("Relationship") {
            let (Some(id), Some(target)) = (rel.attr("Id"), rel.attr("Target")) else { continue };
            let external = rel.attr("TargetMode").is_some_and(|m| m.eq_ignore_ascii_case("external"));
            let target = if external { target.to_string() } else { resolve(part, target) };
            map.insert(id.to_string(), (target, external));
        }
    }
    map
}

pub fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("tif") | Some("tiff") => "image/tiff",
        _ => "application/octet-stream",
    }
}

/// The target of the first relationship of `part` whose type ends with `suffix` (`slideLayout`).
pub fn related(pkg: &mut Package, part: &str, suffix: &str) -> Option<String> {
    let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
    let rels = if dir.is_empty() { format!("_rels/{file}.rels") } else { format!("{dir}/_rels/{file}.rels") };
    let root = pkg.xml(&rels)?;
    let rel = root.kids("Relationship").find(|r| r.attr("Type").is_some_and(|t| t.ends_with(suffix)))?;
    Some(resolve(part, rel.attr("Target")?))
}
