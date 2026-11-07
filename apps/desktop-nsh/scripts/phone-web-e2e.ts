/**
 * The phone on NSH web end to end, all on this Mac (ADR 0107, Phase 1c). Packages the hosted build
 * (`nsh package Hosted.tsx --target web`), starts a relay of its own (`apps/relay`) behind a TLS edge
 * on a free port that also serves the package — the relay's origin, as the deployed relay serves the
 * hosted page — and an isolated Mac (`phone-runtime.ts`) on the development remote channel. It
 * registers the Mac with the relay and opens a pairing window, then drives the page in a headless
 * browser: paste the code, compare the fingerprint, submit; approve on the Mac (the development
 * stand-in for Touch ID); then the app's shell on a phone's width: the roster, a conversation over
 * it, a line sent from the phone (read back from the Mac's database), a line written on the Mac
 * arriving live, Back to the roster, a reload that is still enrolled; and the same page at a
 * tablet's width (the roster's column beside one page, no workbench). Screenshots go to `--shots`,
 * named after the browser. Stops everything it started. Never the stable or the dev instance,
 * never a remote host.
 *
 *   bun apps/desktop-nsh/scripts/phone-web-e2e.ts [--no-build] [--browser chromium|webkit] [--shots <dir>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Playwright's types straight from `playwright-core` in pnpm's store: TypeScript does not follow
// the messenger's `@playwright/test` symlink for a relative import, so its `export * from
// "playwright/test"` resolves to nothing from here. The browsers come from the messenger's
// `@playwright/test` at run time (Bun follows the symlink), below.
import type { Browser, BrowserType, Page } from "../../../node_modules/.pnpm/node_modules/playwright-core";
import { devSocketPath } from "../../daemon/src/remote/dev-setup";
import { ulid } from "../../daemon/src/ids";
import { hostSigningFingerprint } from "../../messenger/src/lib/remote/fingerprint.ts";
import { base64url, encodePairingCode, randomBytes, type PairingQr } from "../../../packages/remote/src/index.ts";
import { certificate, RELAY_ROUTES, startEdge } from "./phone-edge";
import { FORBIDDEN_PORTS, freePort } from "./phone-runtime";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "../..");
const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const engine = flag("browser") ?? "chromium";
const shots = resolve(flag("shots") ?? join(root, "build", "phone-shots"));
const site = join(root, "build", "phone", "Deskfolk Dev");
const RELAY_ID = "phone-e2e";

const work = mkdtempSync(join(tmpdir(), "deskfolk-phone-e2e-"));
const stops: Array<() => Promise<void> | void> = [];
const step = (line: string) => console.log(`· ${line}`);

function run(args: string[], cwd: string, env: Record<string, string | undefined> = process.env): void {
  const done = spawnSync(args[0]!, args.slice(1), { cwd, env, stdio: "inherit" });
  if (done.status !== 0) throw new Error(`${args.slice(0, 3).join(" ")} failed (${done.status})`);
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | null | false> | T | undefined | null | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

/** The hosted package, as the relay would serve it. */
function build(): void {
  const llvmAr = spawnSync("find", [join(homedir(), ".rustup", "toolchains"), "-name", "llvm-ar", "-path", "*apple-darwin/bin/*"], { encoding: "utf8" })
    .stdout.split("\n")
    .find(Boolean);
  const nsh = process.env.NSH ?? join(homedir(), ".local", "bin", "nsh");
  run([nsh, "package", "Hosted.tsx", "--target", "web", "--out", join(root, "build", "phone")], join(root, "app"), {
    ...process.env,
    PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`,
    CC_wasm32_unknown_unknown: process.env.CC_wasm32_unknown_unknown ?? "/usr/bin/clang",
    AR_wasm32_unknown_unknown: process.env.AR_wasm32_unknown_unknown ?? llvmAr ?? "llvm-ar",
  });
}

/** Lines of a child's stdout, kept for when something fails, and a way to wait for one. */
function lines(stream: ReadableStream<Uint8Array>) {
  const seen: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = rest.indexOf("\n")) !== -1) {
        const line = rest.slice(0, at);
        rest = rest.slice(at + 1);
        seen.push(line);
        if (seen.length > 200) seen.shift();
        for (const waiter of waiters) waiter(line);
      }
    }
  })();
  return {
    seen,
    next: (match: (line: string) => boolean, ms: number) =>
      new Promise<string>((done, fail) => {
        const found = seen.find(match);
        if (found) return done(found);
        const timer = setTimeout(() => fail(new Error("timed out waiting for the child's line")), ms);
        waiters.push((line) => {
          if (!match(line)) return;
          clearTimeout(timer);
          done(line);
        });
      }),
  };
}

/** The relay: `apps/relay/src/main.ts`, its database and bootstrap token in the work directory. */
async function startRelay(origin: string, port: number, bootstrap: string): Promise<void> {
  const bootstrapFile = join(work, "bootstrap");
  writeFileSync(bootstrapFile, bootstrap, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, join(repo, "apps", "relay", "src", "main.ts")], {
    cwd: join(repo, "apps", "relay"),
    env: {
      ...process.env,
      RELAY_BIND: "127.0.0.1",
      RELAY_PORT: String(port),
      RELAY_DATABASE: join(work, "relay.sqlite"),
      RELAY_BOOTSTRAP_FILE: bootstrapFile,
      RELAY_ID,
      RELAY_ORIGIN: origin,
      RELAY_ENABLED: "1",
      RELAY_PAIRING_ENABLED: "1",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  stops.push(async () => {
    child.kill("SIGTERM");
    await child.exited;
  });
  await until("the relay", 10_000, async () => {
    if (child.exitCode !== null) throw new Error("the relay exited");
    return (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok;
  });
}

/** The Mac: `phone-runtime.ts` as a child, trusting the edge's certificate. */
async function startMac(certPath: string) {
  const child = Bun.spawn([process.execPath, join(root, "scripts", "phone-runtime.ts")], {
    cwd: repo,
    env: { ...process.env, REAL_BOT_DEV_REMOTE: "1", NODE_EXTRA_CA_CERTS: certPath },
    stdout: "pipe",
    stderr: "inherit",
  });
  stops.push(async () => {
    child.kill("SIGTERM");
    await child.exited;
  });
  const out = lines(child.stdout);
  const line = await out.next((l) => l.startsWith("{") && l.includes('"origin"'), 30_000);
  const mac = JSON.parse(line) as { origin: string; token: string; dataDir: string; writerDirect: string; editorDirect: string; group: string };
  if (FORBIDDEN_PORTS.has(Number(new URL(mac.origin).port))) throw new Error("the Mac took a reserved port");
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${mac.origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${mac.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (res.status === 204 ? null : await res.json()) as T;
  };
  return { ...mac, api, out };
}

/** The development remote channel (`dev-setup.ts`): length-prefixed JSON on a unix socket. */
async function devChannel(path: string) {
  const socket = createConnection(path);
  await new Promise<void>((done, fail) => {
    socket.once("connect", done);
    socket.once("error", fail);
  });
  stops.push(() => {
    socket.destroy();
  });
  return (request: unknown) =>
    new Promise<unknown>((done, fail) => {
      const payload = Buffer.from(JSON.stringify(request));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(payload.length);
      let buffer = Buffer.alloc(0);
      const finish = (settle: () => void) => {
        socket.off("data", onData);
        socket.off("error", onError);
        settle();
      };
      const onData = (bytes: Buffer) => {
        buffer = Buffer.concat([buffer, bytes]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < length + 4) return;
        const answer = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as { ok: boolean; value?: unknown; error?: string };
        finish(() => (answer.ok ? done(answer.value) : fail(new Error(answer.error ?? "remote_setup_denied"))));
      };
      const onError = (error: Error) => finish(() => fail(error));
      socket.on("data", onData);
      socket.on("error", onError);
      socket.write(Buffer.concat([prefix, payload]));
    });
}

async function field(page: Page, testID: string) {
  const box = page.locator(`[data-testid="${testID}"]`).first();
  await box.waitFor({ timeout: 20_000 });
  const tag = await box.evaluate((el) => el.tagName);
  return tag === "TEXTAREA" || tag === "INPUT" ? box : box.locator("textarea, input").first();
}

const testid = (page: Page, testID: string) => page.locator(`[data-testid="${testID}"]`);
/** Whether `text` is on screen inside `testID` (the roster's previews repeat a conversation's lines, so not the whole page). */
const shownIn = async (page: Page, testID: string, text: string) =>
  (await testid(page, testID).allInnerTexts().catch(() => [] as string[])).some((inner) => inner.includes(text));
/** Waits until the open conversation shows every one of `lines`; says what it showed instead if it never does. */
async function expectHistory(page: Page, when: string, lines: string[]): Promise<void> {
  try {
    await until(`the conversation's history ${when}`, 15_000, async () => {
      for (const line of lines) if (!(await shownIn(page, "conversation", line))) return false;
      return true;
    });
  } catch (error) {
    const seen = (await testid(page, "conversation").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ");
    throw new Error(`${error instanceof Error ? error.message : String(error)}; the conversation showed: ${seen.slice(0, 600)}`);
  }
}
/** How wide `testID` is drawn, in CSS pixels (0 when it is not there). */
const widthOf = async (page: Page, testID: string) => (await testid(page, testID).first().boundingBox().catch(() => null))?.width ?? 0;

