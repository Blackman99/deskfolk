//! `deskfolk.pdf`: a PDF document in PDFKit's own view, so a PDF artifact scrolls, zooms and has
//! its text selected and copied the way Preview does it — what pdfjs did in the web view.
//!
//! Props: `path` (an absolute file path on this Mac), `background` (`"#rrggbb"`, the gutter
//! around the pages). Events: `loaded` `{ pages, firstLine }`, `error` `{ message }`.
//! Commands: `zoomIn`, `zoomOut`, `fit`, `goToPage` `{ index }` (from 0).

#[cfg(target_os = "macos")]
mod mac {
    use std::rc::Rc;

    use nsh_core::JsonValue;
    use nsh_platform_macos::{AppView, ComponentContext, NativeComponent};
    use objc2::rc::Retained;
    use objc2::{AllocAnyThread, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSColor, NSView};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_pdf_kit::{PDFDisplayMode, PDFDocument, PDFView};
    use serde_json::json;

    pub const NAME: &str = "deskfolk.pdf";

    struct Pdf {
        view: Retained<PDFView>,
        context: ComponentContext,
        path: Option<String>,
    }

    impl Pdf {
        fn new(mtm: MainThreadMarker, context: ComponentContext) -> Self {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 500.0));
            let view = unsafe { PDFView::initWithFrame(PDFView::alloc(mtm), frame) };
            unsafe {
                view.setAutoScales(true);
                view.setDisplayMode(PDFDisplayMode::SinglePageContinuous);
                view.setDisplaysPageBreaks(true);
            }
            Pdf { view, context, path: None }
        }

        fn open(&mut self, path: Option<&str>) {
            if self.path.as_deref() == path {
                return;
            }
            self.path = path.map(str::to_owned);
            let Some(path) = path else {
                unsafe { self.view.setDocument(None) };
                return;
            };
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let document = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) };
            match document {
                Some(document) => {
                    let pages = unsafe { document.pageCount() };
                    // The first page's opening words: what PDFKit read, for the app and for checks.
                    let first = unsafe { document.pageAtIndex(0) }
                        .and_then(|page| unsafe { page.string() })
                        .map(|text| text.to_string().lines().next().unwrap_or_default().chars().take(80).collect::<String>())
                        .unwrap_or_default();
                    unsafe { self.view.setDocument(Some(&document)) };
                    self.context.emit("loaded", json!({ "pages": pages, "firstLine": first }));
                }
                None => {
                    unsafe { self.view.setDocument(None) };
                    self.context.emit("error", json!({ "message": format!("cannot open {path} as a PDF") }));
                }
            }
        }
    }

    impl NativeComponent for Pdf {
        fn view(&self) -> Retained<NSView> {
            Retained::into_super(self.view.clone())
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            match name {
                "path" => self.open(value.and_then(JsonValue::as_str)),
                "background" => {
                    if let Some(color) = value.and_then(JsonValue::as_str).and_then(parse_hex) {
                        unsafe { self.view.setBackgroundColor(&color) };
                    }
                }
                _ => {}
            }
        }

        fn command(&mut self, name: &str, args: &JsonValue) {
            unsafe {
                match name {
                    "zoomIn" => self.view.zoomIn(None),
                    "zoomOut" => self.view.zoomOut(None),
                    "fit" => self.view.setAutoScales(true),
                    "goToPage" => {
                        let index = args["index"].as_u64().unwrap_or(0) as usize;
                        if let Some(document) = self.view.document() {
                            if let Some(page) = document.pageAtIndex(index) {
                                self.view.goToPage(&page);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn parse_hex(hex: &str) -> Option<Retained<NSColor>> {
        let hex = hex.strip_prefix('#')?;
        if hex.len() != 6 {
            return None;
        }
        let n = u32::from_str_radix(hex, 16).ok()?;
        let c = |shift: u32| f64::from((n >> shift) & 0xff) / 255.0;
        Some(NSColor::colorWithSRGBRed_green_blue_alpha(c(16), c(8), c(0), 1.0))
    }

    pub fn register(view: &AppView, mtm: MainThreadMarker) {
        view.register_component(
            NAME,
            Rc::new(move |context: ComponentContext| -> Box<dyn NativeComponent> { Box::new(Pdf::new(mtm, context)) }),
        );
    }
}

#[cfg(target_os = "macos")]
pub use mac::{NAME, register};
