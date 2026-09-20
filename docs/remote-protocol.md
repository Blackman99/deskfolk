# Experimental remote cryptography contract / 实验性远控密码契约

Status: **proposed, default-off security prototype**. `@real-bot/remote` exports `REMOTE_DEFAULT_ENABLED = false`; it opens no sockets and enables no application feature. Relay, daemon and client integrations must keep their own remote/public-pairing admission closed until release gates pass. A constant is not a security boundary or a substitute for those admission checks.

## Implementation and gates

One implementation: the restricted standard `Noise_IK_25519_ChaChaPoly_BLAKE2s` state machine in `src/noise.ts`, over exactly pinned `@noble/{ciphers,curves,hashes}` 2.4.0. No alternate suite, homemade transport KDF, plaintext fallback, or WebCrypto X25519 dependency. Noble libraries have independent audit history (curves 2.3.0 / 1.6.0, ciphers 1.0.0, hashes 1.0.0); **these exact dependency versions and this integration are not independently audited**. JavaScript JIT/GC provides neither guaranteed constant time nor reliable whole-process secret erasure. `destroy()` overwrites owned key buffers, not all engine copies. CBOR uses pinned `cborg` 4.3.2 with duplicate-key rejection, bounded input, definite lengths and strict decoding; RSA verification uses platform WebCrypto.

| Gate | Automated evidence | Still required |
| --- | --- | --- |
| L1 | Official Noise wiki's Cacophony **and** noise-c IK vectors; two real Rust snow 0.10.0 peers exercise both roles, this prologue, signed Hellos, and 1 MiB duplex transport. | iOS 16.4+ installed PWA bundle/time budget on physical hardware. Desktop Chromium smoke is not this gate. |
| S1 | Wrong roles, altered prologue, pinned DH/signing keys, AEAD, expiry, replay, revocation callback, version, nonce ordering, frame bounds, all pre-Split transport types fail closed. | Daemon/relay integration must implement atomic replay/trust callbacks and connection teardown. |
| S-rev | Not passed. Protocol tests and AI review are not an audit. | Independent review of actual integration and pairing before public default-on. |
| G-uv | Generated software-key ES256/Ed25519/RSA positive and negative signature tests. | Real iOS home-screen and Android Chrome create/get; no supported-OS claim yet. |

No Keychain, personal DB, authenticator, model endpoint, push service or external device is used by this package's fixtures. Fixed test seeds and official vector private keys are public **test material**, never production identities. Fixture source commits, SHA-256 and licenses are in `test/fixtures/provenance.json` and `THIRD_PARTY_NOTICES.md`.

## Exports and transport ownership

Import from `@real-bot/remote`; receipt-only consumers can use `@real-bot/remote/canonical` without pulling in Noise/WebAuthn. Raw `NoiseIK`/`CipherState` are internal (no package subpath export); applications use `DeviceSession` / `HostSession`. Source has no Node-only imports or I/O. `build` emits ESM JS plus declarations; consumers in this monorepo use TypeScript exports.

- `generateIdentity`, `identityPublic`: independent random 32-byte X25519 DH, Ed25519 identity and Ed25519 enrollment secrets. Never convert Ed25519 to DH or reuse key seeds.
- `encodePrologue(SessionBinding)`: u16 UTF-8 byte-length fields `RB-REMOTE-v1`, host ULID, device ULID; u32be trust epoch; u16be version **1**; exact canonical HTTPS origin (no trailing slash). Version mismatch is fatal.
- `DeviceSession.start()` returns the **208-byte** message 1. `HostSession.accept(message1)` authenticates static DH and signing identities, calls trust/replay hooks, then returns the **144-byte** message 2. `DeviceSession.accept(message2)` authenticates the pinned host signature before exposing transport. Message 1 includes random session ID; Hello signatures bind the respective ephemeral key and the prologue, and responder signature binds Noise's actual message-1 `h`.
- `send(type, body)` / `receive(ciphertext)` require authenticated Split. Any failure destroys that session; close the underlying socket. One WS binary frame is exactly one Noise message. No caller-controlled transport nonce: independent directional counters begin at 0, encoded as Noise's 32 zero bits + u64le, with the all-ones nonce forbidden. Application u64be seq must equal the receive counter, and session ID must match. Type 7 closes both local cipher states.
- Host `isTrusted()` must read current non-revoked device, current trust epoch **and** pinned key validity; it is called on handshake and every send/receive. Host must proactively close sessions when revoking, not wait for traffic.
- Host `claimReplay({deviceId, ephemeralPublic, sessionId, minimumTtlMs})` must atomically reserve **both** `(deviceId,e_pk)` and `sessionId` across all handshakes, before returning `true`. TTL ≥ max(120s, 2× recent RTT). Full cache refuses admission; never evict live entries to admit a replay. Clock/TTL, bounded storage and teardown belong to host, not this pure library. Rejected/replayed message 1 produces no response or second Principal. Relay enrollment nonces do not replace this cache. Replay reservations must survive any process/reconnect boundary for which the host claims replay protection; alternatively close remote admission until that window elapses after losing the cache.