let failed = false;
let browser: Browser | undefined;
/** What the page shows and said, once something failed. */
let onFailure: () => Promise<void> = async () => {};
try {
  if (!process.argv.includes("--no-build")) build();
  if (!existsSync(join(site, "index.html"))) throw new Error(`no package at ${site}: run without --no-build`);
  mkdirSync(shots, { recursive: true });
  const shot = (name: string) => join(shots, `${engine}-${name}.png`);

  const relayPort = await freePort();
  let edgePort = await freePort();
  while (edgePort === relayPort) edgePort = await freePort();
  const origin = `https://127.0.0.1:${edgePort}`;
  const tls = certificate(work);
  const bootstrap = base64url(randomBytes(32));
  await startRelay(origin, relayPort, bootstrap);
  const edge = startEdge({ port: edgePort, relayPort, site, tls });
  stops.push(() => {
    edge.stop(true);
  });
  step(`relay on 127.0.0.1:${relayPort}, its origin and the page at ${origin}`);

  const mac = await startMac(tls.certPath);
  step(`the Mac on ${mac.origin} (${mac.dataDir})`);
  const setup = await devChannel(devSocketPath(mac.dataDir));
  await setup({ operation: "initialize", config: { origin, relayId: RELAY_ID, hostId: ulid() }, bootstrap });
  await until("the Mac online at the relay", 20_000, async () => ((await setup({ operation: "status" })) as { state: string }).state === "online");
  step("the Mac registered with the relay and online");
  const qr = (await setup({ operation: "open_pair" })) as PairingQr;
  const code = encodePairingCode(qr);
  const fingerprint = hostSigningFingerprint(qr.hostSigningPublic);
  step(`pairing window open: ${code.slice(0, 12)}… (${code.length} characters)`);

  // @ts-expect-error -- a JavaScript entry without types of its own (they are `playwright-core`'s, above).
  const { chromium, webkit } = (await import("../../messenger/node_modules/@playwright/test/index.mjs")) as { chromium: BrowserType; webkit: BrowserType };
  browser = await (engine === "webkit" ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN" });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (m) => {
    problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
  const relayCalls: string[] = [];
  page.on("response", (r) => {
    if (RELAY_ROUTES.has(new URL(r.url()).pathname)) relayCalls.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  });
  // The links to the relay and what crossed them: text only for the relay's handshake, then
  // binary Noise frames (the page never sends the Mac a readable byte).
  const links = { opened: 0, text: 0, binarySent: 0, binaryReceived: 0 };
  page.on("websocket", (ws) => {
    if (new URL(ws.url()).pathname !== "/v1/relay/device") return;
    links.opened += 1;
    ws.on("framesent", (f) => (typeof f.payload === "string" ? (links.text += 1) : (links.binarySent += 1)));
    ws.on("framereceived", (f) => (typeof f.payload === "string" ? (links.text += 1) : (links.binaryReceived += 1)));
  });
  onFailure = async () => {
    await page.screenshot({ path: shot("failed") }).catch(() => {});
    console.log(`relay calls from the page:\n  ${relayCalls.slice(-20).join("\n  ") || "(none)"}`);
    console.log(`page console:\n  ${problems.slice(-30).join("\n  ") || "(nothing)"}`);
  };

  await page.goto(`${origin}/`);
  await testid(page, "pairing-screen").waitFor({ timeout: 30_000 });
  step("the page shows the pairing screen");
  await (await field(page, "pairing-qr")).fill(code);
  const printed = await testid(page, "host-fingerprint").innerText({ timeout: 10_000 });
  if (printed.replace(/\s/g, "") !== fingerprint) throw new Error(`fingerprint on the phone ${printed} is not the Mac's ${fingerprint}`);
  const pageOrigin = await testid(page, "pairing-origin").innerText();
  if (pageOrigin.trim() !== origin) throw new Error(`the phone reads the relay as ${pageOrigin}, not ${origin}`);
  await page.screenshot({ path: shot("1-pairing") });
  step("the code reads: the relay is the page's origin and the fingerprint is the Mac's");

  await testid(page, "pairing-submit").click();
  await testid(page, "pairing-waiting").waitFor({ timeout: 15_000 });
  step("submitted; the phone waits for the Mac");
  const prepared = await until("the device at the Mac", 30_000, async () => {
    const answer = (await setup({ operation: "prepare_pair", pairingId: qr.pairingId })) as { pending?: true; challenge?: string; name?: string; fingerprint?: string };
    return answer.pending ? null : (answer as { challenge: string; name: string; fingerprint: string });
  });
  const { display } = (await setup({ operation: "dev_describe", challenge: prepared.challenge })) as { display: string };
  step(`the Mac sees "${prepared.name}" (${display.slice(0, 60)}…)`);
  const { proof } = (await setup({ operation: "dev_authenticate", challenge: prepared.challenge })) as { proof: string };
  await setup({ operation: "confirm_pair", pairingId: qr.pairingId, proof });
  step("approved on the Mac");

  // A phone's width: the shell's roster fills the window, the bottom bar under it, no workbench.
  const row = testid(page, `session-${mac.writerDirect}`);
  await row.waitFor({ timeout: 40_000 });
  if (await testid(page, "pairing-screen").count()) throw new Error("the pairing screen is still up beside the shell");
  if (await testid(page, "sidebar-split").count()) throw new Error("a phone's roster is a column with a split");
  await page.screenshot({ path: shot("2-roster") });
  step("paired: the shell's roster came over the relay");

  await row.click();
  await testid(page, "conversation").waitFor({ timeout: 10_000 });
  await testid(page, "top-back").waitFor({ timeout: 5_000 });
  await until("the Writer's reply in the conversation", 15_000, () => shownIn(page, "conversation", "这是摘要"));
  step("opened the Writer's conversation over the roster: its history came over the relay");

  const stamp = Date.now().toString(36);
  const fromPhone = `phone-${stamp}`;
  const composer = await field(page, "composer-input");
  await composer.fill(fromPhone);
  await testid(page, "send-button").click();
  await until("the phone's line in the conversation", 15_000, () => shownIn(page, "conversation", fromPhone));
  const stored = await until("the phone's line in the Mac's database", 15_000, async () => {
    const page_ = await mac.api<{ items: Array<{ body: string; author: string }> }>("GET", `/v1/sessions/${mac.writerDirect}/messages`);
    return page_.items.find((m) => m.body === fromPhone);
  });
  step(`sent from the phone; the Mac stored it (author ${stored.author})`);

  const fromMac = `mac-${stamp}`;
  await mac.api("POST", `/v1/sessions/${mac.writerDirect}/messages`, { body: fromMac });
  await until("the Mac's line on the phone", 20_000, () => shownIn(page, "conversation", fromMac));
  step("a line written on the Mac arrived in the open conversation live");
  await Bun.sleep(1500);
  await page.screenshot({ path: shot("3-conversation") });

  const status = (await setup({ operation: "status" })) as { state: string; devices: number };
  const devices = (await setup({ operation: "list_devices" })) as { items: Array<{ name?: string }> };
  step(`the Mac: remote ${status.state}, ${status.devices} device(s) enrolled (${devices.items.map((d) => d.name).join(", ")})`);

  await testid(page, "top-back").click();
  await until("the conversation put down", 10_000, async () => (await testid(page, "conversation").count()) === 0);
  await row.waitFor({ timeout: 10_000 });
  step("Back: the conversation is put down, the roster is there");

  // The device store: a reload keeps the enrollment (IndexedDB) and links again, no pairing.
  await page.reload();
  await row.waitFor({ timeout: 40_000 });
  if (await testid(page, "pairing-screen").count()) throw new Error("the reloaded page asked to pair again");
  step("reloaded: still enrolled, the roster came back over a new link");
  await row.click();
  await testid(page, "conversation").waitFor({ timeout: 10_000 });
  await expectHistory(page, "after the reload", ["这是摘要", fromPhone, fromMac]);
  await testid(page, "top-back").click();
  await until("the conversation put down", 10_000, async () => (await testid(page, "conversation").count()) === 0);
  step("the conversation's whole history came back over the new link");

  // A tablet's width, the same page (a new context would be a new device store, unpaired): the
  // hosted shell keeps the roster as a column beside one page, and never the desktop's workbench.
  await page.setViewportSize({ width: 820, height: 1180 });
  await testid(page, "sidebar-split").waitFor({ timeout: 10_000 });
  const column = await widthOf(page, "shell-sidebar");
  if (!(column > 0 && column < 820 / 2)) throw new Error(`the roster at a tablet's width is ${column} wide, not a column`);
  if (await testid(page, "top-back").count()) throw new Error("a tablet's page has a Back to the roster beside it");
  await row.click();
  await testid(page, "conversation").waitFor({ timeout: 10_000 });
  await expectHistory(page, "at a tablet's width", ["这是摘要", fromPhone, fromMac]);
  if (await testid(page, "top-back").count()) throw new Error("a tablet's conversation has a Back");
  if (!(await row.isVisible())) throw new Error("the roster went away when a tablet opened a conversation");
  await Bun.sleep(1000);
  await page.screenshot({ path: shot("4-tablet") });
  step(`a tablet's width: the roster's column (${Math.round(column)} wide) beside the conversation, no Back, no workbench`);

  console.log(`relay links from the page: ${links.opened} opened; ${links.text} text frames (the relay's handshake), ${links.binarySent} binary sent, ${links.binaryReceived} binary received`);
  const worrying = problems.filter((line) => /^\[(error|warning|pageerror)\]/.test(line));
  console.log(`page console errors and warnings: ${worrying.length ? `\n  ${worrying.slice(0, 20).join("\n  ")}` : "none"}`);
  console.log(`relay calls from the page: ${relayCalls.length} (${[...new Set(relayCalls)].slice(0, 6).join("; ")})`);
  console.log(`ok (${engine}); screenshots in ${shots}`);
} catch (error) {
  failed = true;
  console.error(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await onFailure();
} finally {
  await browser?.close().catch(() => {});
  for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
