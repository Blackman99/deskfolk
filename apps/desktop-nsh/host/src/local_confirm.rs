//! Local confirmation for remote access on the file credential store (ADR 0033), as the 0.4.0
//! app did it (`local_confirm.rs`).
//!
//! The daemon prepares every action and holds its challenge. The shell asks it over the remote
//! setup channel (`remote_setup.rs`) what the action is, shows that on the system's owner check
//! (a LocalAuthentication sheet on macOS, Windows Hello on Windows, ADR 0059), and only after the
//! person passes it asks for the proof. The app only ever sees the proof: it cannot send either
//! step (`remote_setup::validate`), and it never supplies the words on the sheet.

use serde::Serialize;
use serde_json::{json, Value};

/// What `remote_native_confirmation` answers.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfirmation {
    pub ok: bool,
    pub enabled: bool,
    pub diagnostic: String,
    pub proof: Option<String>,
    pub expires_in: Option<u64>,
}

/// The daemon's proof lives as long as its challenge; the page only needs it for the next call.
const PROOF_TTL: u64 = 60;

/// `None` when the daemon does not know this challenge on the file store: the sealed helper's.
pub fn confirm(
    challenge: &str,
    exchange: impl Fn(&Value) -> Result<Value, String>,
    verify: impl FnOnce(&str) -> Result<(), String>,
) -> Option<LocalConfirmation> {
    let shown = exchange(&json!({ "operation": "challenge_display", "challenge": challenge })).ok()?;
    if shown["ok"] != true {
        return None;
    }
    let reason = match reason(&shown["value"]) {
        Ok(reason) => reason,
        Err(code) => return Some(refused(code)),
    };
    if let Err(code) = verify(&reason) {
        return Some(refused(&code));
    }
    let issued = exchange(&json!({ "operation": "challenge_proof", "challenge": challenge }));
    let proof = issued
        .ok()
        .filter(|reply| reply["ok"] == true)
        .and_then(|reply| reply["value"]["proof"].as_str().map(str::to_owned));
    Some(match proof {
        Some(proof) if opaque(&proof) => LocalConfirmation {
            ok: true,
            enabled: false,
            diagnostic: "local_confirmation".into(),
            proof: Some(proof),
            expires_in: Some(PROOF_TTL),
        },
        // The challenge ran out while the sheet was up.
        _ => refused("expired"),
    })
}

fn refused(code: &str) -> LocalConfirmation {
    LocalConfirmation {
        ok: false,
        enabled: false,
        diagnostic: code.to_owned(),
        proof: None,
        expires_in: None,
    }
}

fn opaque(value: &str) -> bool {
    value.len() == 44
        && value.ends_with('=')
        && value[..43]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// macOS words it as "Deskfolk is trying to <reason>.", Windows as "Deskfolk wants to <reason>".
fn reason(value: &Value) -> Result<String, &'static str> {
    let display = value["display"].as_str().ok_or("malformed")?;
    if display.is_empty() || display.len() > 1024 || display.chars().any(char::is_control) {
        return Err("malformed");
    }
    let verb = match value["kind"].as_str().ok_or("malformed")? {
        "pair_device" => "pair a device for remote access",
        "remove_device" => "remove a remote device",
        "renew_first_uv" => "renew a remote device's verification",
        "recover_trust" => "reset remote trust",
        "reset_identity" => "reset this Mac's remote identity",
        "change_relay" => "change the remote relay",
        "change_workspace" => "change the remote workspace",
        _ => return Err("malformed"),
    };
    Ok(format!("{verb}: {display}"))
}

/// `remote_native_confirmation({ operation, challenge })` where there is no sealed helper (Windows,
/// Linux), as the 0.4.0 app answered it there: `confirm` goes to the owner check for a challenge the
/// file store holds, and everything else (and a development build) answers `disabled`. Blocks on
/// the daemon and the person, so the caller runs it off the engine thread.
#[cfg(not(target_os = "macos"))]
pub fn confirmation(dev: bool, operation: &str, challenge: Option<&str>) -> Result<LocalConfirmation, String> {
    if dev {
        return Err("disabled".into());
    }
    if operation == "confirm" {
        let challenge = challenge.filter(|value| opaque(value)).ok_or("malformed")?;
        if let Some(done) = confirm(challenge, crate::remote_setup::exchange, verify_owner) {
            return Ok(done);
        }
    } else if !matches!(operation, "capability" | "ready" | "create") {
        return Err("malformed".into());
    }
    Err("disabled".into())
}

