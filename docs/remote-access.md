# Remote access (experimental)

[简体中文](remote-access.zh.md)

> **Off by default, and not a finished feature.** Remote access is an experimental prototype for integration testing. A release build cannot pair a device yet: until its packaging gate passes, pairing needs Deskfolk running from source with a development switch. The independent security review (S-rev), real-device home-screen WebAuthn (G-uv), real-device L1 and home-screen Web Push (G-push) have **not passed**. Keep public pairing off whenever you are not pairing, and do not route anything through it you could not afford to expose.

Remote access lets a phone, or a browser on another computer, reach the Deskfolk on your Mac: read and answer conversations, handle what is waiting on you, look through the workspace and type into your terminals. There is no Deskfolk cloud. You run the relay yourself, the Mac only ever dials out to it, and the relay passes along encrypted traffic it cannot read.

## How it fits together

- **Your Mac** is still the only place work runs. The daemon keeps one outbound connection to the relay for control and opens one more for each connected device. Nothing on the Mac listens for inbound connections.
- **The relay** is a small Bun service behind Caddy, on a server and domain you own. It serves the phone app — the hosted messenger, an installable web page — over HTTPS, and forwards opaque Noise frames between the Mac and each device. It stores only enrollment public keys, logs only fixed event codes, and cannot decrypt a message.
- **Each device** is paired once, by you at the Mac. From then on it talks to the Mac end to end over Noise IK; the relay only routes the bytes.

One owner, one Mac, at most 16 paired devices. Nothing is queued while the link is down: if the Mac is asleep or unreachable the device says so and sends nothing, and it reconnects on its own when the Mac is back.

## What a paired device can do

- **Conversations** — the chat list, reading and sending, `@`mentions, Stop, and answering approval cards and questions. What waits on you is marked on the conversation, as on the Mac.
- **The workspace** — browse folders on the Mac and open or download files up to 50 MiB. Pictures arrive as scaled copies with the original one tap away; audio and video play while they load.
- **Your terminals** — watch and type into a shell the daemon holds, with a two-row key bar for Esc, Tab, Ctrl, arrows and Paste. Swipe to scroll back through the output, including inside a full-screen program such as Claude Code, vim or less.
- **A Files conversation** of its own — a file sent there is copied into the workspace `inbox/`, text stays as a note to yourself, and neither wakes a Bot. Files go up at about 0.9 MB/s, inside the relay's shared limit, so a 20 MB video takes around 23 seconds. The send button fills a ring as they go and each file shows how much of it has gone; a send that fails keeps its files in the composer.
- **Optional Web Push** — a generic "Deskfolk has pending items" reminder sent by the Mac. Tapping it reconnects and opens the chat list; it never approves anything.
- **Maintenance** — status, redacted diagnostics, and a drain-then-restart of the runtime. These, and revoking another device, need WebAuthn user verification on the device (Face ID, Touch ID or a passcode). There is no click-to-confirm fallback; ordinary chat works without it.

Changing the workspace folder, pointing the Mac at a relay and approving a new device still happen at the Mac.

## Before you start

- A Linux server you control, with Docker Compose, ports 80 and 443 free, and a domain name pointing at it (this guide uses `relay.example.com`).
- Deskfolk running from source on the Mac: the [Run from source](../README.md) requirements, and Bun on the path.
- A phone with a current browser. For Web Push, iOS needs 16.4 or later with the page added to the Home Screen.

## 1. Deploy the relay

On the server, in a checkout of this repository:

**Make the one-time bootstrap token.** It is what lets your Mac, and only your Mac, register with this relay. Write it straight into a private file outside the checkout; do not print it, paste it into a chat or put it on a command line.

```sh
umask 077
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > /srv/deskfolk-relay/bootstrap
```

**Write a private env file**, also outside the checkout. The two data directories must already exist, owned by UID 1000 with mode 0700 — ideally on a filesystem with a 1 GiB quota.

```sh
RELAY_ID=my-relay
RELAY_DOMAIN=relay.example.com
ACME_EMAIL=you@example.com
RELAY_STATE_DIR=/srv/deskfolk-relay/state
CADDY_DATA_DIR=/srv/deskfolk-relay/caddy
RELAY_BOOTSTRAP_FILE=/srv/deskfolk-relay/bootstrap
RELAY_ENABLED=1
RELAY_PAIRING_ENABLED=1
REMOTE_BIND_IP=0.0.0.0
```

`RELAY_ENABLED` and `RELAY_PAIRING_ENABLED` default to off; the relay admits nothing without the first, and bootstrap and pairing need the second. Caddy publishes 80/443 on `127.0.0.1` only unless you set `REMOTE_BIND_IP`; opening it to the internet is exactly the step the unpassed security gates cover, so do it knowingly.

**Build, start and check:**

```sh
docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml config --quiet
docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml up -d --build
sh deploy/remote/check-health.sh /srv/deskfolk-relay/remote.env
```

Caddy requests the certificate for your domain. Opening `https://relay.example.com` should now show the pairing page.

