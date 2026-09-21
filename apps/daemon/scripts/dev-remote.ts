/**
 * Dev-only driver for the remote setup channel.
 *
 * The packaged app drives this from the window over an inherited socketpair
 * that the signed helper authorizes; in development there is no such window,
 * so a daemon started with REAL_BOT_DEV_REMOTE=1 exposes the same dispatcher
 * on a unix socket. Confirmations that Touch ID would sign are answered here
 * by the person at the terminal.
 *
 *   bun scripts/dev-remote.ts status
 *   bun scripts/dev-remote.ts init --origin https://relay.example.com --relay-id <id> [--bootstrap-file <path>]
 *   bun scripts/dev-remote.ts pair
 */
import { createConnection, type Socket } from "node:net";
import { spawnSync } from "node:child_process";
import { encodePairingCode, type PairingQr } from "@real-bot/remote";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { defaultDataDir } from "../src/descriptor";
import { devSocketPath } from "../src/remote/dev-setup";
import { ulid } from "../src/ids";

const dataDir = process.env.REAL_BOT_DATA_DIR ?? defaultDataDir();
const path = devSocketPath(dataDir);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

class Channel {
  private constructor(private readonly socket: Socket) {}
  static connect(): Promise<Channel> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new Channel(socket)));
      socket.once("error", error => reject(error));
    });
  }
  send(request: unknown): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(request));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(payload.length);
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      // The pairing poll reuses one connection, so both listeners come back off.
      const done = (settle: () => void) => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        settle();
      };
      const onData = (bytes: Buffer) => {
        buffer = Buffer.concat([buffer, bytes]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < length + 4) return;
        const response = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as { ok: boolean; value?: unknown; error?: string };
        done(() => response.ok ? resolve(response.value) : reject(new Error(response.error ?? "remote_setup_denied")));
      };
      const onError = (error: Error) => done(() => reject(error));
      this.socket.on("data", onData);
      this.socket.on("error", onError);
      this.socket.write(Buffer.concat([prefix, payload]));
    });
  }
  close(): void { this.socket.destroy(); }
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim().toLowerCase() === "y"; }
  finally { rl.close(); }
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function status(channel: Channel): Promise<void> {
  console.log(JSON.stringify(await channel.send({ operation: "status" }), null, 2));
}

async function init(channel: Channel): Promise<void> {
  const origin = flag("origin"), relayId = flag("relay-id"), hostId = flag("host-id") ?? ulid();
  const bootstrapFile = flag("bootstrap-file");
  if (!origin || !relayId) throw new Error("init needs --origin and --relay-id");
  // The token never travels through argv: the relay's own docs require a file.
  const bootstrap = bootstrapFile ? readFileSync(bootstrapFile, "utf8").trim() : undefined;
  const request = bootstrap === undefined
    ? { operation: "initialize", config: { origin, relayId, hostId } }
    : { operation: "initialize", config: { origin, relayId, hostId }, bootstrap };
  console.log(`host id ${hostId}`);
  console.log(JSON.stringify(await channel.send(request), null, 2));
}

/** Saves the person selecting 200 characters out of a terminal by hand. */
function copyToClipboard(value: string): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("pbcopy", { input: value }).status === 0;
}

async function pair(channel: Channel): Promise<void> {
  const qr = await channel.send({ operation: "open_pair" }) as PairingQr;
  const code = encodePairingCode(qr);
  console.log("\nPaste this into the device's pairing screen (one-time secret, expires in 10 minutes):\n");
  console.log(code);
  if (copyToClipboard(code)) console.log("\n(copied to the clipboard)");
  console.log("\nWaiting for the device to submit…");
  let prepared: { challenge: string; name: string; fingerprint: string } | undefined;
  while (!prepared) {
    if (Math.floor(Date.now() / 1000) >= qr.expiresUnix) throw new Error("pairing window expired");
    const response = await channel.send({ operation: "prepare_pair", pairingId: qr.pairingId }) as
      { pending?: true } & { challenge?: string; name?: string; fingerprint?: string };
    if (response.pending === true) { await wait(3000); continue; }
    prepared = response as { challenge: string; name: string; fingerprint: string };
  }
  const { display } = await channel.send({ operation: "dev_describe", challenge: prepared.challenge }) as { display: string };
  console.log(`\nThe signed build would show this on the Touch ID sheet:\n  ${display}`);
  console.log(`\n  device      ${prepared.name}`);
  console.log(`  fingerprint ${prepared.fingerprint.replace(/(.{8})/g, "$1 ").trim()}`);
  console.log("\nCompare the fingerprint with the one on the device before approving.");
  if (!await ask("Approve this device? (y/N) ")) { console.log("declined; the pairing window stays open until it expires"); return; }
  const { proof } = await channel.send({ operation: "dev_authenticate", challenge: prepared.challenge }) as { proof: string };
  const result = await channel.send({ operation: "confirm_pair", pairingId: qr.pairingId, proof });
  console.log(`paired: ${JSON.stringify(result)}`);
}

const command = process.argv[2];
let channel: Channel;
try {
  channel = await Channel.connect();
} catch {
  console.error(`no dev remote channel at ${path}\nstart the daemon with REAL_BOT_DEV_REMOTE=1`);
  process.exit(1);
}
try {
  if (command === "status") await status(channel);
  else if (command === "init") await init(channel);
  else if (command === "pair") await pair(channel);
  else { console.error("usage: dev-remote.ts status | init | pair"); process.exitCode = 1; }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  channel.close();
}