Example call order (host persistence/transport functions are application-owned, not package implementations):

1. Create device with paired host keys and host with the stored device keys plus mandatory trust and replay callbacks.
2. Send `device.start()` as one WS message; send the result of `host.accept(message1)` as the response.
3. Call `device.accept(message2)`; only now call `send` / `receive` and dispatch returned frames. A host may send after producing its authenticated response; it must queue it in order after that response.
4. On disconnect/exception call `close()`, drop in-flight commands, reconnect with fresh state, and consult durable receipts. Never dispatch Hello payloads or queue offline approvals.

## Byte codecs and limits

`encodeFrame` / `decodeFrame`: `session_id:16 || seq:u64be || type:u8 || body`. **Total plaintext ≤32768 bytes**, so `MAX_BODY=32743`; encrypted maximum here is 32784, below Noise's 65535. This intentionally resolves the draft's contradictory body-vs-total wording in favor of the stricter total. Unknown/reserved types fail.

Types: 1 request, 2 response, 3 event, 4 fragment, 5 file, 6 stream cancellation (exact u32be ID), 7 close (empty), 8 snapshot. Logical JSON parsing/schema validation remains adapter-owned.

`fragmentMessage(type,bytes)` emits direct or fragmented messages for original types 1/2/3/8. Fragment body: original type:u8, message ID:16, index:u32be, count:u32be, chunk. Chunk ≤32718; non-final chunks have that exact size; logical message ≤1 MiB (maximum 33 fragments). `Reassembler.accept(body, monotonicNowMs)` permits one contiguous bounded message per instance, no interleaving, duplicate, gap, count/type/ID changes or >30s assembly. Hosts schedule `expire(nowMs)` to release idle buffers at 30s and `clear()` on disconnect; subsequent partial messages cannot resume. Larger snapshots require pagination, not larger frames.

`encodeFileChunk` / `decodeFileChunk`: stream ID:u32be, offset:u64be, flags:u8, chunk ≤32730. Only EOF bit 0 allowed. File permissions, realpath/symlink checks, ETag, sequential offset, 50 MiB transfer limit, 1 MB text PUT, two streams/device, cancellation state and backpressure are **file-adapter responsibilities**, not granted by successful decryption.

## Pairing, grant and relay admission

- `sealPairing` / `openPairing`: random 24-byte nonce prefix, XChaCha20-Poly1305, key = keyed BLAKE2s-256(secret, UTF-8 `rb-pair-v1`), never BLAKE2b/personalization. Use 32 random secret bytes; minimum accepted is 16. AD = u16-length pairing ULID, host ULID, expires:u64be. Host supplies authoritative pending context/time; expired or >10-minute future window fails. JCS plaintext has exactly `device_id,name,ua_hint,device_e_pk,device_s_pk,enrollment_pk`; canonical unpadded base64url keys are exactly 32 bytes. Confirm name and full SHA-256 signing-key fingerprint locally before signing a grant. Pair expiry/one-use consumption and Mac user presence remain host-owned.
- `encodeGrant` / `decodeGrant` / `signGrant` / `verifyGrant`: length-prefixed `RB-GRANT-v1` is **11 UTF-8 bytes** (`000b52422d4752414e542d7631`), not 10. Then host/device ULIDs, signing/DH/enrollment public keys (32 each), epoch:u32be, version:u16be, origin field, issued:u64be. `verifyGrant` compares every field with the expected pending pair before verifying Ed25519; callers must use the QR-pinned host signing key. No arbitrary grant acceptance by credential ID.
- `encodeEnrollmentProof` / `signEnrollmentProof` / `verifyEnrollmentProof`: role/id length fields, raw nonce_c/nonce_s (16 each), timestamp:u64be, relay ID field. Role host/device only. Relay looks up the **stored enrollment key**, not a key submitted with the proof. Relay supplies its stored issued challenge; verifies <10s and consumes the exact challenge atomically via mandatory callback. Successful enrollment authorizes a relay slot, not business RPC. Bound text-frame limits before parsing, forbid text after EnrollOk, and close on wrong phase/opcode.

