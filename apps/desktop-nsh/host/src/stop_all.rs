//! The tray's "Stop Everything", the Tauri app's 全部停下 (`local_api::post_stop`): a global hold,
//! which pauses every plan and ends the live turns it covers ("stop for now": your next line to a
//! Bot lifts it for that Bot), and where holds are not available yet, a stop of the latest turn.
//! The item can be chosen only while this shell's runtime answers, as in the Tauri tray.

// The Linux shell has no tray yet (it gets one with the rest of the Linux shell).
#![cfg_attr(target_os = "linux", allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;

use crate::endpoint;

static ANSWERS: AtomicBool = AtomicBool::new(false);

/// Whether the runtime answered at the last look (`watch`): never asked of the network on the main
/// thread or the tray's.
pub fn available() -> bool {
    ANSWERS.load(Ordering::Relaxed)
}

/// Looks once a second whether this shell's runtime answers, for `available`.
pub fn watch() {
    std::thread::spawn(|| {
        loop {
            let answers = endpoint::data_dir()
                .and_then(|dir| endpoint::read(&dir).ok())
                .is_some_and(|found| crate::runtime::healthy(found.port));
            ANSWERS.store(answers, Ordering::Relaxed);
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Stops everything, on a thread of its own: it waits on the runtime.
pub fn request() {
    std::thread::spawn(|| match stop() {
        Ok(how) => log::info!("stopped everything ({how})"),
        Err(why) => log::warn!("cannot stop everything: {why}"),
    });
}

/// `POST /v1/holds {"scope":"global"}`; if that is refused (no holds at this engine level, `409`) or
/// does not answer, `POST /v1/turns/stop {}`. The descriptor is read again each time: a runtime that
/// started again has a new token.
fn stop() -> Result<&'static str, String> {
    let dir = endpoint::data_dir().ok_or("no data directory")?;
    let found = endpoint::read(&dir).map_err(|why| why.to_string())?;
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build();
    let post = |path: &str, body: serde_json::Value| {
        agent
            .post(&format!("{}{path}", found.origin))
            .set("Authorization", &format!("Bearer {}", found.token))
            .send_json(body)
    };
    match post("/v1/holds", json!({ "scope": "global" })) {
        Ok(_) => Ok("a global hold"),
        Err(why) => {
            log::info!("no global hold ({why}); stopping the latest turn");
            post("/v1/turns/stop", json!({})).map(|_| "the latest turn").map_err(|why| why.to_string())
        }
    }
}
