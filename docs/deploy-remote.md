# Experimental self-hosted relay / 实验性自托管中继

**Default-off infrastructure, not a released remote application.** One owner, one execution Mac, at most 16 enrolled devices. No cloud account, official service, arbitrary HTTP proxy, relay decryption, offline command/approval queue, or inbound Mac listener. The daemon adapter (ticket 07) and remote/PWA client (ticket 08) are separate. The production messenger build currently displays its existing disconnected screen; this is not an operational remote UI or installable PWA. [Protocol/security gates](remote-protocol.md) still apply, especially independent security review and physical-device validation. Do not expose public pairing before those gates pass.

**默认关闭的基础设施，不是已发布远控。** 单人、单执行 Mac、最多 16 设备；不引入官方云、账号、任意 HTTP 代理、明文业务、离线命令/批准队列或 Mac 入站监听。daemon/PWA 接线另票；静态信使目前只显示既有断线屏，不宣称远控 UI/PWA 已完成。独立安全复核、真机、域名/TLS 等发布门仍未通过。

## Local build and isolated verification

From the repository root, with Bun **1.4.2** (the deployment pin), Node >=22, pnpm 12.3.4 and Cargo:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm --filter @real-bot/relay build
pnpm --filter @real-bot/messenger build
pnpm --filter @real-bot/relay smoke:serve
```

The last command serves only this checkout's production static files at `http://[::1]:5186`, with hashed script CSP, no Vite, no API and no discovery response. It fails rather than evicting another listener. Use the isolated `agent-browser --session rc06` session to load desktop/narrow layouts and offline state. No personal database, Keychain, model service or port 17890 is used. Tests start actual Bun HTTP/WS servers on random loopback ports, generated identities and temporary SQLite; two simultaneous host links carry real `DeviceSession`/`HostSession` Noise traffic. A raw paused TCP/WebSocket reader exercises actual write-buffer backpressure.

The browser fixture imports the same typed `productionCsp(html)` generator used by the Docker build, including rejection of HTML without inline entry scripts. Relay mailbox path, maximum envelope and lifetime derive from `PAIR_MAILBOX_CONTRACT`; relay-only chunk/count/rate limits remain local.

### Real Caddy edge regression suite

The separate suite requires **Caddy 2.10.2** and **OpenSSL**, and fails rather than silently skipping when either is missing. To build the pinned Caddy locally, install Go >=1.25 and run:

```sh
go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.10.2
CADDY_BIN="$(go env GOPATH)/bin/caddy" pnpm --filter @real-bot/relay test:edge
```

`CADDY_BIN` defaults to `caddy` on PATH. CI installs that exact release and runs the same command, separately from root `pnpm test`. The suite uses the actual production Caddyfile with only owned loopback ports, paths/upstream and generated localhost certificate substituted. It generates a one-day certificate in a temporary directory, explicitly trusts it per test client (never disables certificate verification or changes OS trust), then exercises **real HTTP, HTTPS, WSS, Ed25519 enrollment, Noise request/response and revocation**. Response assertions cover query canary non-reflection, fixed redirects, exact CSP script hash, immutable GET/HEAD/304, missing asset404 (not SPA HTML), method405/range416 errors, API no-store and forwarded-IP spoofing. The static HTML/assets in this suite are disposable fixtures; the production messenger receives the separate browser smoke above. It stops owned servers and removes keys/state. No ACME request, public domain or real credentials are involved; generated localhost TLS does **not** pass domain issuance/renewal, Docker or physical-device gates.

`@real-bot/relay` exports `startRelay(RelayOptions)`, `RelayOptions`, `RelayLog`, `LIMITS`. `startRelay` returns `{port, stop(): Promise<void>}`; tests can inject a clock, never an authentication verifier. No public production option bypasses the stored-key proof. `pnpm --filter @real-bot/relay start` runs `src/main.ts`; `build` emits runnable `dist/main.js` for Bun.

## HTTP/WS contract for host and client adapters

