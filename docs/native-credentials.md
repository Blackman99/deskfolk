# Native remote credentials (security prototype)

Remote control and standalone runtime remain **disabled**. This is the native interface for downstream pairing/runtime integration, not a passed release gate. G-pack is **not run**: no stable signing/provisioning credentials or clean isolated Mac were available. No production Keychain item, personal database or login job is used by automated tests.

## Supported macOS architecture

`apps/runtime-helper` builds on macOS 13+ with Swift 6. The GUI-launched Swift helper handles initial creation and fresh `LAContext.deviceOwnerAuthentication`. It is not a LaunchAgent and is not a background read proxy. The compiled daemon loads the sibling `libRemoteCredentials.dylib` through `bun:ffi`; the library calls Security.framework inside the daemon process. Tauri loads the same library for local confirmation, but has **no Keychain entitlement** and no read/write-key command.

The design draft's legacy `SecAccessRef`/designated-requirement ACL cannot be combined with the proposed attributes. The SDK's `SecItem.h` explicitly excludes `SecAccessRef` with `kSecAttrSynchronizable`, and documents `kSecUseDataProtectionKeychain` for access groups/accessibility without synchronization. We therefore use:

- `kSecUseDataProtectionKeychain = true`;
- `kSecAttrSynchronizable = false`;
- `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` on creation;
- dedicated `TEAMID.com.real-bot.remote` access group, granted **only** to helper and a qualified compiled daemon;
- fixed generic-password service `com.real-bot.remote.v1`, account `remote-materials-v1`.

There is no legacy ACL, unrestricted access, PATH Bun entitlement, sync, automatic unlock or `Bun.secrets` fallback. Shared data-protection access groups require valid signing/provisioning entitlement authorization; codesigning a plist alone does not prove authorization. The desktop must not receive this group. Signing authority can authorize other software to the group and is part of the trust boundary.

One versioned item contains independent CryptoKit-generated X25519 host DH, Ed25519 host signing, Ed25519 enrollment, P-256 VAPID private keys (each 32 bytes), and a nonzero uint32 trust-epoch high-water mark. Initial add never replaces an existing item. Reset atomically replaces the bundle and increments high-water; overflow is rejected. Read/update use an LA context with `interactionNotAllowed = true`: locked, missing, corrupt and entitlement failures remain distinct and never prompt a headless daemon. Native buffers are bounded; errors/logs contain codes, not keys. Swift/JS managed-memory copies cannot promise complete secret zeroization.

## Signing blocker: stock Bun is not a sealed principal

Stock `bun build --compile` supports `BUN_BE_BUN=1`, which runs arbitrary scripts under the compiled binary's signature. It must **not** be granted the shared Keychain group. Removing this variable in the normal launcher is insufficient: another same-user process could invoke the binary directly. `--no-compile-autoload-*` removes config/preload paths but does not remove that interpreter escape.

The native policy rejects a daemon unless its signed entitlements include `com.real-bot.remote.sealed-runtime-v1 = true`. This is a **release qualification assertion, not an OS protection and not a user enable switch**. The repository build deliberately never emits it or grants stock Bun the remote access group. Before a maintainer can sign that assertion, a reviewed runtime build must remove all arbitrary-code entrypoints (including `BUN_BE_BUN`, runtime/preload/inspect/environment/config injection), retain hardened-runtime library validation, and demonstrate negative tests. Merely adding the entitlement to stock Bun is unsafe and unsupported. This work does not ship a patched Bun runtime; that condition is a real G-pack blocker.

The code requires an Apple-anchored signature, exact component identifier and same 10-character Team ID, hardened runtime, no `get-task-allow`, no disabled library validation and no DYLD-environment entitlement. The helper additionally requires its sole Keychain group. Ad-hoc snapshots return `unsigned`; suitably signed but unsealed daemons return `runtime_unsealed`. No debug authentication bypass or automatically accepted source-development code exists. A real display-and-validation code fallback is not implemented, so source development fails closed.

## Local protocol v1

