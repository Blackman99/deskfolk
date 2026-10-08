# Remote access (experimental)

[简体中文](remote-access.zh.md)

> **Off by default, and not a finished feature.** Remote access is an experimental prototype. The installed app can set it up and pair devices: it keeps the Mac's remote identity in a private file in its data folder rather than the Keychain, and Touch ID (or your login password) approves each device ([ADR 0033](adr/0033-remote-credentials-in-a-file.md) says what that trades). The Windows preview does the same with Windows Hello approving ([ADR 0059](adr/0059-windows-remote-access-and-screen.md)), but has **not been tried on a real Windows PC yet**. Everyday use and Web Push work on a real Android phone in Chrome (verified from source; the installed app runs the same protocol on the same file). The independent security review (S-rev), real-device home-screen WebAuthn (G-uv), real-device iOS L1 and iOS home-screen Web Push (G-push) have **not passed**. Keep public pairing off whenever you are not pairing, and do not route anything through it you could not afford to expose.

Remote access lets a phone, or a browser on another computer, reach the Deskfolk on your Mac: read and answer conversations, handle what is waiting on you, look through the workspace and type into your terminals. There is no Deskfolk cloud. You run the relay yourself, the Mac only ever dials out to it, and the relay passes along encrypted traffic it cannot read.

## How it fits together

- **Your Mac** is still the only place work runs. The daemon keeps one outbound connection to the relay for control and opens one more for each connected device. Nothing on the Mac listens for inbound connections.
- **The relay** is a small Bun service behind Caddy, on a server and domain you own. It serves the phone app — the hosted messenger, an installable web page — over HTTPS, and forwards opaque Noise frames between the Mac and each device. It stores only enrollment public keys, logs only fixed event codes, and cannot decrypt a message.
- **Each device** is paired once, by you at the Mac. From then on it talks to the Mac end to end over Noise IK; the relay only routes the bytes.

One owner, one Mac, at most 16 paired devices. Nothing is queued while the link is down: if the Mac is asleep or unreachable the device says so and sends nothing, and it reconnects on its own when the Mac is back.

## What a paired device can do

- **Conversations** — the chat list, reading and sending, `@`mentions, Stop, and answering approval cards and questions. What waits on you is marked on the conversation, as on the Mac. On an Android phone a long-press on a message opens its menu, whose Copy takes the whole message; its **Select text** opens the message's text on a page of its own, where you select and copy part of it as anywhere else on the phone; the phone's Back returns to the conversation (iPhone Safari opens no menu on a long-press). On a tablet or any wider window the list stays a column, and the button at the right end of its top row folds it to a 64-pixel rail of avatars — as does ⌘B — with the same conversations, the same counts, and Workspace, Tools and Settings at the foot; the button at the top of the rail unfolds it. At 680px and below the list is a screen of its own and there is nothing to fold.
- **The workspace** — browse folders on the Mac and open or download files of any size. Every file you open can be downloaded: on a phone from the right end of the preview's top bar, on a wider screen from the row of buttons above the file, and on the flow board from the head of a file card. A file that can't be previewed, such as a subtitle file or an archive, says so and offers the download in the middle instead. Pictures arrive as scaled copies with the original one tap away. One tap downloads a file, on a phone too, however long it takes to come over. An enlarged picture, in a conversation or the workspace, has a download button that saves the original: on a phone it opens the share sheet, whose Save Image puts it in Photos. Pictures, videos, audio and PDFs you sent from the phone open from the phone's own copy until the page reloads, without coming back over the relay. Audio and video play while they load. On an Android phone, long-press a file or folder in the tree to move it to the Mac's Trash (iPhone Safari opens no menu on a long-press); it asks first, and Finder on the Mac can put it back.
- **Your terminals** — watch and type into a shell the daemon holds, with a two-row key bar for Esc, Tab, Ctrl, arrows and Paste. Swipe to scroll back through the output, including inside a full-screen program such as Claude Code, vim or less.
- **A Files conversation** of its own — a file sent there is copied into the workspace `inbox/`, text stays as a note to yourself, and neither wakes a Bot. Files go up at about 0.9 MB/s, inside the relay's shared limit, so a 20 MB video takes around 23 seconds. The send button fills a ring as they go and each file shows how much of it has gone; a send that fails keeps its files in the composer.
- **Optional Mac screen** — see and operate this Mac's screen from the phone, typing the password at the lock screen too. The picture comes from macOS's own Screen Sharing (on Windows, from a VNC server you install); it is off by default and turned on at the Mac (below).
- **Optional Web Push** — a generic "Deskfolk has pending items" reminder sent by the Mac. Tapping it reconnects and opens the chat list; it never approves anything.
- **Maintenance** — status, redacted diagnostics, and a drain-then-restart of the runtime. These, and revoking another device, need WebAuthn user verification on the device (Face ID, Touch ID or a passcode). There is no click-to-confirm fallback; ordinary chat works without it.