All JSON is UTF-8 **RFC8785 canonical JSON**, generated with `canonicalize` from `@real-bot/remote`. Reordered/pretty/duplicate-key JSON, unknown fields, invalid UTF-8, padded base64url and wrong methods/opcodes fail closed. IDs are canonical ULIDs; route/request nonces are unpadded base64url of 16 random bytes; public keys are 32 bytes. No credentials, pairing IDs or file paths go in URL/query. Query strings, Authorization headers, and foreign Origins are rejected. Browser Origin must equal `RELAY_ORIGIN`; native outgoing host connections may omit Origin. TLS/WSS is mandatory outside isolated loopback fixtures.

| Route | Request / response |
| --- | --- |
| `GET /healthz` | Internal liveness only: `{enabled:boolean,status:"ok"}`. Not forwarded by Caddy; no identities or socket inventory. |
| `POST /v1/relay/bootstrap` | `Content-Type: application/json`, body `{bootstrap,host_id,enrollment_pk}`. Both gates enabled; 201 `{enrolled:true}` once. Atomic persistent consumption; all failures generic. |
| `GET /v1/relay/host` | WS upgrade, then host enrollment below. `mode:"control"` or `mode:"link"`. |
| `GET /v1/relay/device` | WS upgrade, then device enrollment. Host control must already be online. |
| `POST /v1/pair/mailbox` | Unregistered device submission/polling below. **No enrollment prerequisite**, no business access. |

Other routes are 404, disabled admission 503, rate pressure 429, malformed/authentication HTTP input 400 (wrong Origin 403). HTTP bodies are at most 90,000 bytes to accommodate canonical base64url of a 64 KiB envelope. The relay is not a generic request dispatcher. HTTP errors have only `{error:"rejected"}` and `Cache-Control: no-store`. WS protocol/authentication errors terminate immediately without echoing input; callers must not rely on receiving a graceful close code.

### Enrollment and per-device host links

1. Host first opens a **control** WS with text `{type:"hello",id:hostId,nonce_c,mode:"control"}`. Exactly one authenticated host control connection exists; a second cannot replace it.
2. Server text: `{type:"challenge",role,id,nonce_c,nonce_s,ts,relay_id}`. `nonce_s` is freshly server-generated, `ts` is server Unix seconds. Client verifies expected role/id/nonces/relay ID and signs the challenge using `signEnrollmentProof` and its enrollment secret. Client text: `{type:"proof",signature}`. Relay uses **only its stored role+ID key** and `verifyEnrollmentProof`; consumes the challenge synchronously on the same socket. Both wall-clock proof age and connection deadline are <10s. Keys in Hello are not accepted. Replay on another socket/server restart fails because issued nonce state is gone and fresh challenges differ.
3. Control text response `{type:"ok",mode:"control"}`. Thereafter **binary canonical JSON metadata only** on this dedicated control socket. This is authenticated TLS relay management, not a plaintext business channel. No application commands, arbitrary method/path/URL, keys other than enrollment public keys, names, files, or Noise frames belong here.
4. Device opens WS; text Hello is exactly `{type:"hello",id:deviceId,nonce_c}`. After a valid proof, it waits **without sending anything**. Server sends the control socket binary `{type:"route_pending",route_id,device_id}`. The random route ID identifies an online candidate, not a bearer credential or pairing mailbox.
5. Host checks its **own durable, current device trust/key/epoch state**. If authorized, it opens an additional outbound host WS: text Hello `{type:"hello",id:hostId,nonce_c,mode:"link",route_id,device_id}` and answers a separate host proof. Route ID/device ID are frozen in that socket's server-side challenge context, matched against the pending device, then rechecked at proof time. At the synchronous bind transition the device must still be in `waiting` with `now < device.deadline`; a later host challenge cannot extend this window. Expired candidates are removed and both sockets terminated even before the periodic sweep. A public route ID alone cannot bind a link. Host may reject through `close_route`.
6. Both data endpoints receive text `{type:"ok",mode:"link",route_id,device_id}` only when attached. Device now sends `DeviceSession.start()` as one binary frame. Host's per-device `HostSession.accept()` response is one binary frame; after Split each binary frame remains exactly one opaque Noise message, with **no extra routing header**. Route identity never comes from ciphertext or arbitrary recipient fields. Relay does not interpret Noise or decide business authorization. Host must close on any Noise failure and provide ticket-04 trust/replay callbacks, including restart-safe IK replay reservation.
7. One active route per device; up to 16 devices = **32 data slots** plus one host control. All links are outbound from Mac. Host control loss closes every device/link/proof and clears all mailboxes. Either data endpoint loss closes its counterpart. No reconnect resumption or offline buffering; fresh enrollment and fresh Noise are required. Unbound device waiting expires after 10s.

