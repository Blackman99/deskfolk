//! What a window's app may ask of the shell (`host.call` in TSX; each name is granted in
//! `nsh.json` `capabilities.host`). Handlers run on the engine thread, so anything AppKit hops to
//! the main queue.

use dispatch2::DispatchQueue;
use crate::dev_build::Identity;
use nsh_engine::{HostCall, HostChannel};
use objc2::MainThreadMarker;
use serde_json::{Value, json};

pub fn install(host: &HostChannel, window_id: u32, identity: &Identity) {
    install_system(host, identity);
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

    // A press elsewhere takes the keyboard from the field that edits (`press.rs`): by itself, or,
    // while the app shows a list that keeps the focus (`shell.keepers`), when the app asks.
    host.handle("shell.keepers", move |call: HostCall| {
        let count = call.data().as_u64().unwrap_or(0);
        call.resolve(Value::Null);
        crate::press::set_keepers(window_id, count);
    });
    host.handle("shell.blur", |call: HostCall| {
        let number = call.data().as_u64();
        call.resolve(Value::Null);
        if let Some(number) = number {
            on_main(move |_| crate::press::blur(number));
        }
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

/// Launch at login, the independent runtime, remote pairing on this Mac and the in-app update
/// install: the Tauri app's `lib.rs`, `remote_native.rs` and `remote_setup.rs` commands. A dev
/// build (`dev_build.rs`) answers each as the Tauri dev build does. The calls that wait on the
/// system, a daemon or the network answer from a thread of their own.
fn install_system(host: &HostChannel, identity: &Identity) {
    let id = identity.clone();
    host.handle("tauri.set_launch_at_login", move |call: HostCall| {
        let enabled = call.data()["enabled"].as_bool().unwrap_or(false);
        let id = id.clone();
        on_main(move |_| match crate::login_item::set(&id, enabled) {
            Ok(state) => call.resolve(json!(state)),
            Err(why) => call.reject(why),
        });
    });

    let id = identity.clone();
    host.handle("tauri.independent_runtime_status", move |call: HostCall| {
        let id = id.clone();
        std::thread::spawn(move || call.resolve(json!(crate::independent::status(&id))));
    });
    let id = identity.clone();
    host.handle("tauri.independent_runtime", move |call: HostCall| {
        let id = id.clone();
        std::thread::spawn(move || {
            let request = serde_json::from_value::<crate::independent::Request>(call.data()["request"].clone());
            match request.map_err(|_| "malformed".to_string()).and_then(|r| crate::independent::run(&id, &r)) {
                Ok(status) => call.resolve(json!(status)),
                Err(why) => call.reject(why),
            }
        });
    });

    let id = identity.clone();
    host.handle("tauri.remote_local_setup", move |call: HostCall| {
        let id = id.clone();
        std::thread::spawn(move || match crate::remote_setup::local_setup(&id, call.data()["request"].clone()) {
            Ok(reply) => call.resolve(reply),
            Err(why) => call.reject(why),
        });
    });
    let id = identity.clone();
    host.handle("tauri.remote_native_confirmation", move |call: HostCall| {
        let id = id.clone();
        std::thread::spawn(move || {
            let data = call.data();
            let operation = serde_json::from_value(data["operation"].clone()).map_err(|_| "malformed".to_string());
            let challenge = data["challenge"].as_str().map(str::to_owned);
            match operation.and_then(|op| crate::remote_native::confirmation(&id, op, challenge)) {
                Ok(done) => call.resolve(json!(done)),
                Err(why) => call.reject(why),
            }
        });
    });

    let id = identity.clone();
    host.handle("tauri.can_install_update", move |call: HostCall| {
        let id = id.clone();
        std::thread::spawn(move || call.resolve(json!(crate::update_commands::can_install(&id))));
    });
    host.handle("tauri.update_install_state", |call: HostCall| call.resolve(json!(crate::update_commands::state())));
    host.handle("tauri.cancel_update_install", |call: HostCall| call.resolve(json!(crate::update_commands::cancel())));
    let id = identity.clone();
    host.handle("tauri.start_update_install", move |call: HostCall| {
        let data = call.data();
        let (url, version) = (data["url"].as_str().unwrap_or_default().to_owned(), data["version"].as_str().unwrap_or_default().to_owned());
        let id = id.clone();
        std::thread::spawn(move || {
            let quit = || on_main(|mtm| objc2_app_kit::NSApplication::sharedApplication(mtm).terminate(None));
            match crate::update_commands::start(&id, &url, &version, quit) {
                Ok(state) => call.resolve(json!(state)),
                Err(why) => call.reject(why),
            }
        });
    });
}

fn on_main(work: impl FnOnce(MainThreadMarker) + Send + 'static) {
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        work(mtm);
    });
}