/// Touch ID, or the login password where there is none, for this one action.
#[cfg(target_os = "macos")]
pub fn verify_owner(reason: &str) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::msg_send;
    use objc2_foundation::{NSError, NSString};
    use std::time::Duration;

    #[link(name = "LocalAuthentication", kind = "framework")]
    unsafe extern "C" {}

    /// `LAPolicyDeviceOwnerAuthentication`: biometrics, a watch, or the password.
    const DEVICE_OWNER_AUTHENTICATION: isize = 2;
    let class = AnyClass::get(c"LAContext").ok_or("unavailable")?;
    let context: Option<Retained<AnyObject>> = unsafe { msg_send![class, new] };
    let context = context.ok_or("unavailable")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
        let outcome = if success.as_bool() {
            Ok(())
        } else if error.is_null() {
            Err("authentication")
        } else {
            // LAError: userCancel -2, systemCancel -4, appCancel -9, authenticationFailed -1.
            match unsafe { (*error).code() } {
                -2 | -4 | -9 => Err("cancelled"),
                -1 => Err("authentication"),
                _ => Err("unavailable"),
            }
        };
        let _ = tx.send(outcome);
    });
    let reason = NSString::from_str(reason);
    unsafe {
        let _: () = msg_send![
            &*context,
            evaluatePolicy: DEVICE_OWNER_AUTHENTICATION,
            localizedReason: &*reason,
            reply: &*reply
        ];
    }
    // The daemon's challenge lasts 120 s; a sheet left open past that could not be used anyway.
    match rx.recv_timeout(Duration::from_secs(110)) {
        Ok(outcome) => outcome.map_err(str::to_owned),
        Err(_) => {
            unsafe {
                let _: () = msg_send![&*context, invalidate];
            }
            Err("timeout".into())
        }
    }
}

/// Windows Hello — a face, a fingerprint, or the PIN — for this one action, in front of the app's
/// window. Hello has to be set up for the account: Windows offers an app no sheet that takes the
/// account password instead, so without it this says `hello_not_configured`, and the card keeps its
/// approve button with a note.
#[cfg(windows)]
pub fn verify_owner(reason: &str) -> Result<(), String> {
    use std::time::{Duration, Instant};
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows::core::{HSTRING, factory};
    use windows_future::{AsyncStatus, IAsyncOperation};

    let availability = UserConsentVerifier::CheckAvailabilityAsync().and_then(|operation| operation.join()).map_err(|_| "unavailable")?;
    if availability == UserConsentVerifierAvailability::DeviceBusy {
        return Err("unavailable".into());
    }
    if availability != UserConsentVerifierAvailability::Available {
        return Err("hello_not_configured".into());
    }
    let message = HSTRING::from(format!("Deskfolk wants to {reason}"));
    // Parented to the window, the sheet comes up in front of it; without one (or on a Windows that
    // lacks the interop) it may open behind it, but it still opens.
    let parented = crate::win::nsh_window().and_then(|hwnd| {
        // SAFETY: the app's live window, found for this request.
        unsafe {
            factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .and_then(|interop| interop.RequestVerificationForWindowAsync::<IAsyncOperation<UserConsentVerificationResult>>(hwnd, &message))
                .ok()
        }
    });
    let operation = match parented {
        Some(operation) => operation,
        None => UserConsentVerifier::RequestVerificationAsync(&message).map_err(|_| "unavailable")?,
    };
    // The daemon's challenge lasts 120 s; a sheet left open past that could not be used anyway.
    let deadline = Instant::now() + Duration::from_secs(110);
    loop {
        match operation.Status().map_err(|_| "unavailable")? {
            AsyncStatus::Completed => break,
            AsyncStatus::Canceled => return Err("cancelled".into()),
            AsyncStatus::Started if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            AsyncStatus::Started => {
                let _ = operation.Cancel();
                return Err("timeout".into());
            }
            _ => return Err("unavailable".into()),
        }
    }
    let result = operation.GetResults().map_err(|_| "unavailable")?;
    if result == UserConsentVerificationResult::Verified {
        Ok(())
    } else if result == UserConsentVerificationResult::Canceled {
        Err("cancelled".into())
    } else if result == UserConsentVerificationResult::RetriesExhausted {
        Err("authentication".into())
    } else if result == UserConsentVerificationResult::DeviceBusy {
        Err("unavailable".into())
    } else {
        Err("hello_not_configured".into())
    }
}