### Unregistered pairing mailbox: no enrollment deadlock

`PAIR_MAILBOX_CONTRACT` fixes `/v1/pair/mailbox`, 64 KiB encrypted envelope, 600s lifetime, **no device enrollment prerequisite and no business traffic**. Authenticated host opens one bounded, locally authorized pending-pair mailbox. Unregistered device POSTs/polls using pairing ID in a bounded request **body**, never a URL/query; mailbox carries the XChaCha envelope only, no pairing secret, device private key, WebAuthn registration or control traffic. Relay must rate-limit guessing and cap slots/bytes/TTL; ID knowledge alone cannot create host mailboxes or bypass host confirmation. The QR secret stays device↔Mac out-of-band and must never be navigated as a URL or logged.

After local confirmation the host durably grants trust, installs device enrollment public key through its authenticated relay management channel, and sends the signed grant through the mailbox (implementations should wrap replies under pairing AEAD). Grant polling cannot require the not-yet-received device grant. Device verifies the QR-pinned signature and every expected field; **then** it can pass the normal enrollment handshake and Noise IK. Host cancels/consumes the pending pair atomically and removes the mailbox. New devices cannot reach business or UV APIs before Split.

## Canonical hashes / ticket 02 compatibility

`canonicalize`, `canonicalBytes`, `canonicalHash` implement RFC8785 using ECMAScript finite-number formatting and UTF-16 key sorting. Reject lone surrogates, undefined, nonfinite numbers, bigint, accessors, exotic objects, sparse/decorated arrays, cycles and >64 nesting. Inputs must already be parsed/validated JSON (duplicate member rejection at raw ingress belongs to parsers). Hash = lowercase SHA-256 hex of canonical UTF-8.

`requestDigestBytes({method,path,body,encoding,files})` defines the exact receipt preimage:

`method || 0x1f || path || 0x1f || JCS(body) || 0x1f || encoding || 0x1f || sortedFiles`

`encoding` is `json` or `multipart`; sortedFiles consists of `filename || 0x1e || lowercase_sha256`, sorted by filename **UTF-8 bytes**, joined with 0x1f. JSON forbids file digests; duplicate filenames/control separators/malformed hex fail. Example without files: `POST␟/v1/messages␟{"a":1,"b":2}␟json␟`. `requestDigest` hashes that preimage with SHA-256; the example digest is `8acd54c455bc4a28ce1ec8aa9f0fa985df470a966fa211bb7cf44543659ab119`. This explicitly adds an encoding field to the draft, because otherwise JSON and empty multipart collide despite its requirement to distinguish them. Ticket 02 and both adapters must use this exact export; no backwards compatibility with an unpublished preimage is claimed. Bind authoritative method/path and all execution-changing parameters (including preconditions/revisions) in the supplied body/digest; hashing does not validate authorization.

## WebAuthn verification and host transactions

Algorithms are deliberately allowlisted: COSE EC2/P-256/ES256 (-7, DER signatures including valid high-S), OKP/Ed25519/EdDSA (-8), RSA 2048–4096/RS256 (-257). Reject mismatched curves/types, private or unexpected key fields, malformed points, duplicate CBOR fields, and invalid RSA exponents/moduli. No algorithm fallback. `verifyCredentialSignature` verifies authenticator bytes, not a credential ID.

`createUvChallenge(binding,kind,nowUnix)` uses random nonce and SHA-256 of domain-separated JCS. Binding contains **deviceId, sessionId, trustEpoch, requestId, action, targetId, operationDigest**. The host stores this record; TTL exactly 60s. `operationDigest` must be computed from the authoritative complete operation, not supplied unchecked by the client. This strengthens the draft's action/target-only binding: e.g. `force:false` UV cannot authorize `force:true` or different registration material. The challenge must be issued and used only in authenticated Split sessions; bind `base64url(session.authenticatedSessionId)` from the authenticated session, never a client-supplied ID. The getter throws before Split and returns a defensive copy.