This replaces the draft's impossible “all device Noise messages on one unframed host socket” with a control socket plus bound per-device sockets. It does **not** change Noise bytes or the 04 package. Management metadata is the only post-Ok binary-JSON exception; data sockets reject text and pre-Ok binary. Ticket 07 must demultiplex control notifications/results and keep one Noise instance per link.

### Authenticated control operations

Send one binary UTF-8 canonical JSON object `{op,request_id,...fields}`. `request_id` is a fresh 16-byte random base64url correlation ID, not a durable business receipt. Success is binary `{type:"result",request_id,...result}`. `route_pending` and `route_closed` notifications can interleave with responses. Unknown fields/ops or failed preconditions terminate **the control connection and every dependent link**. No retry queue. Reconnect/reconcile durable enrollment if an acknowledgement was lost.

| `op` | Exact additional fields | Result / semantics |
| --- | --- | --- |
| `health` | none | `devices,routes,mailboxes,sockets,pairing_enabled`; bounded counts, no keys, IPs or paths. |
| `open_pair` | `pairing_id,expires_unix` | Host locally authorized a pending pair; expires >now and <=now+600s. Pairing gate required. At most four windows. |
| `register_device` | `device_id,enrollment_pk` | Host must first durably confirm trust locally. Installs one of 16 enrollment keys. Same ID+key is idempotent; replacement or key collision fails. Pairing gate required. |
| `revoke_device` | `device_id` | Durable removal **before** result; immediate termination of both route endpoints and pending proofs; all pairing mailboxes cleared. Repeat is safe. Host must revoke local trust/epoch and close Noise state first. |
| `read_pair` | `pairing_id,offset` | `{pending:true}` until submitted (offset 0), then `{ciphertext,offset,total}`. Sequential chunks <=16 KiB; final read releases request buffer. Lost chunk requires reopening a pair; not replayed. |
| `deliver_pair` | `pairing_id,offset,total,ciphertext` | Sequential nonempty chunks <=16 KiB, total 40..65536; allowed only after full request drain. Reply is opaque AEAD, not JSON grant plaintext. No second reply. |
| `cancel_pair` | `pairing_id` | Erases buffers/window; idempotent. |
| `close_route` | `route_id` | Terminates both data endpoints; idempotent. |

`route_closed` has exactly `{type:"route_closed",route_id}`. A revoke acknowledgement means the relay table and application send queues are gone, **not** that it can recall bytes already in OS/network buffers or an already accepted Mac operation. Adapters must discard pending decrypt/application buffers on close and recheck authoritative trust; no command replay.

### Unregistered-device pairing mailbox

Only the authenticated host can create a window. New device `POST /v1/pair/mailbox` body `{op:"submit",pairing_id,ciphertext}` sends the **actual `sealPairing` envelope** from 04 (XChaCha20-Poly1305 nonce24+ciphertext+tag, pairing secret only in QR out-of-band). One submission, 40..65536 bytes; returns 202 `{accepted:true}`. ID knowledge does not create a mailbox or enroll a device. A guess can deny service to that one window, not forge pairing authentication; host rejects invalid AEAD and reopens with a new ID/secret.

