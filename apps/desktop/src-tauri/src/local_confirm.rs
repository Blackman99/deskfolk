//! Local confirmation for remote access on the file credential store (ADR 0033).
//!
//! The daemon prepares every action and holds its challenge. The window asks it over the inherited
//! channel what the action is, shows that on a LocalAuthentication sheet, and only after the person
//! passes it asks for the proof. The webview only ever sees the proof: it cannot send either step
//! (`remote_setup::validate`), and it never supplies the words on the sheet.

use serde_json::{json, Value};

use super::remote_native::LocalConfirmation;

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

/// macOS words it as "Deskfolk is trying to <reason>."
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
    extern "C" {}

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

#[cfg(not(target_os = "macos"))]
pub fn verify_owner(_reason: &str) -> Result<(), String> {
    Err("unavailable".into())
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
        extern "C" {}
        assert!(objc2::runtime::AnyClass::get(c"LAContext").is_some());
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
