//! The bundled native helper's confirmation, answered as the Tauri app's
//! `remote_native_confirmation` does (`apps/desktop/src-tauri/src/remote_native.rs`): the sealed
//! `libRemoteCredentials.dylib` in `Contents/Resources/native/` and the runtime helper beside it,
//! and, for the shipped daemon, the owner check on a Touch ID sheet (`local_confirm.rs`).
//!
//! Differences from the Tauri file: the command is a plain function over the JSON the TSX sends;
//! `BundledNativeCaller` (a Tauri ACL and document-origin check) becomes `authorize`, which keeps
//! its development rule (`disabled`) and has no frame to check, because the shell's host channel
//! answers only the app bundle it was started with; the helper's process is a static; and the
//! resources folder is `Contents/Resources` next to the executable.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use crate::dev_build::Identity;

/// The helper this shell started, killed with it.
static HELPER: Mutex<Option<Child>> = Mutex::new(None);

pub fn stop_helper() {
    if let Ok(mut child) = HELPER.lock() {
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Capability,
    Ready,
    Create,
    Confirm,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfirmation {
    pub ok: bool,
    pub enabled: bool,
    pub diagnostic: String,
    pub proof: Option<String>,
    pub expires_in: Option<u64>,
}

/// The rule the Tauri `BundledNativeCaller` applies to a development build.
pub fn authorize(id: &Identity) -> Result<(), String> {
    if id.is_dev() {
        return Err("disabled".into());
    }
    Ok(())
}

/// `Contents/Resources` of the running `.app`.
pub fn resource_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "unavailable")?;
    let app = crate::installer::bundle_root(&exe).ok_or("unavailable")?;
    Ok(app.join("Contents").join("Resources"))
}

pub fn native_dir(resources: &Path) -> PathBuf {
    resources.join("native")
}

fn request(operation: &Operation, challenge: Option<String>) -> Result<Value, String> {
    let op = match operation {
        Operation::Capability => "capability",
        Operation::Ready => "ping",
        Operation::Create => "create",
        Operation::Confirm => {
            let value = challenge.as_deref().ok_or("malformed")?;
            if value.len() != 44
                || !value.ends_with('=')
                || !value[..43]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
            {
                return Err("malformed".into());
            }
            "confirm"
        }
    };
    // Requests use one connection each; no proof or request identity is persisted.
    Ok(
        json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "op": op, "challenge": challenge }),
    )
}

fn native_call(directory: &Path, request: &Value) -> Result<Value, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(
        directory
            .join("libRemoteCredentials.dylib")
            .as_os_str()
            .as_bytes(),
    )
    .map_err(|_| "unavailable")?;
    let mut input = serde_json::to_vec(request).map_err(|_| "malformed")?;
    if input.len() > 8192 {
        return Err("too_large".into());
    }
    let mut output = [0_u8; 8192];
    // Library validation enforces the signing team; NODELETE preserves Swift metadata between calls.
    let result = unsafe {
        let handle = libc::dlopen(
            path.as_ptr(),
            libc::RTLD_NOW | libc::RTLD_LOCAL | libc::RTLD_NODELETE,
        );
        if handle.is_null() {
            return Err("native_library_unavailable".into());
        }
        let symbol = libc::dlsym(handle, c"rb_remote_call_v1".as_ptr());
        if symbol.is_null() {
            libc::dlclose(handle);
            return Err("native_library_unavailable".into());
        }
        let call: unsafe extern "C" fn(*const u8, i32, *mut u8, i32) -> i32 =
            std::mem::transmute(symbol);
        let count = call(
            input.as_ptr(),
            input.len() as i32,
            output.as_mut_ptr(),
            8192,
        );
        libc::dlclose(handle);
        if !(1..=8192).contains(&count) {
            Err("unavailable".into())
        } else {
            serde_json::from_slice(&output[..count as usize]).map_err(|_| "malformed".into())
        }
    };
    input.fill(0);
    output.fill(0);
    result
}

fn start_helper(directory: &Path) -> Result<(), String> {
    let mut child = HELPER.lock().map_err(|_| "busy")?;
    if let Some(running) = child.as_mut() {
        if running.try_wait().map_err(|_| "unavailable")?.is_none() {
            return Ok(());
        }
    }
    let mut cmd = Command::new(directory.join("real-bot-runtime-helper"));
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    *child = Some(cmd.spawn().map_err(|_| "helper_unavailable")?);
    Ok(())
}

fn reply(value: Value, confirmation: bool) -> Result<LocalConfirmation, String> {
    if value["v"] != 1 || value["id"] != "00000000-0000-4000-8000-000000000005" {
        return Err("malformed".into());
    }
    let ok = value["ok"].as_bool().ok_or("malformed")?;
    let (proof, expires_in) = if ok && confirmation {
        let ttl = value["expiresIn"]
            .as_u64()
            .filter(|ttl| (1..=60).contains(ttl))
            .ok_or("malformed")?;
        let token = value["value"].as_str().ok_or("malformed")?;
        request(&Operation::Confirm, Some(token.to_owned()))?;
        (Some(token.to_owned()), Some(ttl))
    } else {
        (None, None)
    };
    Ok(LocalConfirmation {
        ok,
        enabled: false,
        diagnostic: if ok {
            "g_pack_not_verified".into()
        } else {
            value["error"].as_str().unwrap_or("unavailable").to_string()
        },
        proof,
        expires_in,
    })
}

fn after_ready(
    operation: &Operation,
    value: Value,
    call: impl FnOnce() -> Result<Value, String>,
) -> Result<LocalConfirmation, String> {
    if matches!(operation, Operation::Ready) {
        reply(value, false)
    } else {
        reply(call()?, matches!(operation, Operation::Confirm))
    }
}