Device polls with `{op:"poll",pairing_id}` (no enrollment required). 202 `{pending:true}`, or 200 `{ciphertext}` once the full reply exists. Successful poll consumes/removes the mailbox; response loss requires local re-pairing, never a grant/command replay. Poll no faster than once per 10s (HTTP/IP budget includes submission and bootstrap). Host confirms the displayed identity/fingerprint locally, persists trust, registers enrollment key, and delivers a **signed grant wrapped in pairing AEAD**, never raw grant or secret. The shared `sealPairingGrant`/`openPairingGrant` codec now belongs to `@real-bot/remote`; it uses direction-bound pairing AEAD and verifies the QR-pinned complete signed grant. The relay still accepts only bounded opaque bytes and cannot validate AEAD or assert local confirmation. The same pinned 04 pairing KDF/AD and a strictly typed grant payload must be used at both endpoints; do not implement crypto in `apps/relay`. Ticket 07/08 must agree that codec before claiming completed pairing. Host retains consumed pending permission for later Split-bound UV onboarding as required by 04.

A mailbox holds at most **64 KiB total**, not 64 KiB per direction: request must be drained/freed before reply allocation. Four windows =>256 KiB live opaque payload. Expiry/cancel/revoke/host loss erases relay-owned buffers. No disk mailbox, no command delivery API, no optional arbitrary recipient. After process restart all windows/routes are absent; only enrollment survives.

## Daemon integration status