Without Docker, the same relay runs as `bun apps/relay/dist/main.js` (from `pnpm --filter @real-bot/relay build`, on Bun 1.4.2) with the same environment variables, behind any TLS proxy that reproduces [`deploy/remote/Caddyfile`](../deploy/remote/Caddyfile) rule for rule and serves the output of `pnpm --filter @real-bot/messenger build:hosted`. The page's Content-Security-Policy carries hashes of that build's scripts: regenerate the header with `node deploy/remote/csp.mjs <build>/index.html <header-file>` every time you rebuild, and ship both together, or the page loads blank.

Every variable, limit and recovery rule is in [self-hosted deployment](deploy-remote.md).

## 2. Point the Mac at the relay

Copy the bootstrap file to the Mac (mode 0600), then start Deskfolk from source with the development switch:

```sh
REAL_BOT_DEV_REMOTE=1 pnpm dev
```

The switch keeps the Mac's remote identity in `dev-remote/credentials.json` in the daemon's data folder instead of the Keychain, and stands in for the Touch ID sheet. A release build does not have it: its sealed credential store answers `g_pack_not_verified` until the packaging gate passes.

In another terminal, register the Mac once:

```sh
bun apps/daemon/scripts/dev-remote.ts init --origin https://relay.example.com --relay-id my-relay --bootstrap-file ~/deskfolk-bootstrap
bun apps/daemon/scripts/dev-remote.ts status
```

`init` reads the token from the file — never from the command line — prints the Mac's host id, and the relay consumes the token: it cannot be used again. Empty the bootstrap file on both machines afterwards. In the app, **Settings → General → Remote (experimental)** now reads **Remote online**.

## 3. Pair a phone

1. On the Mac, in **Settings → General → Remote (experimental)**, choose **Pair a device**. The card shows a one-time code starting with `rb1` and the Mac's signing fingerprint. The code expires in ten minutes. (`bun apps/daemon/scripts/dev-remote.ts pair` prints the same code and copies it to the clipboard.)
2. Get the code to the phone — Universal Clipboard, AirDrop, a note you delete afterwards. It carries a one-time secret; keep it out of chats and logs.
3. On the phone, open `https://relay.example.com` and paste the code into **Pairing payload**. The page shows the relay address and the Mac's fingerprint: check they match what the Mac shows, then tap **Submit and wait for Mac confirmation**. The code only works on the relay that served the page, so a pasted code cannot send the phone anywhere else.
4. The Mac shows the device's name and its fingerprint. Compare it with the phone, then choose **Approve this device**.
5. The phone opens the chat list. Add the page to the Home Screen so it opens like an app.
6. On the phone, in **Settings → Remote (experimental)**, choose **Register user verification on this device** if you want the maintenance actions.
7. Turn pairing off again: set `RELAY_PAIRING_ENABLED=0` and run the `up -d` command once more. Paired devices keep working; turn it back on only to pair another.

To drop a device, use **Remove device** in the Mac's list of connected devices. The relay forgets its key at once and its link closes.

## Web Push (optional)

The Mac sends the reminder itself, straight to the phone browser's push service (Apple, Google or Mozilla); the relay never sends. The message only says that something is pending, and tapping it opens the chat list.

- **Contact:** push services require an operator contact, and pushes stay paused (`push_contact_required`) until the Mac has one. Set it through the Mac's local API: `GET /v1/notifications/push-config` for the current revision, then `PATCH` the same path with `{"contact_uri": "mailto:you@example.com", "if_revision": <revision>}`.
- **Proxy:** if the Mac reaches the internet through a proxy, start it with `HTTPS_PROXY` set, for example `HTTPS_PROXY=http://127.0.0.1:7890 REAL_BOT_DEV_REMOTE=1 pnpm dev`. The system proxy setting alone does not reach the daemon. Details: [Web Push proxy](deploy-remote.md#web-push-proxy).
- **On the phone:** turn on **Pending-item push** under **Settings → Remote (experimental)**, then send a test. The result tells queued, accepted by the push service, and timed out with a retry scheduled apart; whether the phone shows it is up to the browser and the system.

## When something is off

- **Remote disconnected / host unreachable** — the Mac is asleep, Deskfolk is not running, or the relay is down. The phone retries with backoff on its own, and again as soon as it returns to the foreground. Right after the Mac's network drops or changes, give it a minute or two: the Mac checks with the relay every 15 seconds and reconnects on its own, but after a switch to another network the relay can hold the old connection for about a minute first.
- **Remote trust mismatch** — on the Mac, the stored remote identity and its trust records no longer agree, for example after restoring the data folder or deleting `dev-remote/credentials.json`. Do not wipe the relay's database to get past it: that is the lost-host-key recovery in [self-hosted deployment](deploy-remote.md#environment-and-bootstrap-recovery), which re-pairs every device.
- **"The pairing window expired"** — open a new one on the Mac; each code lasts ten minutes and works once.
- **Blank page after a rebuild** — the CSP header and the build it hashes were deployed separately.

Protocol, cryptography and the list of open gates: [remote protocol](remote-protocol.md).
