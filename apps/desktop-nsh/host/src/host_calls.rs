//! What a window's app may ask of the shell (`host.call` in TSX; each name is granted in
//! `nsh.json` `capabilities.host`). Handlers run on the engine thread, so anything AppKit hops to
//! the main queue.

use dispatch2::DispatchQueue;
use nsh_engine::{HostCall, HostChannel};
use objc2::MainThreadMarker;
use serde_json::{Value, json};

pub fn install(host: &HostChannel, window_id: u32) {
    host.handle("shell.notify", |call: HostCall| {
        let data = call.data();
        let id = data["id"].as_str().unwrap_or("deskfolk").to_owned();
        let title = data["title"].as_str().unwrap_or_default().to_owned();
        let body = data["body"].as_str().unwrap_or_default().to_owned();
        match crate::notify::post(&id, &title, &body) {
            Ok(()) => call.resolve(json!(true)),
            Err(why) => call.reject(why),
        }
    });

    host.handle("shell.badge", |call: HostCall| {
        let label = call.data().as_str().map(str::to_owned);
        call.resolve(Value::Null);
        on_main(move |mtm| crate::notify::set_badge(mtm, label.as_deref()));
    });

    host.handle("shell.newWindow", |call: HostCall| {
        call.resolve(Value::Null);
        on_main(|mtm| crate::app::new_window(mtm));
    });

    host.handle("shell.windowInfo", move |call: HostCall| {
        call.resolve(json!({ "id": window_id, "notifications": crate::notify::available() }));
    });

    // The messenger's Tauri commands the shell answers (`app/src/platform/tauri-bridge.ts`).
    host.handle("tauri.pick_workspace_folder", |call: HostCall| {
        on_main(move |mtm| crate::system::pick_folder(mtm, call));
    });
    host.handle("tauri.open_workspace_path", crate::system::open_path);
    host.handle("tauri.hide_main_window", move |call: HostCall| {
        call.resolve(Value::Null);
        on_main(move |_| crate::window::hide(window_id));
    });

    host.handle("shell.openExternal", |call: HostCall| {
        let Some(url) = call.data().as_str().map(str::to_owned) else {
            call.reject("a URL is required");
            return;
        };
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            call.reject("only http(s) URLs open outside");
            return;
        }
        call.resolve(Value::Null);
        on_main(move |_| crate::app::open_url(&url));
    });
}

fn on_main(work: impl FnOnce(MainThreadMarker) + Send + 'static) {
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        work(mtm);
    });
}