Ticket07 supplies `RemoteController`, actual outbound host control/per-device links, durable local enrollment reconciliation, native-confirmed pairing and shared RPC contracts in [remote protocol](remote-protocol.md#daemon-adapter-and-downstream-client-contract-ticket-07). Configure/initialize only through the trusted bundled-window setup channel; bootstrap is submitted in a body and not retained by the daemon. Runtime reuses stored public metadata on restart. Default/no configuration leaves remote off, native-unavailable leaves local chat operational, and stock Bun still has no qualified sealed credential runtime. There is no production mock/native bypass or public enable switch. PWA08, complete file09, domain/container/native/physical/security-review gates remain incomplete; a local relay/daemon test is not deployment acceptance.

## Bounds and operations

- Per actual source IP: 10 WS handshakes/min, fixed 60s window; separate 10 HTTP bootstrap/mailbox requests/min. Each limiter tracks <=1024 IP entries, refuses on full, never evicts unexpired entries. Only a directly connected, explicitly configured Caddy IP can supply `X-Real-IP`; other forwarded headers are ignored.
- Global WS admission: burst60/refill1 per second. <=32 pending handshakes/waiters and <=65 sockets including pending, one control and <=32 active data slots. Each expired pending phase is swept every250ms and rejected synchronously on message.
- Host aggregate incoming binary traffic: token bucket **20 Mbps =2,500,000 bytes/sec**, burst256 KiB across both data directions and control. Binary frame <=65536 bytes; enrollment text <=2048 bytes; WS compression disabled. Control <=20 operations/sec, burst40. Global HTTP <=50/sec, burst100, <=32 concurrently-read bodies, each <=90000 bytes and10s; streamed bodies use a fixed bounded buffer, not an unbounded chunk list.
- Bun's real send buffer <=64 KiB/socket. Any `send()` backpressure/drop, pre-send buffered overflow, or Bun limit closes both endpoints with `terminate()`, discarding queued application writes; no retry buffer. Aggregate application WS buffer ceiling <=65×64 KiB, plus the fixed HTTP/mailbox ceilings. Kernel TCP memory remains an OS/container resource, not an application queue.
- SQLite holds one host, at most16 device keys and a singleton bootstrap-consumed bit/hash. FULL synchronous rollback-journal transactions, exclusive single writer, 0600 database, `max_page_count=256` (~1 MiB at default4KiB pages), no growing tombstone/event/nonce/mailbox tables. Host revoked ID may be re-added only by an explicit new authenticated host registration; never by an old device proof.
- Logs are allowlisted `{event,code}` constants, sampled at5/sec burst20. No error objects/stacks, URL paths/query, IPs, public/private keys, request/response bodies, ciphertext or challenge material. Startup failure is fixed `{event:"startup_failed",code:1}`. Caddy access and diagnostic output are disabled (including startup wrapper); observe health and bounded counters, not raw HTTP error logs. Canary plaintext/redaction tests are part of root tests.

## Environment and bootstrap recovery

| Variable | Default / requirement |
| --- | --- |
| `RELAY_ENABLED` | `0`; only exact `1` admits relay traffic. |
| `RELAY_PAIRING_ENABLED` | `0`; only exact `1` enables bootstrap, mailbox and host new enrollment. Keep public pairing off before security review. Existing enrolled links can run with this off. |
| `RELAY_BIND` / `RELAY_PORT` | `127.0.0.1` / `8080`; Compose internal bind0.0.0.0, **no relay published port**. |
| `RELAY_DATABASE` | `./data/enrollment.sqlite`; Compose `/data/enrollment.sqlite`. Private persistent directory, one process. |
| `RELAY_ID` | Required1..64 ASCII letters/digits/underscore/hyphen; clients pin it. |
| `RELAY_ORIGIN` | Required exact canonical HTTPS origin (no slash); clients pin it. Compose derives from `RELAY_DOMAIN`. |
| `RELAY_TRUSTED_PROXY_IP` | Unset by default; Compose172.30.6.2 only. Do not trust arbitrary request headers. |
| `RELAY_BOOTSTRAP_FILE` | Required to initialize a new database; plain unpadded base64url of **32 CSPRNG bytes**, outside repo, private file. CLI reads file, never URL/argv token. |

Generate on a trusted machine with `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'` redirected into a new mode0600 file under `umask 077`; do not print it, paste into chat, pass on command lines or commit it. Validation requires exactly32 canonical bytes and at least16 distinct byte values; this rejects obvious weak strings but **cannot prove entropy**. Only a CSPRNG provides256-bit entropy. The relay stores SHA-256 of the initial token, then atomically clears the hash and records consumption alongside host enrollment. Subsequent supplied files cannot reset the token; restart cannot replay it. Submit through a TLS-protected canonical JSON request **body** from the native host setup flow. Durable stored-key nonce proof is still required for every WS.

After consumption, replace the secret file contents with an empty file (same permissions) or remove the mount/env variable together; do not leave a stale readable bootstrap. Existing initialized DB ignores a supplied replacement token. If bootstrap response is lost, attempt the stored host's nonce authentication, not another bootstrap. Losing host key requires local administrator recovery: stop both services, isolate/archive the enrollment database, invalidate every device/grant and re-pair on the Mac, then intentionally initialize a fresh database and fresh token. Deleting state silently reopens trust and is **not** routine recovery. Backups must preserve the consumed bit and matching host key state. Do not restore a pre-revocation DB as if device trust were unchanged. SQLite/file failures refuse admission, with no memory-only fallback.

## Compose deployment (external gate until actually run)

`deploy/remote/compose.yaml` builds the **own relay Dockerfile** and production messenger+Caddy image. Dependencies use frozen pnpm lockfiles; relay bundles run on pinned Bun1.4.2. Both runtime containers are non-root, read-only, cap-drop ALL, no-new-privileges, limited PIDs/FDs/tmpfs. Combined caps: **1 CPU, 512 MiB RAM**; json-file logs <=40 MiB (two services×2×10MiB), below the50MiB budget. Caddy listens internally on8080/8443, publishes80/443 **only to127.0.0.1 by default**. Setting a public `REMOTE_BIND_IP` requires the separate deployment/security gate; this ticket does not open inbound ports.

Prepare an **uncommitted** mode0600 env file outside the checkout with `RELAY_ID,RELAY_DOMAIN,ACME_EMAIL,RELAY_STATE_DIR,CADDY_DATA_DIR,RELAY_BOOTSTRAP_FILE`; keep both admission flags0. Bootstrap value is in the secret file, not the env file. Host directories must already exist (Compose refuses auto-creation), owned by UID1000, mode0700. Secret must be readable by UID1000; Docker Compose file secrets may ignore uid/mode remapping, so set host ownership/permissions explicitly. Avoid printing `docker compose config` with real paths; use `config --quiet`.

**Disk1GiB is a real operator precondition, not a fictitious Compose volume-size field.** Bind the relay and Caddy data directories from a dedicated <=1GiB filesystem/project quota that covers both, leaving20% headroom (e.g. XFS project quota for their common parent). Plain Docker named volumes do not enforce capacity; this configuration deliberately uses explicit bind mounts. Verify quota enforcement before deployment. SQLite's page cap additionally bounds enrollment state; image/layer storage and Docker logging are separately host-managed, not claimed inside the data quota.

```sh
docker compose --env-file /private/location/remote.env -f deploy/remote/compose.yaml config --quiet
docker compose --env-file /private/location/remote.env -f deploy/remote/compose.yaml build
docker compose --env-file /private/location/remote.env -f deploy/remote/compose.yaml up -d
sh deploy/remote/check-health.sh /private/location/remote.env
```

Use your external monitor to run `check-health.sh` periodically and alert on nonzero: relay liveness failure, missing Caddy container, or filesystem >=80% used. It emits only fixed failure categories, suppressing raw Docker errors/paths. For XFS per-project quotas, **also** monitor project-quota usage from the host (`df` cannot see that limit). Alert on container restart/OOM, sustained429/close metadata and health-check failure; Docker restart policy alone is not alerting. Authenticated `health` supplies route/mailbox counts to the host. Operator monitors must not collect HTTP bodies or full Caddy diagnostics.

Caddy's explicit HTTP site rejects queries before a fixed-host, query-free HTTPS redirect. After that rejection, the redirect preserves the original escaped URI (`http.request.orig_uri`), not a decoded path: `%3F`, `%23` and `%252F` must not become query/fragment delimiters or lose an encoding layer. Even a path beginning `//` cannot replace the configured destination host. Real HTTP/HTTPS tests compare exact Location bytes and equivalent direct/redirected navigation while retaining actual-query400/no-Location canary checks. Only automatic redirects are disabled (`auto_https disable_redirects`); certificate automation and Caddy's built-in HTTP/TLS challenge handlers remain enabled. Active ACME challenges are handled by Caddy before site routes; no catch-all proxy or external challenge service is added. Local fixtures check configuration preservation and unknown challenge-path routing, **not successful public ACME issuance**. HTTPS rejects queries too. Cache policies are separate from deferred Server removal: existing immutable GET/HEAD responses with status200/304 receive `public, max-age=31536000, immutable`; the deferred default is no-store. Missing immutable resources have a dedicated file handler and return404 rather than SPA HTML; error handlers return no-store including405/416 and no response body details.

Caddy pins TLS1.2/1.3 and issues certificates for the operator-owned domain; ports80/443/DNS/ACME and certificate renewal must be validated on the eventual Linux deployment. TLS domain substitution is not permitted. It forwards **only four exact relay routes**, never daemon `/v1/*`, `/__local-api`, Vite/source endpoints or local bearer discovery. Static shell script CSP uses build-derived SHA-256 hashes (no script unsafe-inline/eval/handlers), allows same-origin connections only; existing style attributes require style unsafe-inline. No service worker/API caching or PWA claim. No third-party script source. The build origin remains trusted to supply JS, not an E2EE guarantee against malicious origin code.

### Evidence and unpassed gates

This implementation can be verified with real local Bun sockets, full tests/typecheck, production builds, Compose schema, BuildKit Dockerfile parsing, and pinned Caddy configuration validation plus real localhost HTTP/HTTPS/WSS integration without Docker engine. **Those checks do not prove Docker images build/run or Linux quota/TLS behavior.** On a machine where `docker version` cannot reach the daemon, record the exact failure and leave these external gates pending: image builds/container startup, two-endpoint ciphertext exchange inside Compose, resource/quota enforcement, domain TLS/WSS/ACME renewal, independent review, daemon/client integration and physical PWA/WebAuthn. Do not label the remote feature accepted based on a static screenshot.