Changing the workspace folder, pointing the Mac at a relay and approving a new device still happen at the Mac.

## Before you start

- A Linux server you control, with Docker Compose (plus git and openssl, which it almost certainly has), ports 80 and 443 free, and a domain name pointing at it (this guide uses `relay.example.com`).
- Deskfolk on the Mac: the installed app, or a source checkout (the [Run from source](../README.md) requirements, and Bun on the path).
- A phone with a current browser. For Web Push, iOS needs 16.4 or later with the page added to the Home Screen.

## 1. Deploy the relay

Run these steps on the server as root (`sudo -i` first if you are not).

**Fetch the code, create the data directories and make the one-time bootstrap token.** The token is what lets your Mac, and only your Mac, register with this relay, so it goes straight into a private file outside the checkout; do not print it, paste it into a chat or put it on a command line. The relay container runs as UID 1000, so both data directories and the token file belong to it, mode 0700 / 0600; ideally the data directories sit on a filesystem with a 1 GiB quota.

```sh
git clone https://github.com/Blackman99/deskfolk.git && cd deskfolk
install -d -m 0700 /srv/deskfolk-relay
install -d -m 0700 -o 1000 -g 1000 /srv/deskfolk-relay/state /srv/deskfolk-relay/caddy
(umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > /srv/deskfolk-relay/bootstrap)
chown 1000:1000 /srv/deskfolk-relay/bootstrap
```

If the token file does not belong to UID 1000, the relay cannot read it and exits at start (its log says only `startup_failed`), and Caddy, which waits for the relay to be healthy, never starts either.

**Write a private env file**, also outside the checkout. Put in your own domain and email and a `RELAY_ID` you will recognize, then run:

```sh
cat > /srv/deskfolk-relay/remote.env <<'EOF'
RELAY_ID=my-relay
RELAY_DOMAIN=relay.example.com
ACME_EMAIL=you@example.com
RELAY_STATE_DIR=/srv/deskfolk-relay/state
CADDY_DATA_DIR=/srv/deskfolk-relay/caddy
RELAY_BOOTSTRAP_FILE=/srv/deskfolk-relay/bootstrap
RELAY_ENABLED=1
RELAY_PAIRING_ENABLED=1
REMOTE_BIND_IP=0.0.0.0
EOF
```

`RELAY_ENABLED` and `RELAY_PAIRING_ENABLED` default to off; the relay admits nothing without the first, and bootstrap and pairing need the second. Caddy publishes 80/443 on `127.0.0.1` only unless you set `REMOTE_BIND_IP`; opening it to the internet is exactly the step the unpassed security gates cover, so do it knowingly.

**From the checkout, build, start and check** (the first build takes a few minutes):

```sh
docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml config --quiet
docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml up -d --build
sh deploy/remote/check-health.sh /srv/deskfolk-relay/remote.env
```

Caddy requests the certificate for your domain. Opening `https://relay.example.com` should now show the pairing page.

Without Docker, the same relay runs as `bun apps/relay/dist/main.js` (from `pnpm --filter @real-bot/relay build`, on Bun 1.4.2) with the same environment variables, behind any TLS proxy that reproduces [`deploy/remote/Caddyfile`](../deploy/remote/Caddyfile) rule for rule and serves the output of `pnpm --filter @real-bot/messenger build:hosted`. The page's Content-Security-Policy carries hashes of that build's scripts: regenerate the header with `node deploy/remote/csp.mjs <build>/index.html <header-file>` every time you rebuild, and ship both together, or the page loads blank.

Every variable, limit and recovery rule is in [self-hosted deployment](deploy-remote.md).

## 2. Point the Mac at the relay

In the app, open **Settings → Remote access**. Until the Mac is registered, the card asks for the relay (its folded **No relay yet?** section holds the step 1 commands, ready to copy):

- **Relay address** — `https://relay.example.com`, the domain from step 1.
- **Relay ID** — the `RELAY_ID` from the env file.
- **One-time bootstrap token** — the contents of the bootstrap file. Copy the file to the Mac (mode 0600) and paste from it, rather than through a chat or a note.

