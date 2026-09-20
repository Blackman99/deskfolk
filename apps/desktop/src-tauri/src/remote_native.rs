use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct HelperState(pub Mutex<Option<Child>>);

impl HelperState {
    pub fn stop(&self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for HelperState {
    fn drop(&mut self) {
        self.stop();
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfirmation {
    pub ok: bool,
    pub enabled: bool,
    pub diagnostic: String,
    pub proof: Option<String>,
    pub expires_in: Option<u64>,
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

#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
fn native_call(_directory: &Path, _request: &Value) -> Result<Value, String> {
    Err("disabled".into())
}

fn start_helper(directory: &Path, state: &HelperState) -> Result<(), String> {
    let mut child = state.0.lock().map_err(|_| "busy")?;
    if let Some(running) = child.as_mut() {
        if running.try_wait().map_err(|_| "unavailable")?.is_none() {
            return Ok(());
        }
    }
    *child = Some(
        Command::new(directory.join("real-bot-runtime-helper"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "helper_unavailable")?,
    );
    Ok(())
}

fn reply(value: Value) -> Result<LocalConfirmation, String> {
    if value["v"] != 1 || value["id"] != "00000000-0000-4000-8000-000000000005" {
        return Err("malformed".into());
    }
    let ok = value["ok"].as_bool().ok_or("malformed")?;
    Ok(LocalConfirmation {
        ok,
        enabled: false,
        diagnostic: if ok {
            "g_pack_not_verified".into()
        } else {
            value["error"].as_str().unwrap_or("unavailable").to_string()
        },
        proof: if ok && value["expiresIn"] == 60 {
            value["value"].as_str().map(str::to_owned)
        } else {
            None
        },
        expires_in: value["expiresIn"].as_u64(),
    })
}

#[tauri::command]
pub async fn remote_native_confirmation(
    app: tauri::AppHandle,
    operation: Operation,
    challenge: Option<String>,
) -> Result<LocalConfirmation, String> {
    let request = request(&operation, challenge)?;
    let directory = native_dir(&app.path().resource_dir().map_err(|_| "unavailable")?);
    tauri::async_runtime::spawn_blocking(move || {
        let capability = native_call(
            &directory,
            &json!({
                "v": 1, "id": "00000000-0000-4000-8000-000000000005", "op": "capability"
            }),
        )?;
        if capability["ok"] != true || matches!(operation, Operation::Capability) {
            return reply(capability);
        }
        start_helper(&directory, &app.state::<HelperState>())?;
        // Probe readiness without replaying an authentication or uncertain mutation.
        let ping = json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "op": "ping" });
        for attempt in 0..20 {
            let value = native_call(&directory, &ping)?;
            if value["ok"] == true {
                return reply(native_call(&directory, &request)?);
            }
            if value["error"] != "unavailable" || attempt == 19 {
                return reply(value);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Err("helper_unavailable".into())
    })
    .await
    .map_err(|_| "unavailable".to_string())?
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
        let value =
            reply(json!({ "v": 1, "id": "00000000-0000-4000-8000-000000000005", "ok": true }))
                .unwrap();
        assert!(!value.enabled);
        assert_eq!(value.diagnostic, "g_pack_not_verified");
        assert!(reply(json!({ "v": 2 })).is_err());
    }

    #[test]
    fn missing_bundle_is_unavailable_without_starting_any_process() {
        assert!(native_call(Path::new("/nonexistent/rc05-fixture"), &json!({})).is_err());
    }
}