Socket: Darwin's per-user temp directory (`confstr(_CS_DARWIN_USER_TEMP_DIR)`), then `real-bot-remote-v1/helper.sock`; directory `0700`, socket `0600`, owner checked without following the final symlink. A held `helper.lock` serializes listener ownership and permits stale socket recovery. Native credential mutations use a separate nonblocking cross-process `credentials.lock`; busy means retry the **read/reconciliation**, not an uncertain mutation. Same-user filesystem interference can deny service; it cannot impersonate a signed peer.

Both directions authenticate `getpeereid` **and** `LOCAL_PEERTOKEN` → `SecCodeCopyGuestWithAttributes(kSecGuestAttributeAudit)` → exact code requirement. PID-only checks are not used. Requests/proofs are bound to the daemon audit token, including process lifetime. Socket authentication occurs before decoding. At most eight clients, 65-second I/O timeouts, one request per connection, a 4-byte unsigned big-endian length followed by UTF-8 JSON, maximum 8192 bytes. Unsupported versions and malformed/oversized requests fail closed.

Request: `{v:1,id:<UUID>,op,...}`. Response: `{v:1,id,ok:true,value?,expiresIn?}` or `{v:1,id,ok:false,error}`. Optional absent fields are omitted. `value` key material/token encoding is padded standard base64, **not** Noise wire encoding. No generic service/account/path/query/SQL argument exists.

| Operation | Principal | Fields/result |
|---|---|---|
| `capability` | daemon/desktop, local dylib | Signature availability only; never enables remote or attests G-pack. Does not access Keychain. |
| `read` | daemon, local dylib | `material`: `host_identity` (64 bytes, DH then signing), `enrollment` (32), `vapid` (32), `highwater` (4-byte big-endian). |
| `advance_highwater` | daemon, local dylib | `expected`, `next` uint32; compare current and require `next > expected`. No GUI/helper dependency. |
| `create` | desktop → helper | Fresh LA, add the initial bundle at epoch 1. Existing/locked/corrupt items are never overwritten. |
| `prepare` | daemon → helper | `action:{kind,digest,display}` → random 32-byte `challenge`, 120-second deadline; maximum 16 pending. |
| `confirm` | desktop → helper | `challenge` → fresh LA and a random 32-byte `proof`, at most 60 seconds and never beyond challenge deadline. |
| `consume` | original daemon → helper | Exact `action`, `challenge`, `proof`; deletes once, including expired proofs. |
| `reset` | original daemon → helper | Same proof fields, action kind `reset_identity`, `expected`; consumes proof then atomically rotates keys/increments epoch. |
| `ping` | desktop → helper | Readiness only; safe to retry. |

Action kinds: `pair_device`, `reset_identity`, `change_relay`, `change_workspace`. `digest` is 64 lowercase hex SHA-256 of the downstream canonical full action payload. `display` is bounded to 1024 UTF-8 bytes and rejects control/format characters. Pairing callers must include device name/type and the **full** signing-key fingerprint and bind every public key, device ID, relay and epoch into the digest. The helper displays the daemon-supplied action, never webview-supplied prose. LA uses a new context, zero reuse duration, a 60-second prompt timeout, console-user check and monotonic proof deadlines. Cancellation/unavailable Aqua/authentication/locked Keychain produce no proof. Restart loses pending proofs. No proof can authorize a different action or daemon process.

Library loading can additionally return `native_library_unavailable` (missing library or code-signature/library-validation rejection); no path or loader details are sent to clients. Errors: `disabled`, `unsigned`, `wrong_identity`, `wrong_user`, `entitlement`, `runtime_unsealed`, `locked`, `not_found`, `conflict`, `corrupt`, `storage`, `version`, `malformed`, `too_large`, `unavailable`, `busy`, `timeout`, `authentication`, `cancelled`, `expired`, `proof`, `rollback`. Errors are redacted; clients never convert failure into acceptance. No helper maintenance route is added to HTTP.

## Consumer interfaces and durability

