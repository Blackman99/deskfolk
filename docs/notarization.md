# Apple notarization / Developer ID path

Tracking: [issue #10](https://github.com/Blackman99/real-bot/issues/10).  
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
- [ ] Staple: `xcrun stapler staple "Real Bot.app"` (or the `.dmg` as appropriate).
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

## Status

**Unsigned alpha** is what GitHub Releases ship today (`v0.1.0-rc.1` and later until this checklist completes).