Choose **Connect to relay**. The relay consumes the token: it cannot be used again. A refused or mistyped token leaves nothing behind on the Mac, so correct it and try again (a spent token needs a fresh one, see [bootstrap recovery](deploy-remote.md#environment-and-bootstrap-recovery)). Empty the bootstrap file on both machines afterwards. The card now reads **Remote online**.

The Mac's remote identity lives in `dev-remote/credentials.json` in the daemon's data folder (`~/Library/Application Support/real-bot`; `%LOCALAPPDATA%\real-bot` on Windows), mode 0600, created the first time you connect. Anything running as your user can read it, as it can the rest of that folder. The name dates from when only source runs used it; the installed app and a source run share the folder, so a Mac registered from source keeps its identity and paired devices in the app.

**From source**, start Deskfolk with the development switch, `REAL_BOT_DEV_REMOTE=1 pnpm dev`. It uses the same file and stands in for the Touch ID sheet: the settings card approves without one, and so does the CLI, which can also register the Mac:

```sh
bun apps/daemon/scripts/dev-remote.ts init --origin https://relay.example.com --relay-id my-relay --bootstrap-file ~/deskfolk-bootstrap
bun apps/daemon/scripts/dev-remote.ts status
```

`init` reads the token from the file — never from the command line — and prints the Mac's host id.

## 3. Pair a phone

1. On the Mac, in **Settings → Remote access**, choose **Pair a device**. The card shows a one-time code starting with `rb1` and the Mac's signing fingerprint. The code expires in ten minutes. (`bun apps/daemon/scripts/dev-remote.ts pair` prints the same code and copies it to the clipboard.)
2. Get the code to the phone — Universal Clipboard, AirDrop, a note you delete afterwards. It carries a one-time secret; keep it out of chats and logs.
3. On the phone, open `https://relay.example.com` and paste the code into **Pairing payload**. The page shows the relay address and the Mac's fingerprint: check they match what the Mac shows, then tap **Submit and wait for Mac confirmation**. The code only works on the relay that served the page, so a pasted code cannot send the phone anywhere else.
4. The Mac shows the device's name and its fingerprint. Compare it with the phone, then choose **Approve this device** and pass the Touch ID sheet, or enter your login password; the sheet names the device and its full fingerprint. Dismissing it pairs nothing and leaves the approve button there. (From source, the stand-in approves without a sheet.) On Windows the sheet is Windows Hello — face, fingerprint or PIN — which has to be set up first under Windows Settings → Accounts → Sign-in options; without it the card says so and keeps the approve button.
5. The phone opens the chat list. Add the page to the Home Screen so it opens like an app.
6. On the phone, in **Settings → Remote access**, choose **Register user verification on this device** if you want the maintenance actions.
7. Turn pairing off again by running these two lines in the server's checkout. Paired devices keep working; set it back to `1` and run `up -d` again only to pair another.

   ```sh
   sed -i 's/^RELAY_PAIRING_ENABLED=1$/RELAY_PAIRING_ENABLED=0/' /srv/deskfolk-relay/remote.env
   docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml up -d
   ```

To drop a device, use **Remove device** in the Mac's list of connected devices, and pass the same sheet. The relay forgets its key at once and its link closes.

## Web Push (optional)

The Mac sends the reminder itself, straight to the phone browser's push service (Apple, Google or Mozilla); the relay never sends. The message only says that something is pending, and tapping it opens the chat list.

- **Contact:** push services require an operator contact, and pushes stay paused (`push_contact_required`) until the Mac has one. Set it through the Mac's local API: `GET /v1/notifications/push-config` for the current revision, then `PATCH` the same path with `{"contact_uri": "mailto:you@example.com", "if_revision": <revision>}`.
- **Proxy:** if the Mac reaches the internet through a proxy, start it with `HTTPS_PROXY` set, for example `HTTPS_PROXY=http://127.0.0.1:7890 REAL_BOT_DEV_REMOTE=1 pnpm dev`. The system proxy setting alone does not reach the daemon. Details: [Web Push proxy](deploy-remote.md#web-push-proxy).
- **On the phone:** turn on **Pending-item push** under **Settings → Remote access**, then send a test. The result tells queued, accepted by the push service, and timed out with a retry scheduled apart; whether the phone shows it is up to the browser and the system.

## Mac screen (optional)

Tools → Mac screen on the phone shows this Mac's screen and lets you operate it: a system dialog, a Keychain prompt, a page in the browser, the lock screen — none of them need you back at the Mac. The picture and input come from macOS's own Screen Sharing; Deskfolk needs no Screen Recording or Accessibility permission.

- **At the Mac, turn on two things:** System Settings → General → Sharing → **Screen Sharing** (it can allow only your own account), and **Allow viewing and controlling this Mac's screen** under Deskfolk's **Settings → Remote access**. The card says whether Screen Sharing is on right now, who is connected, and can disconnect them.
- **On the phone:** the first connection asks for this Mac's account name and login password. Screen Sharing itself asks for them; they leave the phone only inside the end-to-end encryption. Once they get in, the phone keeps them and signs in by itself next time (untick Remember on the sign-in form to keep nothing); a refused sign-in is forgotten and asked for again.
- **Direct or via the relay:** on the same Wi-Fi, or when both ends have IPv6, the phone connects straight to the Mac and the picture never touches the relay; otherwise it goes via the relay by itself, and the top bar says which. Via the relay the picture is held to the relay's bandwidth and is slower. For direct connections from a phone on cellular, run a STUN service next to the relay (coturn, for example, with only UDP 3478 open) and put `stun:relay.example.com:3478` in **STUN / TURN servers** in the Mac's settings. Left empty, no third-party server is used.
- **Operating it:** tapping the picture clicks right there, a two-finger tap right-clicks, two fingers drag to scroll, and a pinch zooms the picture on the phone. **Trackpad** in the top bar switches to trackpad mode: slide a finger anywhere on the screen to move a pointer drawn on the picture, tap to click where the pointer is, and hold still before sliding to drag. Small targets, moving windows and selecting text then need no zooming in first; the phone remembers the choice. **Smooth** in the top bar has the Mac lower its resolution while you are connected, so window switches come through much faster (no window shrinks; the Mac's own screen looks soft meanwhile); it goes back when you disconnect.
- **Limits:** no connection with the lid shut and no external display, while the Mac sleeps, or after a restart before anyone has logged in.

### On Windows

Windows has no screen sharing of its own, so the picture and input come from a VNC server you install; Deskfolk connects to it on `127.0.0.1:5900`, exactly as it connects to Screen Sharing on a Mac. On the phone the page is called **Computer screen**.

- **Install [TightVNC](https://www.tightvnc.com/download.php)** and choose TightVNC Server, registered as a system service: a service runs as SYSTEM, so the lock screen, the sign-in screen and UAC prompts can be seen and operated too.
- **Set a primary password** in the service's configuration. The phone asks for this password, not your Windows account's; VNC uses only its first 8 characters.
- **Under Access Control, tick "Allow loopback connections"**, which TightVNC leaves off (without it the card keeps saying no VNC server was found), **and "Loopback connections only"**, so port 5900 is open to this computer alone.
- Turn on **Allow viewing and controlling this computer's screen** under Deskfolk's **Settings → Remote access**. While no VNC server answers, the card lists these steps and links the download page.
- The key row reads Ctrl, Alt, Win and Shift, and **Ctrl+Alt+Del** is in the top bar. There is no **Smooth** mode: TightVNC sends JPEG, which is small already. While a phone is connected the PC's display and sleep timers are held off, as on a Mac.
- The first direct connection may bring up a Windows Firewall prompt for `real-bot-rtc.exe`; allowing private networks is enough, and refusing it only means the picture goes via the relay.

## When something is off

- **Remote disconnected / host unreachable** — the Mac is asleep, Deskfolk is not running, or the relay is down. The phone retries with backoff on its own, and again as soon as it returns to the foreground. Right after the Mac's network drops or changes, give it a minute or two: the Mac checks with the relay every 15 seconds and reconnects on its own, but after a switch to another network the relay can hold the old connection for about a minute first.
- **Remote trust mismatch** — on the Mac, the stored remote identity and its trust records no longer agree, for example after restoring the data folder or deleting `dev-remote/credentials.json`. Do not wipe the relay's database to get past it: that is the lost-host-key recovery in [self-hosted deployment](deploy-remote.md#environment-and-bootstrap-recovery), which re-pairs every device.
- **"The pairing window expired"** — open a new one on the Mac; each code lasts ten minutes and works once.
- **"The runtime was already running when this window opened"** — the window only reaches remote setup on a runtime it started itself, for example not after the window crashed and came back. Quit Deskfolk and open it again.
- **Blank page after a rebuild** — the CSP header and the build it hashes were deployed separately.
- **"Screen Sharing is off on the Mac" / "This Mac does not allow its screen to be shown"** — turn on what the page names at the Mac, then tap Reconnect. When the account name or password is refused, check that the account is allowed under Screen Sharing.
- **"No VNC server found on the computer"** (Windows) — the TightVNC service is not running, or it refuses loopback connections: tick "Allow loopback connections" under its Access Control.
- **"Windows Hello is not set up on this computer"** — set a PIN under Windows Settings → Accounts → Sign-in options, then approve again.

Protocol, cryptography and the list of open gates: [remote protocol](remote-protocol.md).