`verifyAssertion(response, storedCredential, context, commit)` checks exact type `webauthn.get`, pinned HTTPS origin, exact RP hostname (not parent domain), no embedded/cross-origin flow, RP hash, UP **and** UV, flags/extensions, actual signature and signCount. Zero/zero skips clone detection; otherwise count must increase. It returns an opaque in-process `VerifiedUv` only after `commit(...) === true`. No `uv:true` input and no mock production verifier.

Mandatory host `commit` must atomically: re-read active device/trust/session; match and consume stored challenge, binding, expiry; compare old credential/count (CAS); update count; authorize only this operation. Recheck current time inside that transaction after asynchronous signature work. Return false on races/revocation/expiry; do not execute the effect before success. Package consumes no persistent state itself. Execution receipts and an operation's transactional effect remain daemon-owned.

### First registration and replacement

`verifyRegistration(response, RegistrationContext, authority, commit)` accepts only `attestation:"none"`, actual CBOR attested credential data, exact create client data/RP, UP/UV and an allowed valid COSE key. None attestation **does not prove hardware provenance**; initial authorization is the Mac-approved pair, not trusted client assertions.

- First registration requires server-sourced `existingCredentialId:null` and a live `pendingPair` matching pairing ID, device ID, actual Split session ID and trust epoch. Host creates/binds this short-lived permission from the locally confirmed pairing; transaction must atomically require no credential, consume pending-pair permission + registration challenge, and persist key/count. Missing/expired pending state is rejected even if a caller supplies the kind string. If onboarding expires, re-open first-registration permission with fresh local Mac presence; a stolen device key cannot mint it. Ordinary chat can still work without UV, but high-risk actions remain disabled.
- Replacement first stages the newly created registration response under a create challenge (never installs it). Then issue an **assertion** challenge to the existing credential, with all the same binding fields but `operationDigest = registrationOperationDigest(stagedResponse)`. Verify it with `verifyAssertion`; pass its live `VerifiedUv` to `verifyRegistration`. The verifier requires the existing credential ID, a fresh one-use opaque authorization, and the hash of the **exact new response**. Host transaction rechecks that existing credential, consumes the create challenge and commits replacement atomically. Fake JS objects, an assertion for different params/material, and consumed authorizations fail. Do not serialize `VerifiedUv` or store it as a boolean; combine verification/registration in one request, or require a new assertion.
- Browser create options: `attestation:'none'`, `userVerification:'required'`, `rp.id` equal pinned relay hostname, allowed algorithms above. Get also requires UV. Store COSE and signCount, not just credential ID. On UV failure deny the high-risk action; never downgrade to a click or device signature.

## Browser trust and privacy integration checklist

Trusted web origin can replace JavaScript and read browser secrets; E2EE protects against ciphertext relay substitution, not malicious origin code/XSS. This is not permission to ignore XSS. Treat Markdown/model output, HTML/SVG/files, filenames, tool results, URL schemes, JSON error text and third-party scripts as untrusted. Use text rendering/sanitization, URL allowlists, CSP without unsafe eval/inline handlers, and opaque-origin previews (`sandbox` without `allow-same-origin`); scope blob/worker permissions. Remote production must not expose local bearer/dev discovery, persist application plaintext, cache API responses in the service worker, or put secrets/file paths in URLs/query/logs. Downstream client owns these UI/CSP checks. Test fixture serves only local static files with restrictive CSP and no persistent storage.

## Reproducible checks

- `pnpm install --frozen-lockfile`
- `pnpm test` (includes `cargo build --locked`, TS security tests/live snow duplex, and `cargo test --locked` for the independent harness)
- `pnpm typecheck`
- `pnpm --filter @real-bot/remote build`
- `pnpm --filter @real-bot/remote build:browser` then `pnpm --filter @real-bot/remote smoke:serve` on **127.0.0.1:5184**; click the check button with generated test keys. The browser fixture measures this desktop's handshake/1MiB roundtrip and verifies WebCrypto ES256 signatures, **not** a physical authenticator.

CI runs the same remote tests/builds; no network is needed after dependencies are installed. Physical PWA/device, signed Keychain helper, launchd, domain deployment, push and independent review remain separate external/integration gates.
