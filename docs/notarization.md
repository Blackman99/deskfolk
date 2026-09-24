# Apple notarization / Developer ID path

Tracking: [issue #10](https://github.com/Blackman99/deskfolk/issues/10).  
Until this lands, installs follow the [Gatekeeper FAQ](gatekeeper.md).

## Goal

Ship macOS `.dmg` builds signed with **Developer ID Application** and **notarized** by Apple, so first launch no longer needs right-click → Open / `xattr`.

## Prerequisites (maintainer)

1. Apple Developer Program membership (paid).
2. Developer ID Application certificate in Keychain (or CI secret).
3. App-specific password or API key for `notarytool`.
4. Team ID and bundle ID aligned with `apps/desktop` / Tauri config.

## Build / CI checklist

- [ ] Export Developer ID cert + private key for CI (or use a Mac runner with the cert installed).
- [ ] Configure Tauri / cargo-bundle signing env (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` — exact names follow current Tauri docs).
- [ ] Sign the `.app` before packaging the `.dmg`.
- [ ] Submit with `xcrun notarytool submit … --wait`.
- [ ] Staple: `xcrun stapler staple "Deskfolk.app"` (or the `.dmg` as appropriate).
- [ ] Verify on a clean Mac: double-click opens without Gatekeeper bypass.
- [ ] Update [Gatekeeper FAQ](gatekeeper.md) when signed builds ship (remove “unsigned alpha” framing for those builds).
- [ ] Release notes must say **signed + notarized** only after staple succeeds — never a fake badge.

## Cost / ops notes

- Apple Developer Program annual fee.
- CI Mac minutes if using hosted macOS runners.
- Certificate rotation and expiry calendar.
- Keep unsigned snapshot channel only if needed for internal dogfood; public “Download alpha” should prefer notarized builds once available.

## Non-goals

- Claiming notarization before the staple step succeeds.
- Disabling Gatekeeper guidance while builds remain unsigned.

## Native remote-credential signing gate

The [native credential interface](native-credentials.md) uses macOS data-protection Keychain sharing, not a legacy ACL. Helper `com.real-bot.runtime-helper` and a **qualified sealed** daemon `com.real-bot.daemon` need the authorized `TEAMID.com.real-bot.remote` Keychain access group and appropriate application identifiers/provisioning. Desktop `com.real-bot.desktop` must **not** receive the group. All three require the same Apple-anchored stable Team ID, hardened runtime and library validation. Sign `libRemoteCredentials.dylib` with the same identity before signing the outer app. `com.real-bot.pty` is signed the same way but **must not** receive the Keychain access group: it opens a pty for a shell the person could start from Terminal.app, and holds nothing. Do not grant debugging, DYLD environment or disabled-library-validation entitlements.

The build hook currently signs nested binaries with `APPLE_SIGNING_IDENTITY` or ad-hoc `-`, and gives the daemon only JIT/executable-memory entitlements. It deliberately does not grant remote Keychain access. **Stock Bun's `BUN_BE_BUN=1` interpreter escape and `BUN_OPTIONS --preload/--config` paths make it unsafe as an entitled principal, even with automatic config loading disabled.** `com.real-bot.remote.sealed-runtime-v1` is a signed release qualification assertion checked by native code; it is not a protection provided by macOS and must never be added to stock Bun. A reviewed runtime without alternate arbitrary-code/preload/inspect entrypoints and negative tests is required before signing that assertion. Copying Bun's example entitlements that disable library validation is also incompatible with this boundary.

G-pack is **not run / blocked**, not passed: a buildable qualified sealed runtime is an outstanding implementation prerequisite; stable credentials/provisioning and a clean isolated Mac are also unavailable. A certificate or qualification-assertion entitlement alone cannot satisfy the runtime prerequisite. Before enabling remote/standalone, test genuine local authentication and Keychain sharing, same-UID malicious peers, locked/no-Aqua denial, helper/desktop termination followed by prompt-free daemon reads and durable revoke high-water updates, and a real handshake on a Mac with no installed Bun. Browser/unit tests cannot establish this gate. Only an isolated macOS account/namespace may create test credentials; a separate data directory alone is insufficient. Native failures remain explicit and disabled rather than invoking a development bypass.

## Status

**Unsigned alpha** is what GitHub Releases ship today (`v0.1.0-rc.1` and later until this checklist completes).
