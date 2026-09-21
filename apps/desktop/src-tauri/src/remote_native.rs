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

pub struct BundledNativeCaller;

fn authorize_document(
    label: &str,
    url: &tauri::Url,
    development: bool,
    local_acl: bool,
) -> Result<(), String> {
    if development {
        return Err("disabled".into());
    }
    if !local_acl
        || label != "main"
        || url.scheme() != "tauri"
        || url.host_str() != Some("localhost")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/" | "/index.html")
    {
        return Err("forbidden_origin".into());
    }
    Ok(())
}

impl BundledNativeCaller {
    pub(crate) fn from_item<R: tauri::Runtime>(
        command: tauri::ipc::CommandItem<'_, R>,
        development: bool,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let webview = command.message.webview_ref();
        // Tauri resolves this ACL from the sending frame, not renderer-provided headers or arguments.
        let local_acl = command.acl.as_ref().is_some_and(|acl| {
            acl.iter()
                .any(|entry| matches!(entry.context, tauri::utils::acl::ExecutionContext::Local))
        });
        authorize_document(webview.label(), &webview.url()?, development, local_acl)?;
        Ok(Self)
    }
}

impl<'a, R: tauri::Runtime> tauri::ipc::CommandArg<'a, R> for BundledNativeCaller {
    fn from_command(
        command: tauri::ipc::CommandItem<'a, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        Self::from_item(command, cfg!(debug_assertions) || tauri::is_dev())
    }
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

#[tauri::command]
pub async fn remote_native_confirmation<R: tauri::Runtime>(
    _caller: BundledNativeCaller,
    app: tauri::AppHandle<R>,
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
            return reply(capability, false);
        }
        start_helper(&directory, &app.state::<HelperState>())?;
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

    #[test]
    fn bundled_document_policy_rejects_dev_remote_blob_and_other_windows() {
        for url in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html?s=fixture#chat",
        ] {
            assert!(authorize_document("main", &url.parse().unwrap(), false, true).is_ok());
            assert_eq!(
                authorize_document("main", &url.parse().unwrap(), true, true),
                Err("disabled".into())
            );
            assert!(authorize_document("main", &url.parse().unwrap(), false, false).is_err());
            assert!(authorize_document("other", &url.parse().unwrap(), false, true).is_err());
        }
        for url in [
            "http://localhost:5173/",
            "https://evil.example/",
            "blob:tauri://localhost/fixture",
            "about:srcdoc",
            "data:text/html,fixture",
            "tauri://localhost/preview.html",
            "tauri://evil/",
            "tauri://user@localhost/",
        ] {
            assert!(
                authorize_document("main", &url.parse().unwrap(), false, true).is_err(),
                "{url}"
            );
        }
    }

    struct ReleaseFixtureCaller;
    impl<'a, R: tauri::Runtime> tauri::ipc::CommandArg<'a, R> for ReleaseFixtureCaller {
        fn from_command(
            command: tauri::ipc::CommandItem<'a, R>,
        ) -> Result<Self, tauri::ipc::InvokeError> {
            BundledNativeCaller::from_item(command, false).map(|_| Self)
        }
    }

    #[tauri::command]
    fn release_origin_fixture(_caller: ReleaseFixtureCaller) -> &'static str {
        "bundled"
    }

    #[tauri::command]
    fn debug_origin_fixture(_caller: BundledNativeCaller) -> &'static str {
        "must not run"
    }

    #[test]
    fn actual_tauri_ipc_uses_frame_acl_and_command_document_guard() {
        use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
        let mut context = crate::app_context();
        context.config_mut().app.windows.clear();
        // Keep the real devUrl and generated application ACL; only the fixture commands are added.
        for command in ["release_origin_fixture", "debug_origin_fixture"] {
            context
                .runtime_authority_mut()
                .__allow_command(command.into(), tauri::utils::acl::ExecutionContext::Local);
        }
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                release_origin_fixture,
                debug_origin_fixture,
                remote_native_confirmation
            ])
            .build(context)
            .unwrap();
        let bundled = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("tauri://localhost/index.html".parse().unwrap()),
        )
        .build()
        .unwrap();
        let invoke = |command: &str, frame: &str| {
            get_ipc_response(
                &bundled,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: frame.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(json!({"operation":"ready"})),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
        };
        assert!(invoke("release_origin_fixture", "tauri://localhost/index.html").is_ok());
        assert!(invoke("debug_origin_fixture", "tauri://localhost/index.html").is_err());
        for frame in [
            "blob:tauri://localhost/fixture",
            "about:srcdoc",
            "https://evil.example/",
        ] {
            assert!(invoke("release_origin_fixture", frame).is_err(), "{frame}");
        }
        bundled
            .navigate("http://localhost:5173/".parse().unwrap())
            .unwrap();
        assert!(invoke("release_origin_fixture", "http://localhost:5173/").is_err());
        assert!(invoke("debug_origin_fixture", "http://localhost:5173/").is_err());
        assert_eq!(
            invoke("remote_native_confirmation", "http://localhost:5173/").unwrap_err(),
            json!("disabled")
        );
        for operation in ["capability", "ready", "create", "confirm"] {
            let denied = get_ipc_response(
                &bundled,
                tauri::webview::InvokeRequest {
                    cmd: "remote_native_confirmation".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://localhost:5173/".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(json!({"operation":operation})),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            );
            assert_eq!(denied.unwrap_err(), json!("disabled"));
        }
    }

    #[test]
    fn missing_bundle_is_unavailable_without_starting_any_process() {
        assert!(native_call(Path::new("/nonexistent/rc05-fixture"), &json!({})).is_err());
    }
}