/// `remote_native_confirmation({ operation, challenge })`. Blocks (on the helper, on Touch ID),
/// so the caller runs it off the engine thread.
pub fn confirmation(id: &Identity, operation: Operation, challenge: Option<String>) -> Result<LocalConfirmation, String> {
    authorize(id)?;
    let request = request(&operation, challenge.clone())?;
    let directory = native_dir(&resource_dir()?);
    // The shipped daemon keeps its challenges on the file credential store (ADR 0033).
    if let (Operation::Confirm, Some(challenge)) = (&operation, challenge.as_deref()) {
        let local = crate::local_confirm::confirm(challenge, crate::remote_setup::exchange, |reason| {
            crate::local_confirm::verify_owner(reason)
        });
        if let Some(local) = local {
            return Ok(local);
        }
    }
    let capability = native_call(
        &directory,
        &json!({
            "v": 1, "id": "00000000-0000-4000-8000-000000000005", "op": "capability"
        }),
    )?;
    if capability["ok"] != true || matches!(operation, Operation::Capability) {
        return reply(capability, false);
    }
    start_helper(&directory)?;
    // Probe readiness without replaying an authentication or uncertain mutation.
    let ping = json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "op": "ping" });
    for attempt in 0..20 {
        let value = native_call(&directory, &ping)?;
        if value["ok"] == true {
            return after_ready(&operation, value, || native_call(&directory, &request));
        }
        if value["error"] != "unavailable" || attempt == 19 {
            return reply(value, false);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err("helper_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_accepts_only_opaque_challenges_not_actions_or_credentials() {
        assert!(request(&Operation::Confirm, None).is_err());
        assert!(request(&Operation::Confirm, Some("../../keys".into())).is_err());
        let value = request(&Operation::Confirm, Some(format!("{}=", "A".repeat(43)))).unwrap();
        assert_eq!(value["op"], "confirm");
        assert!(value.get("action").is_none());
        assert!(serde_json::from_value::<Operation>(json!("read")).is_err());
        assert!(serde_json::from_value::<Operation>(json!("advance_highwater")).is_err());
    }

    #[test]
    fn capability_never_claims_packaging_gate_passed() {
        let value = reply(
            json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "ok": true }),
            false,
        )
        .unwrap();
        assert!(!value.enabled);
        assert_eq!(value.diagnostic, "g_pack_not_verified");
        assert!(reply(json!({ "v": 2 }), false).is_err());
    }

    #[test]
    fn confirmation_accepts_only_bounded_remaining_lifetime_and_a_proof() {
        let value = json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "ok": true,
            "value": format!("{}=", "A".repeat(43)), "expiresIn": 20 });
        for ttl in [1, 20, 59, 60] {
            let mut value = value.clone();
            value["expiresIn"] = json!(ttl);
            let response = reply(value, true).unwrap();
            assert!(response.proof.is_some());
            assert_eq!(response.expires_in, Some(ttl));
        }
        for ttl in [
            json!(0),
            json!(61),
            json!(-1),
            json!(0.5),
            json!("20"),
            Value::Null,
        ] {
            let mut value = value.clone();
            value["expiresIn"] = ttl;
            assert!(reply(value, true).is_err());
        }
        let mut malformed = value.clone();
        malformed["value"] = json!("fake");
        assert!(reply(malformed, true).is_err());
        assert!(reply(value.clone(), false).unwrap().proof.is_none());
        let mut rejected = value;
        rejected["ok"] = json!(false);
        rejected["error"] = json!("expired");
        assert!(reply(rejected, true).unwrap().proof.is_none());
    }

    #[test]
    fn ready_uses_first_authenticated_probe_without_repeating_it() {
        let ready = json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "ok": true });
        assert!(
            after_ready(&Operation::Ready, ready.clone(), || panic!("second ping"))
                .unwrap()
                .ok
        );
        let mut called = false;
        assert!(
            after_ready(&Operation::Create, ready.clone(), || {
                called = true;
                Ok(ready)
            })
            .unwrap()
            .ok
        );
        assert!(called);
    }

    fn dev() -> Identity {
        Identity { bundle_id: "com.real-bot.desktop.nsh-dev".into(), data_dir: "/tmp/dev".into(), port: 17990, version: "0.4.0" }
    }

    #[test]
    fn a_development_build_is_refused_before_anything_is_asked() {
        assert_eq!(authorize(&dev()), Err("disabled".to_string()));
        assert_eq!(confirmation(&dev(), Operation::Capability, None).unwrap_err(), "disabled");
        // Even a malformed confirm never reaches the request check.
        assert_eq!(confirmation(&dev(), Operation::Confirm, Some("x".into())).unwrap_err(), "disabled");
    }

    #[test]
    fn the_operation_names_are_the_tauri_ones() {
        for name in ["capability", "ready", "create", "confirm"] {
            assert!(serde_json::from_value::<Operation>(json!(name)).is_ok());
        }
        assert!(serde_json::from_value::<Operation>(json!("Confirm")).is_err());
    }

    #[test]
    fn the_confirmation_reaches_the_card_in_camel_case() {
        let value = serde_json::to_value(reply(json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "ok": true }), false).unwrap()).unwrap();
        assert_eq!(value, json!({ "ok": true, "enabled": false, "diagnostic": "g_pack_not_verified", "proof": null, "expiresIn": null }));
    }
    #[test]
    fn missing_bundle_is_unavailable_without_starting_any_process() {
        assert!(native_call(Path::new("/nonexistent/rc05-fixture"), &json!({})).is_err());
    }
}