/// The polkit action Deskfolk's package installs (`assets/linux/com.real-bot.desktop.policy`): the
/// person's own password, every time, in an active local session only.
#[cfg(target_os = "linux")]
pub const POLKIT_ACTION: &str = "com.real-bot.desktop.remote-confirm";

/// The owner check on Linux: polkit's authentication agent (the desktop's password prompt, or a
/// fingerprint where PAM has one) for `POLKIT_ACTION`, through `pkcheck`. polkit lets only a
/// privileged caller put its own words on that prompt, so the prompt says what the policy says and
/// the window shows which device or change it is about (ADR 0112). Waits as the other systems' sheets
/// do, 110 s at most.
#[cfg(target_os = "linux")]
pub fn verify_owner(reason: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    log::info!("asking polkit to approve: {reason}");
    let subject = polkit_subject().ok_or("unavailable")?;
    let mut child = match Command::new("pkcheck")
        .args(["--action-id", POLKIT_ACTION, "--process", &subject, "--allow-user-interaction"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        // No polkit on this system at all.
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => return Err("confirm_not_configured".into()),
        Err(_) => return Err("unavailable".into()),
    };
    let deadline = Instant::now() + Duration::from_secs(110);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timeout".into());
            }
            Err(_) => return Err("unavailable".into()),
        }
    };
    let mut said = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        use std::io::Read;
        let _ = stderr.read_to_string(&mut said);
    }
    match pkcheck_outcome(status.code(), &said) {
        Ok(()) => Ok(()),
        Err(code) => {
            log::info!("polkit did not approve ({code}): {}", said.trim());
            Err(code.into())
        }
    }
}

/// What `pkcheck`'s exit says (pkcheck(1)): 0 approved; 1 not approved (the password failed); 2 no
/// authentication agent to ask with; 3 the prompt was dismissed; 127 an error, such as an action
/// polkit does not know because the policy is not installed (an AppImage).
#[cfg(any(target_os = "linux", test))]
fn pkcheck_outcome(code: Option<i32>, stderr: &str) -> Result<(), &'static str> {
    match code {
        Some(0) => Ok(()),
        Some(1) => Err("authentication"),
        Some(2) => Err("confirm_agent_missing"),
        Some(3) => Err("cancelled"),
        _ if stderr.contains("not registered") || stderr.contains("No action with action id") => Err("confirm_not_configured"),
        _ => Err("unavailable"),
    }
}

