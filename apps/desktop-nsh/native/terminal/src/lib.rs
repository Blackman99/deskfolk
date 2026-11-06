//! `deskfolk.terminal`: one of the runtime's terminals, drawn and typed into natively — what
//! xterm.js did in the web view.
//!
//! Props: `terminalId`, `fontSize` (points, 13), `dark`. Events: `exit`, `error` `{ message }`,
//! `size` `{ rows, cols }`. Commands: `focus`.
//!
//! The component reaches the runtime with the shell's own port and token (`register`), on a
//! socket and HTTP calls of its own: no secret crosses as a prop and no byte passes through JS.

pub mod keys;
pub mod palette;
pub mod perf;
pub mod session;
#[cfg(target_os = "macos")]
mod view;

pub use session::Endpoint;

#[cfg(target_os = "macos")]
pub const NAME: &str = "deskfolk.terminal";

#[cfg(target_os = "macos")]
mod component {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use dispatch2::DispatchQueue;
    use nsh_core::JsonValue;
    use nsh_platform_macos::{AppView, ComponentContext, NativeComponent};
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSView;
    use serde_json::json;

    use crate::session::{Endpoint, Observer, Session, Size};
    use crate::view::{self, TerminalView};

    thread_local! {
        static VIEWS: RefCell<HashMap<u64, Retained<TerminalView>>> = RefCell::new(HashMap::new());
        static NEXT: Cell<u64> = const { Cell::new(1) };
    }

    fn on_view(id: u64, work: impl FnOnce(&TerminalView)) {
        VIEWS.with_borrow(|views| {
            if let Some(view) = views.get(&id) {
                work(view);
            }
        });
    }

    /// Hears the session on its threads and hops to the main thread, one redraw at a time.
    struct Bridge {
        id: u64,
        pending: Arc<AtomicBool>,
        context: ComponentContext,
    }

    impl Observer for Bridge {
        fn changed(&self) {
            if self.pending.swap(true, Ordering::AcqRel) {
                return;
            }
            let (id, pending) = (self.id, self.pending.clone());
            // Cleared on the main thread, so one hop covers every change made before it.
            DispatchQueue::main().exec_async(move || {
                pending.store(false, Ordering::Release);
                on_view(id, |view| view.setNeedsDisplay(true));
            });
        }

        fn attached(&self, _size: Size) {
            let id = self.id;
            DispatchQueue::main().exec_async(move || on_view(id, |view| view.fit()));
        }

        fn exited(&self) {
            self.context.emit("exit", json!({ "code": null }));
        }

        fn failed(&self, message: String) {
            self.context.emit("error", json!({ "message": message }));
        }
    }

    struct Terminal {
        id: u64,
        view: Retained<TerminalView>,
        endpoint: Endpoint,
        context: ComponentContext,
        terminal: Option<String>,
    }

    impl Terminal {
        fn attach(&mut self, terminal: Option<&str>) {
            if self.terminal.as_deref() == terminal {
                return;
            }
            self.terminal = terminal.map(str::to_owned);
            view::detach(&self.view);
            let Some(terminal) = terminal else { return };
            let bridge = Arc::new(Bridge { id: self.id, pending: Arc::new(AtomicBool::new(false)), context: self.context.clone() });
            let session = Session::start(self.endpoint.clone(), terminal.to_owned(), bridge);
            view::attach(&self.view, session);
        }
    }

    impl NativeComponent for Terminal {
        fn view(&self) -> Retained<NSView> {
            Retained::into_super(self.view.clone())
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            match name {
                "terminalId" => self.attach(value.and_then(JsonValue::as_str)),
                "fontSize" => self.view.set_font_size(value.and_then(JsonValue::as_f64).unwrap_or(13.0)),
                "dark" => self.view.set_dark(value.and_then(JsonValue::as_bool).unwrap_or(false)),
                _ => {}
            }
        }

        fn command(&mut self, name: &str, _args: &JsonValue) {
            if name == "focus" {
                self.view.focus();
            }
        }
    }

    impl Drop for Terminal {
        fn drop(&mut self) {
            view::detach(&self.view);
            VIEWS.with_borrow_mut(|views| views.remove(&self.id));
        }
    }

    pub fn register(app: &AppView, mtm: MainThreadMarker, endpoint: Endpoint) {
        app.register_component(
            crate::NAME,
            Rc::new(move |context: ComponentContext| -> Box<dyn NativeComponent> {
                let id = NEXT.with(|n| {
                    let id = n.get();
                    n.set(id + 1);
                    id
                });
                let view = TerminalView::new(mtm, 13.0, false);
                let events = context.clone();
                view.state().on_size = Some(Box::new(move |size: Size| {
                    events.emit("size", json!({ "rows": size.rows, "cols": size.cols }));
                }));
                VIEWS.with_borrow_mut(|views| views.insert(id, view.clone()));
                Box::new(Terminal { id, view, endpoint: endpoint.clone(), context, terminal: None })
            }),
        );
    }
}

#[cfg(target_os = "macos")]
pub use component::register;
