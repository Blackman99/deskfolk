//! A document's picture as the preview shows it: a data URL, scaled down past a size no pane
//! needs, so the image view does not decode a full-size photo on the engine thread.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use image::{DynamicImage, ImageFormat, imageops::FilterType};
use std::io::Cursor;

use super::archive;

/// `bytes` of picture `part` as a data URL; a PNG or JPEG larger than `max` on its longer side
/// comes back scaled to it (PNG when it has transparency, else JPEG). Anything else, or a picture
/// that does not decode, is handed back as it is.
pub fn data_url(part: &str, bytes: Vec<u8>, max: u32) -> String {
    let mime = archive::mime_of(part);
    if max > 0 && (mime == "image/png" || mime == "image/jpeg") {
        if let Some((mime, smaller)) = scaled(&bytes, max) {
            return format!("data:{mime};base64,{}", B64.encode(smaller));
        }
    }
    format!("data:{mime};base64,{}", B64.encode(bytes))
}

fn scaled(bytes: &[u8], max: u32) -> Option<(&'static str, Vec<u8>)> {
    let reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width.max(height) <= max {
        return None;
    }
    let picture = image::load_from_memory(bytes).ok()?;
    let small = picture.resize(max, max, FilterType::Triangle);
    let mut out = Cursor::new(Vec::new());
    if small.color().has_alpha() {
        small.write_to(&mut out, ImageFormat::Png).ok()?;
        Some(("image/png", out.into_inner()))
    } else {
        DynamicImage::ImageRgb8(small.to_rgb8()).write_to(&mut out, ImageFormat::Jpeg).ok()?;
        Some(("image/jpeg", out.into_inner()))
    }
}