/// This process for polkit, as `pid,start-time,uid`: the start time (field 22 of `/proc/self/stat`)
/// keeps a recycled pid from standing in for it.
#[cfg(target_os = "linux")]
fn polkit_subject() -> Option<String> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // The command name (field 2) is in parentheses and may hold spaces: count from after it.
    let after = &stat[stat.rfind(')')? + 2..];
    let start = after.split_whitespace().nth(19)?;
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    Some(format!("{},{start},{uid}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn challenge() -> String {
        format!("{}=", "A".repeat(43))
    }

    /// A daemon on the file store: answers both steps and records what the window asked.
    fn daemon(
        display: Value,
        proof: Value,
    ) -> (Rc<RefCell<Vec<String>>>, impl Fn(&Value) -> Result<Value, String>) {
        let asked = Rc::new(RefCell::new(Vec::new()));
        let log = asked.clone();
        let exchange = move |request: &Value| {
            log.borrow_mut()
                .push(request["operation"].as_str().unwrap().to_owned());
            Ok(match request["operation"].as_str() {
                Some("challenge_display") => display.clone(),
                _ => proof.clone(),
            })
        };
        (asked, exchange)
    }

    #[test]
    fn the_proof_is_asked_for_only_after_the_person_passed_the_sheet() {
        let proof = format!("{}=", "B".repeat(43));
        let (asked, exchange) = daemon(
            json!({ "ok": true, "value": { "kind": "pair_device", "display": "Pixel (Android) · beef" } }),
            json!({ "ok": true, "value": { "proof": proof } }),
        );
        let mut shown = String::new();
        let done = confirm(&challenge(), &exchange, |reason| {
            shown = reason.to_owned();
            Ok(())
        })
        .unwrap();
        assert!(done.ok);
        assert_eq!(done.proof.as_deref(), Some(proof.as_str()));
        assert_eq!(done.expires_in, Some(60));
        assert_eq!(shown, "pair a device for remote access: Pixel (Android) · beef");
        assert_eq!(*asked.borrow(), ["challenge_display", "challenge_proof"]);
    }

    #[test]
    fn a_declined_sheet_asks_for_nothing() {
        let (asked, exchange) = daemon(
            json!({ "ok": true, "value": { "kind": "remove_device", "display": "Pixel · beef" } }),
            json!({ "ok": true, "value": { "proof": challenge() } }),
        );
        let done = confirm(&challenge(), &exchange, |_| Err("cancelled".into())).unwrap();
        assert!(!done.ok);
        assert_eq!(done.diagnostic, "cancelled");
        assert!(done.proof.is_none());
        assert_eq!(*asked.borrow(), ["challenge_display"]);
    }

    #[test]
    fn a_challenge_the_file_store_does_not_hold_goes_to_the_sealed_helper() {
        let (_, exchange) = daemon(
            json!({ "ok": false, "error": "remote_setup_denied" }),
            json!({}),
        );
        assert!(confirm(&challenge(), &exchange, |_| panic!("no sheet")).is_none());
        assert!(confirm(
            &challenge(),
            |_| Err("desktop_channel_unavailable".into()),
            |_| panic!("no sheet")
        )
        .is_none());
    }

    #[test]
    fn the_sheet_only_shows_what_the_daemon_described_in_known_words() {
        for value in [
            json!({ "kind": "read_keys", "display": "x" }),
            json!({ "kind": "pair_device", "display": "" }),
            json!({ "kind": "pair_device", "display": "a\u{7}b" }),
            json!({ "kind": "pair_device", "display": "x".repeat(1025) }),
            json!({ "kind": "pair_device" }),
        ] {
            let (asked, exchange) = daemon(json!({ "ok": true, "value": value }), json!({}));
            let done = confirm(&challenge(), &exchange, |_| panic!("no sheet")).unwrap();
            assert_eq!(done.diagnostic, "malformed");
            assert_eq!(asked.borrow().len(), 1);
        }
    }

    /// The sheet itself needs a person; that the framework is linked and its class loads does not.
    #[cfg(target_os = "macos")]
    #[test]
    fn local_authentication_is_linked() {
        #[link(name = "LocalAuthentication", kind = "framework")]
        unsafe extern "C" {}
        assert!(objc2::runtime::AnyClass::get(c"LAContext").is_some());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn without_a_helper_only_a_confirm_reaches_the_owner_check() {
        assert_eq!(confirmation(true, "confirm", Some(&challenge())).unwrap_err(), "disabled");
        assert_eq!(confirmation(false, "capability", None).unwrap_err(), "disabled");
        assert_eq!(confirmation(false, "confirm", Some("short")).unwrap_err(), "malformed");
        assert_eq!(confirmation(false, "read_keys", None).unwrap_err(), "malformed");
        // No channel: the daemon cannot describe the challenge, so there is no sheet either.
        assert_eq!(confirmation(false, "confirm", Some(&challenge())).unwrap_err(), "disabled");
    }

    #[test]
    fn what_pkcheck_says_reads_as_the_other_systems_codes() {
        assert_eq!(pkcheck_outcome(Some(0), ""), Ok(()));
        assert_eq!(pkcheck_outcome(Some(1), ""), Err("authentication"));
        assert_eq!(pkcheck_outcome(Some(2), ""), Err("confirm_agent_missing"));
        assert_eq!(pkcheck_outcome(Some(3), ""), Err("cancelled"));
        assert_eq!(pkcheck_outcome(Some(127), "Error checking for authorization com.x: GDBus.Error:org.freedesktop.PolicyKit1.Error.Failed: Action com.x is not registered"), Err("confirm_not_configured"));
        assert_eq!(pkcheck_outcome(Some(127), "something else"), Err("unavailable"));
        assert_eq!(pkcheck_outcome(None, ""), Err("unavailable"));
    }

    #[test]
    fn a_challenge_that_ran_out_under_the_sheet_is_expired() {
        let (_, exchange) = daemon(
            json!({ "ok": true, "value": { "kind": "pair_device", "display": "Pixel · beef" } }),
            json!({ "ok": false, "error": "remote_setup_denied" }),
        );
        let done = confirm(&challenge(), &exchange, |_| Ok(())).unwrap();
        assert!(!done.ok);
        assert_eq!(done.diagnostic, "expired");
    }
}