- `apps/daemon/src/remote-native.ts` exports `remoteNative`, `RemoteNativeClient`, `RemoteNativeError`, `LocalAction`, `RemoteMaterial` and protocol transport types. `prepare` → Tauri `confirm` → `consume` is the local pairing bridge. Raw bytes have no dependency on a Noise package. The injectable client transport is for tests; the production singleton always loads the native library and has no fake-service selection flag.
- Tauri `remote_native_confirmation` accepts only `{operation:"capability"|"ready"|"create"|"confirm",challenge?}`. Its separate capability grants only the bundled local main window, not development/remote URLs. Call `ready` to start/authenticate the bundled helper before the daemon calls `prepare`; after `create`, it is already running. Native errors are explicit. It returns `{ok,enabled:false,diagnostic,proof,expiresIn}` (`proof` is non-null only for successful `confirm`). It cannot supply action descriptions or retrieve keys. Helper lifetime remains owned by the desktop, not launchd.
- `real-bot-daemon --remote-native-capability` prints a redacted diagnostic and exits **before** opening a DB or binding an HTTP port. Availability is always separate from enabling remote transport.
- For revoke-all/reset, stop remote admission, durably advance Keychain high-water, then commit the SQLite trust epoch/device revocation transaction. Keychain and SQLite are **not atomic**. On failed/unknown mutation, re-read high-water before any retry. If Keychain is ahead of DB, disable remote until adopting the high-water while marking all devices untrusted or completing a fresh local reset. Never roll Keychain back or restore lost keys automatically. Single-device revoke does not require a global epoch bump.

The file lock serializes this implementation across helper/daemon. The nonsecret high-water is also stored in `kSecAttrGeneric`: `SecItemUpdate` matches that expected revision inside securityd and updates it together with the bundle, so a same-UID attacker replacing a lock inode cannot turn a stale write into rollback. Reads verify revision and accessibility. The SDK documents attribute matching in `SecItemUpdate`; provisioned real-Keychain concurrent-update acceptance remains part of G-pack, not established by the mock. Only qualified signed binaries may write the group. Restoring the entire machine/Keychain together is not protected by a Secure Enclave monotonic counter; the high-water protects the specified database-backup rollback case.

## Build and safe verification

From a clean checkout on macOS with Node 22+, pnpm, Bun (build-time), Rust and Swift 6 Command Line Tools:

```sh
pnpm install --frozen-lockfile
pnpm --filter @real-bot/desktop build:native
swift build --package-path apps/runtime-helper
swift run --package-path apps/runtime-helper RemoteCoreTests
pnpm test
pnpm typecheck
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @real-bot/messenger build
pnpm --filter @real-bot/desktop tauri build
```

The Swift fixture suite is an executable test target so it runs on Command Line Tools installations without XCTest/full Xcode. It tests the real protocol/service with generated in-memory bytes and mocked authentication/storage; it does not launch the GUI helper, prompt a human or access Keychain. `swift test` is not this package's test command. Production products and test executable share no runtime fake-service switch.

Tauri's build hook bundles `native/real-bot-daemon`, `native/real-bot-runtime-helper` and `native/libRemoteCredentials.dylib`. It honors `TAURI_ENV_TARGET_TRIPLE` for arm64/x86_64, disables daemon config autoload, signs nested resources before the app, and does **not** grant remote credentials. Release launch uses the bundled executable, not PATH Bun; source launch requires debug builds or explicit `REAL_BOT_SOURCE_DAEMON=1`. `REAL_BOT_BUN`, `REAL_BOT_DAEMON_MAIN` and watch settings apply only to source launch. Removing Bun from a clean machine is still a G-pack experiment, not proven by a local compile.

See [signing requirements](notarization.md). Native credential acceptance must run under an isolated macOS test account/clean Mac with qualified signing and authorized access group. `REAL_BOT_DATA_DIR` does **not** isolate Keychain. Required remaining evidence: unauthorized same-UID/PATH Bun/other-team denial, provisioned access-group behavior, lock/cancel/no-Aqua failure, genuine fresh LA, daemon-only durable revoke/high-water and Noise handshake after killing desktop/helper, with no prompt and no installed Bun. No actual secrets should be generated in ordinary CI.
