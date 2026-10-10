# Apple notarization / Developer ID path

Tracking: [issue #10](https://github.com/Blackman99/deskfolk/issues/10).  
Builds before 0.1.0-rc.16 were not notarized; their installs follow the [Gatekeeper FAQ](gatekeeper.md).

## Goal

Ship macOS `.dmg` builds signed with **Developer ID Application** and **notarized** by Apple, so first launch no longer needs right-click → Open / `xattr`.

## Prerequisites (maintainer)

1. Apple Developer Program membership (paid).
2. Developer ID Application certificate in Keychain (or CI secret).
3. App-specific password or API key for `notarytool`.
4. Team ID and bundle ID aligned with `apps/desktop` / Tauri config.

## Build / CI checklist

- [x] CI imports the Developer ID certificate from repository secrets into a throwaway keychain before the build (`release.yml`, step "Developer ID signing (when configured)"). It has to come before the build: `build-native.ts` signs the bundled daemon, pty and helper before Tauri would import a certificate itself.
- [x] `APPLE_SIGNING_IDENTITY` is exported only when the secret exists; Tauri reads it ahead of `signingIdentity: "-"` in `tauri.conf.json`, and `build-native.ts` signs the nested binaries with it plus `--timestamp` (notarization rejects Developer ID signatures without a secure timestamp).
- [x] Notarize and staple: Tauri does both for the `.app` when `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` are exported. With the certificate but without all three, the run signs, skips notarization and leaves a warning.
- [x] Add the repository secrets below (maintainer, 2026-10-10).
- [x] A local Developer ID build was notarized (`Accepted` on the first submission) and stapled on 2026-10-10; `spctl -a -vv` says `source=Notarized Developer ID` for the `.dmg`, the `.app`, and the `.app` mounted from a quarantined copy of the `.dmg`.
- [ ] Verify the CI-built release on a clean Mac: double-click opens without Gatekeeper bypass.
- [x] [Gatekeeper FAQ](gatekeeper.md) says builds from 0.1.0-rc.16 are notarized; its bypass steps are kept for older builds.
- [x] Release notes say **signed + notarized** only when `release.yml` notarizes: `MACOS_NOTARIZED` is `true` only with the certificate and all three notary secrets, and a failed notarization fails the macOS job, so nothing ships under the note un-notarized.

## Repository secrets

Set each with `gh secret set <NAME> -R Blackman99/deskfolk`. Without `APPLE_SIGNING_IDENTITY` the release stays ad-hoc signed and exports nothing.

| Secret | Value |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | The certificate's full name, as `security find-identity -v -p codesigning` prints it: `Developer ID Application: <Name> (<TEAMID>)` |
| `APPLE_CERTIFICATE` | The certificate **and its private key** exported from Keychain Access as `.p12`, then `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen for that `.p12` export |
| `APPLE_ID` | The Apple Account email of the developer team member |
| `APPLE_PASSWORD` | An app-specific password for that account (account.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | The 10-character Team ID |

## Keychain prompts after an update

An ad-hoc signed daemon has no Team ID, so the Keychain knows it only by its `cdhash`, which changes with every build: each update is a new program that has to be allowed again, with the login password. Since [ADR 0034](adr/0034-one-keychain-entry-on-macos.md) all credentials sit in one entry, so that is one prompt per update rather than one per endpoint and MCP server. A Developer ID build is recorded as `teamid:<TEAMID>` instead, and later updates read the entry without asking; the first Developer ID version still asks once, because the entry was last allowed for an ad-hoc build.

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

From **0.1.0-rc.16**, GitHub Releases ship macOS builds signed with Developer ID and notarized by Apple. `v0.1.0-rc.1` through `v0.1.0-rc.15` were ad-hoc signed and not notarized. The Windows installer is still unsigned.
