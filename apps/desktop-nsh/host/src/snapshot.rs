//! Development only: each window draws itself into a PNG, so a check can see the window without
//! the Screen Recording permission or the person's screen. The window's layers are rendered
//! (`CALayer.renderInContext`); the system's material behind them is a window-server effect and
//! comes out plain.
//!
//! Asked for by creating `<dir>/request`; answered with `<dir>/window-<id>.png` and the request
//! removed.

use std::path::{Path, PathBuf};

use objc2::AllocAnyThread;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSView, NSWindow};
use objc2_core_graphics::{CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImageAlphaInfo};
use objc2_foundation::{NSDictionary, NSString};

const DRAWN_CLASSES: &[&str] = &["PDFView"];

fn overlay_drawn_views(root: &NSView, view: &NSView, context: &CGContext, root_height: f64) {
    for child in view.subviews().iter() {
        let class = child.class().name().to_str().unwrap_or_default();
        if DRAWN_CLASSES.contains(&class) && !child.isHiddenOrHasHiddenAncestor() {
            let bounds = child.bounds();
            if let Some(rep) = child.bitmapImageRepForCachingDisplayInRect(bounds) {
                child.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
                if let Some(image) = rep.CGImage() {
                    // Into the root's coordinates, then the bitmap's (origin at the bottom left).
                    let frame = child.convertRect_toView(bounds, Some(root));
                    let y = if root.isFlipped() { root_height - frame.origin.y - frame.size.height } else { frame.origin.y };
                    let rect = objc2_core_foundation::CGRect::new(
                        objc2_core_foundation::CGPoint::new(frame.origin.x, y),
                        objc2_core_foundation::CGSize::new(frame.size.width, frame.size.height),
                    );
                    CGContext::draw_image(Some(context), rect, Some(&image));
                }
            }
            continue;
        }
        overlay_drawn_views(root, &child, context, root_height);
    }
}

pub fn request_path(dir: &Path) -> PathBuf {
    dir.join("request")
}

/// Renders `window` at its backing scale into `path`.
pub fn write(window: &NSWindow, path: &Path) -> Result<(), String> {
    let content = window.contentView().ok_or("no content view")?;
    let layer = content.layer().ok_or("the content view has no layer")?;
    let bounds = content.bounds();
    let scale = window.backingScaleFactor();
    let width = (bounds.size.width * scale).round() as usize;
    let height = (bounds.size.height * scale).round() as usize;
    if width == 0 || height == 0 {
        return Err("the window has no size".into());
    }
    let space = CGColorSpace::new_device_rgb().ok_or("no colour space")?;
    let context = unsafe {
        CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            0,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0,
        )
    }
    .ok_or("no bitmap context")?;
    // An opaque ground under the layers, as the material would show it.
    CGContext::set_rgb_fill_color(Some(&context), 0.93, 0.945, 0.95, 1.0);
    CGContext::fill_rect(
        Some(&context),
        objc2_core_foundation::CGRect::new(
            objc2_core_foundation::CGPoint::new(0.0, 0.0),
            objc2_core_foundation::CGSize::new(width as f64, height as f64),
        ),
    );
    CGContext::scale_ctm(Some(&context), scale, scale);
    layer.renderInContext(&context);
    // Views that draw outside their layers' contents (PDFKit's tiled pages) are asked to draw
    // themselves and laid over the picture where they sit.
    overlay_drawn_views(&content, &content, &context, bounds.size.height);
    let image = CGBitmapContextCreateImage(Some(&context)).ok_or("no image")?;
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
        .ok_or("PNG encoding failed")?;
    let written = png.writeToFile_atomically(&NSString::from_str(&path.to_string_lossy()), true);
    if written { Ok(()) } else { Err(format!("cannot write {}", path.display())) }
}
