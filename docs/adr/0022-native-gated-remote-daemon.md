# ADR 0022: Native-gated outbound remote daemon and shared draining

Status: experimental implementation; production activation blocked. Date: 2026-09-20.

## Decision

Remote connections use the same Store, receipt transactions, event barrier and turn engine as local HTTP. An authenticated host-control relay connection creates a distinct outbound host link per device; only real Noise Split principals can reach the business allowlist. `/remote/*` is encrypted-only, not a new local bearer or Bot control plane. Local loopback/Origin behavior and window supervision remain unchanged.

Native material is read through the reviewed native client. Source/stock compiled Bun cannot qualify as a sealed credential principal, so unavailable native capability disables remote without breaking local startup. Tests inject the real client transport only through construction. There is no environment fake, production key file, mock UV, entitlement override or architecture pivot.

Local setup uses an inherited anonymous socketpair plus the native audit-token/signed-desktop peer check. Tauri enforces the actual bundled main frame independently. The window cannot supply action prose or retrieve long-term keys; daemon prepares the complete action digest, native confirmation performs fresh presence, and the daemon consumes that same proof before durable trust.

Every revoke advances the Keychain high-water before the SQLite generation transaction. This corrects the draft's single-device exception: an old revoked row could otherwise be restored at the same high-water. Surviving devices retain their signed grant epoch but advance their database generation; all sessions close and reconnect with current trust. Keychain-ahead mismatches fail closed rather than silently adopting old authorization. Durable dual IK replay reservations refuse capacity and survive daemon restart.

Fresh UV uses the shared WebAuthn verifier. Registration persists COSE/version/counter; first registration requires short-lived, locally approved and Split-bound pair permission. Replacement requires existing-credential UV bound to the exact staged response. Challenge consumption and credential/time/session/trust CAS are synchronous transactions. Accepted external operations cannot be undone by disconnect.

Shared quiesce pauses new user turns, routines, membership/delegation and child admission while existing turns may receive approvals/answers. The live set is captured at entry; no timeout or disconnect escalates to force. Explicit force aborts and records interruptions, never exits. The caller owns supervision and stop-latch writes; no launchd job is introduced here.

## Review corrections

Recovery at an equal native/DB generation also advances native high-water before revoking. Native-confirmed reset and relay migration now have durable native-uncertain/native-done intents; only matching native-done pins/epoch reconcile, while unknown native outcomes require fresh local recovery. Workspace changes bind canonical directory identity and settings revision. First UV renewal requires new Mac proof bound to the current live Split session and credential absence.

The outbound sender shares a paced host budget across data and control, and acknowledged revocation tombstones are not replayed on every reconnect. File stream lifetime ends at sent EOF/cancellation, not enqueue. Remote route body/query schemas reject unknown fields before effects, retain stable redacted error codes and explicitly classify model probing as non-replayed with cancellation after credential waits.

Quiesce captures both DB-live and engine-unsettled work. Force fences later batch tools and post-await effects but cannot claim started work has settled. Routine configuration can finish during drain without firing. Lifecycle authorization persists pending intents first; success is finalized after effects, and restart records unknown rather than replaying tools or claiming volatile state survived.

## Consequences and remaining gates

The shared grant reply codec has direction-specific AEAD associated data and verifies QR-pinned signatures and every expected field. RPC and file data stay bounded; no arbitrary HTTP proxy or plaintext application control is introduced. The public client must subscribe before snapshot, respect sequence watermarks, explicitly query unknown receipts and never auto-replay commands.

This ticket is not PWA, deployment, sealed-runtime or external security acceptance. Ticket 09 added host directory browse and duplex file streams. Ticket 11 consumes this shared drain for remote restart/stop without reimplementing admission. Window-supervised restart is the default; missing window plus no independent runtime remains unavailable. Physical UV and sealed-runtime gates stay unpassed. Standalone launchd, push and independent audit remain separate. Local generated-key/socket/SQLite tests do not prove human UV, Keychain access-group provisioning, Docker/domain TLS, real TCC prompts or independent audit.
