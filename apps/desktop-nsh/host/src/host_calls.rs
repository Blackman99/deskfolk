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

    // The notification commands (`notification_loop.rs`). Those that wait on Notification Center
    // answer from a thread of their own, so an engine thread never sits on the system's prompt.
    host.handle("tauri.notification_permission_state", |call: HostCall| {
        std::thread::spawn(move || {
            let dto = crate::notification_loop::permission_state(crate::notification_loop::state());
            call.resolve(json!(dto));
        });
    });
    host.handle("tauri.request_notification_permission", |call: HostCall| {
        std::thread::spawn(move || {
            match crate::notification_loop::request_permission(crate::notification_loop::state()) {
                Ok(dto) => call.resolve(json!(dto)),
                Err(why) => call.reject(why),
            }
        });
    });
    host.handle("tauri.take_notification_intent", |call: HostCall| {
        match crate::notification_loop::take_intent(crate::notification_loop::state()) {
            Ok(intent) => call.resolve(json!(intent)),
            Err(why) => call.reject(why),
        }
    });
    host.handle("tauri.report_notification_view", move |call: HostCall| {
        let report = serde_json::from_value(call.data()["report"].clone()).unwrap_or_default();
        on_main(move |_| {
            let facts = crate::notification_loop::report_view(
                crate::notification_loop::state(),
                window_id,
                crate::window::facts(window_id),
                report,
                crate::notification_loop::endpoint(),
            );
            call.resolve(json!(facts));
        });
    });

    // Voice input's recording (`recorder.rs`), under `app/src/platform/media.ts`.
    host.handle("shell.record.start", |call: HostCall| {
        on_main(move |mtm| {
            crate::recorder::start(mtm, move |result| match result {
                Ok(()) => call.resolve(Value::Null),
                Err(why) => call.reject(why),
            })
        });
    });
    host.handle("shell.record.level", |call: HostCall| {
        on_main(move |_| call.resolve(json!(crate::recorder::level())));
    });
    host.handle("shell.record.stop", |call: HostCall| {
        on_main(move |_| match crate::recorder::stop() {
            Ok(value) => call.resolve(value),
            Err(why) => call.reject(why),
        });
    });
    host.handle("shell.record.cancel", |call: HostCall| {
        on_main(move |_| {
            crate::recorder::cancel();
            call.resolve(Value::Null);
        });
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
