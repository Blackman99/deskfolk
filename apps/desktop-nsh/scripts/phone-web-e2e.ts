/**
 * The phone on NSH web end to end, all on this Mac (ADR 0107, Phase 1c). Packages the hosted build
 * (`nsh package Hosted.tsx --target web`), starts a relay of its own (`apps/relay`) behind a TLS edge
 * on a free port that also serves the package — the relay's origin, as the deployed relay serves the
 * hosted page — and an isolated Mac (`phone-runtime.ts`) on the development remote channel. It
 * registers the Mac with the relay and opens a pairing window, then drives the page in a headless
 * browser: paste the code, compare the fingerprint, submit; approve on the Mac (the development
 * stand-in for Touch ID); then the app's shell on a phone's width: the roster, the projects tab
 * with every picture drawn (Claude's logo among them, which WebKit once refused), Back stepping out
 * of settings and a Bot's settings one level at a time, a conversation over
 * it, a line sent from the phone (read back from the Mac's database), a line written on the Mac
 * arriving live, Back to the roster, a reload that is still enrolled and under the service worker
 * (`/sw.js`, which the app's realm reaches as its own); and the same page at a
 * tablet's width (the roster's column beside one page, no workbench). Screenshots go to `--shots`,
 * named after the browser. Stops everything it started. Never the stable or the dev instance,
 * never a remote host.
 *
 * The page is the one the relay serves (`phone-package.ts --build`), under the production edge's
 * headers and its content security policy: a policy violation fails the run, as does a request for
 * the chunks only a local window runs. A newer build put up while the page is open is offered, and
 * its reload keeps the device. `--edge caddy` serves through Caddy running the production
 * `deploy/remote/Caddyfile` (`CADDY_BIN`) instead of the script's own edge. `--from-svelte` pairs
 * on the messenger's hosted page (`build:hosted`) first, as a phone paired before the switch did,
 * then swaps the edge to the NSH page and reloads: the device is still enrolled. `--host localhost`
 * puts the page at an origin its meta policy does not name, as the relay's domain is not.
 *
 *   bun apps/desktop-nsh/scripts/phone-web-e2e.ts [--no-build] [--browser chromium|webkit] [--shots <dir>]
 *                                                 [--edge bun|caddy] [--from-svelte] [--host localhost]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
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
import { RELEASE_APP_NAME } from "./package";
import { ALLOWED_QUERY, certificate, RELAY_ROUTES, startCaddyEdge, startEdge } from "./phone-edge";
import { buildPhoneSite, LOCAL_ONLY_CHUNKS, PHONE_OUT, VERSION_FILE } from "./phone-package";
import { FORBIDDEN_PORTS, freePort } from "./phone-runtime";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "../..");
const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const engine = flag("browser") ?? "chromium";
const shots = resolve(flag("shots") ?? join(root, "build", "phone-shots"));
const site = join(PHONE_OUT, RELEASE_APP_NAME);
const edgeKind = flag("edge") ?? "bun";
const fromSvelte = process.argv.includes("--from-svelte");
const svelteSite = join(repo, "apps", "messenger", "build");
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

/** The hosted package, as the relay serves it; with `--from-svelte`, the messenger's hosted page too. */
function build(): void {
  buildPhoneSite();
  // `node --run`, not `pnpm --filter`: pnpm refuses a worktree whose node_modules is a link.
  if (fromSvelte) run(["node", "--run", "build:hosted"], join(repo, "apps", "messenger"));
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
  const mac = JSON.parse(line) as { origin: string; token: string; dataDir: string; writerDirect: string; editorDirect: string; group: string; claudeProject: string };
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
  if (fromSvelte && !existsSync(join(svelteSite, "index.html"))) throw new Error(`no hosted messenger at ${svelteSite}: run without --no-build`);
  if (fromSvelte && edgeKind !== "bun") throw new Error("--from-svelte swaps the page under the script's own edge: leave --edge out");
  mkdirSync(shots, { recursive: true });
  const shot = (name: string) => join(shots, `${engine}-${name}.png`);

  const relayPort = await freePort();
  let edgePort = await freePort();
  while (edgePort === relayPort) edgePort = await freePort();
  // `--host localhost`: an origin the page's own meta policy does not name (it names 127.0.0.1 for
  // the local window), so the link to the relay is allowed by `'self'` alone, as on the relay's domain.
  const origin = `https://${flag("host") ?? "127.0.0.1"}:${edgePort}`;
  if (edgeKind === "caddy" && !origin.startsWith("https://127.0.0.1:")) throw new Error("--edge caddy serves 127.0.0.1: leave --host out");
  const tls = certificate(work);
  const bootstrap = base64url(randomBytes(32));
  await startRelay(origin, relayPort, bootstrap);
  let bounceEdge: ((meanwhile: () => Promise<void>) => Promise<void>) | null = null;
  // What the edge serves: the messenger's page first with --from-svelte, until the switch below.
  let serving = fromSvelte ? svelteSite : site;
  if (edgeKind === "caddy") {
    let httpPort = await freePort();
    while (httpPort === relayPort || httpPort === edgePort) httpPort = await freePort();
    const caddy = await startCaddyEdge({ port: edgePort, httpPort, relayPort, site, tls, dir: work });
    stops.push(() => caddy.stop());
  } else if (edgeKind === "bun") {
    let edge = startEdge({ port: edgePort, relayPort, site: () => serving, tls });
    stops.push(() => {
      edge.stop(true);
    });
    // The relay out of reach for a while, as a phone's page loses it.
    bounceEdge = async (meanwhile) => {
      edge.stop(true);
      try {
        await meanwhile();
      } finally {
        edge = startEdge({ port: edgePort, relayPort, site: () => serving, tls });
      }
    };
  } else throw new Error(`--edge ${edgeKind}: bun or caddy`);
  step(`relay on 127.0.0.1:${relayPort}, its origin and the ${fromSvelte ? "messenger's" : "NSH"} page at ${origin} (${edgeKind === "caddy" ? "Caddy, the production Caddyfile" : "the script's edge, the production headers"})`);

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
  // The edge's certificate is made for the run: Chromium fetches a service worker's script only from
  // an origin whose certificate it trusts, whatever the context ignores.
  browser = await (engine === "webkit" ? webkit : chromium).launch({ headless: true, args: engine === "webkit" ? [] : ["--ignore-certificate-errors"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN" });
  // Every frame says what the policy refused: the browsers' own console lines differ, this does not.
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.effectiveDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  const problems: string[] = [];
  const localOnly: string[] = [];
  page.on("request", (r) => {
    if (LOCAL_ONLY_CHUNKS.some((id) => new URL(r.url()).pathname.includes(id.replace(/\.js$/, ""))) || new URL(r.url()).pathname.startsWith("/__local-api")) localOnly.push(r.url());
  });
  page.on("console", (m) => {
    problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
  // Every address the page goes to, the app's own included: each must pass the edge's query rule,
  // or a reload there is a 400 from the relay.
  const addresses = new Set<string>();
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) addresses.add(new URL(frame.url()).search);
  });
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
  if (fromSvelte) {
    // A phone paired before the switch: the messenger's page, its own pairing screen.
    const box = page.locator("textarea#pairing-qr");
    await box.waitFor({ timeout: 30_000 });
    step("the messenger's page shows its pairing screen");
    await box.fill(code);
    const printed = await testid(page, "host-fingerprint").innerText({ timeout: 10_000 });
    if (printed.replace(/\s/g, "") !== fingerprint) throw new Error(`fingerprint on the phone ${printed} is not the Mac's ${fingerprint}`);
    await page.screenshot({ path: shot("0-svelte-pairing") });
    await page.locator("main.pairing-screen .modal-foot button.btn-primary").click();
    step("submitted on the messenger's page; the phone waits for the Mac");
  } else {
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
  }
  const prepared = await until("the device at the Mac", 30_000, async () => {
    const answer = (await setup({ operation: "prepare_pair", pairingId: qr.pairingId })) as { pending?: true; challenge?: string; name?: string; fingerprint?: string };
    return answer.pending ? null : (answer as { challenge: string; name: string; fingerprint: string });
  });
  const { display } = (await setup({ operation: "dev_describe", challenge: prepared.challenge })) as { display: string };
  step(`the Mac sees "${prepared.name}" (${display.slice(0, 60)}…)`);
  const { proof } = (await setup({ operation: "dev_authenticate", challenge: prepared.challenge })) as { proof: string };
  await setup({ operation: "confirm_pair", pairingId: qr.pairingId, proof });
  step("approved on the Mac");

  if (fromSvelte) {
    await until("the messenger's page past pairing", 40_000, async () => (await page.locator("main.pairing-screen").count()) === 0);
    await Bun.sleep(1500);
    await page.screenshot({ path: shot("0-svelte-paired") });
    const stores = await page.evaluate(async () => ((await indexedDB.databases?.()) ?? []).map((d) => d.name));
    step(`paired on the messenger's page (its stores: ${stores.join(", ")})`);
    // The deploy: the relay's site is the NSH page from now on. The open page polls the version the
    // relay serves (`_app/version.json`, which the NSH package keeps writing), offers the reload,
    // and the reload loads the NSH page.
    serving = site;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await testid(page, "build-update").waitFor({ timeout: 35_000 });
    await page.screenshot({ path: shot("0-svelte-offers-reload") });
    await Promise.all([page.waitForEvent("load"), page.locator(".build-update-reload").click()]);
    step("the relay serves the NSH page now: the messenger's page offered a reload, and the phone took it");
  }

  // A phone's width: the shell's roster fills the window, the bottom bar under it, no workbench.
  const row = testid(page, `session-${mac.writerDirect}`);
  await row.waitFor({ timeout: 40_000 });
  if (await testid(page, "pairing-screen").count()) throw new Error("the pairing screen is still up beside the shell");
  if (await testid(page, "sidebar-split").count()) throw new Error("a phone's roster is a column with a split");
  await page.screenshot({ path: shot("2-roster") });
  step("paired: the shell's roster came over the relay");

  // Every picture on the page decodes. The logos are SVG (`glyphUri`, handed to the page as blobs):
  // WebKit draws nothing for one that repeats an attribute, as Claude's did (its own `xmlns` beside
  // the one `glyphUri` adds), where Chromium let it pass. The Claude Code session is on the projects
  // tab, which is not in the address.
  await testid(page, "nav-projects").click();
  await page.locator('[data-testid="agent-logo-claude_code"]:visible').first().waitFor({ timeout: 10_000 });
  const pictures = () =>
    page.evaluate(() =>
      [...document.images].map((img) => ({ drawn: img.complete && img.naturalWidth > 0, claude: !!img.closest('[data-testid="agent-logo-claude_code"]'), at: img.parentElement?.parentElement?.outerHTML.slice(0, 240) ?? img.src })),
    );
  const drawn = await until("the pictures decoded, Claude's logo among them", 10_000, async () => {
    const seen = await pictures();
    return seen.some((img) => img.claude) && seen.every((img) => img.drawn) ? seen : undefined;
  }).catch(async (error: Error) => {
    const seen = await pictures();
    throw new Error(`${error.message}: ${seen.filter((img) => img.claude).length} in Claude's logos; not drawn: ${seen.filter((img) => !img.drawn).map((img) => img.at).join(" | ")}`);
  });
  await page.screenshot({ path: shot("2b-projects") });
  step(`the projects tab: all ${drawn.length} pictures are drawn, Claude's logo among them`);
  await testid(page, "nav-sessions").click();
  await row.waitFor({ timeout: 10_000 });

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

  // The service worker web push and remote media go through: the page is under it after the
  // reload, and the app's realm (the hidden frame) gets it from `navigator.serviceWorker`.
  const pageWorker = await until("the page under /sw.js", 15_000, () =>
    page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
  ).catch(async (error: Error) => {
    const why = await page.evaluate(async () => {
      const registrations = (await navigator.serviceWorker.getRegistrations()).map((r) => `${r.scope} ${r.active?.state ?? r.installing?.state ?? r.waiting?.state ?? "none"}`);
      const attempt = await navigator.serviceWorker.register("/sw.js").then((r) => `registered ${r.scope}`, (e: Error) => `refused: ${e.message}`);
      return { registrations, attempt };
    });
    throw new Error(`${error.message}: ${JSON.stringify(why)}`);
  });
  if (!pageWorker.endsWith("/sw.js")) throw new Error(`the page is under ${pageWorker}, not /sw.js`);
  const appRealm = page.frames().find((frame) => frame !== page.mainFrame());
  if (!appRealm) throw new Error("no app frame in the page");
  const appWorker = await appRealm.evaluate(async () => {
    const ready = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((done) => setTimeout(() => done(null), 10_000))]);
    return { ready: ready?.active?.scriptURL ?? null, controller: navigator.serviceWorker.controller?.scriptURL ?? null, push: "pushManager" in (ready ?? {}) };
  });
  if (!appWorker.ready?.endsWith("/sw.js") || appWorker.controller !== pageWorker || !appWorker.push) {
    throw new Error(`the app's realm does not reach the page's worker: ${JSON.stringify(appWorker)}`);
  }
  for (const file of ["sw.js", "media-stream.js", "icon-192.png", "notification-badge.png", "apple-touch-icon.png"]) {
    const status = await page.evaluate(async (path) => (await fetch(path, { cache: "no-store" })).status, `/${file}`);
    if (status !== 200) throw new Error(`/${file} answers ${status}`);
  }
  step("the page is under /sw.js, and the app's realm has it ready, with push");

  // A newer build put up while the page is open: offered, and its reload keeps the device. The
  // page checks on coming back into view as well as every 30 s; the frame's document stands in.
  const versionPath = join(site, VERSION_FILE);
  const served = readFileSync(versionPath, "utf8");
  writeFileSync(versionPath, `${JSON.stringify({ version: "e2e-newer" })}\n`);
  try {
    await appRealm.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await testid(page, "build-update").waitFor({ timeout: 35_000 });
    await page.screenshot({ path: shot("3b-build-update") });
    step("a newer build on the relay: the page offers a reload");
  } finally {
    writeFileSync(versionPath, served);
  }
  await Promise.all([page.waitForEvent("load"), testid(page, "build-update-reload").click()]);
  await row.waitFor({ timeout: 40_000 });
  if (await testid(page, "pairing-screen").count()) throw new Error("the page reloaded for a new build asked to pair again");
  await Bun.sleep(1000);
  if (await testid(page, "build-update").count()) throw new Error("the reloaded page still offers a build it is running");
  step("reloaded for the new build: still enrolled, nothing more offered");

  // The address and Back at a phone's width (`platform/page-route.ts`, the Svelte page's routing).
  const here = () => {
    const url = new URL(page.url());
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const writerAt = `/?s=${mac.writerDirect}`;
  const expectAt = (what: string, path: string) =>
    until(`${what} at ${path}`, 10_000, () => here() === path).catch((error: Error) => {
      throw new Error(`${error.message}: the page is at ${here()}`);
    });
  const putAway = (id: string) => until(`${id} put away`, 10_000, async () => (await testid(page, id).count()) === 0);
  const showing = (id: string, ms = 10_000) => testid(page, id).first().waitFor({ timeout: ms });
  // NSH writes a sheet's (a modal's) history entry a turn after it opens, on a timer the headless
  // browser can hold back for most of a second; a Back before it would be the screen's own.
  // The relay lets an address through 10 handshakes a minute (`LIMITS.handshakesPerMinute`), and
  // here the page's links and the Mac's share one, loopback: two a load. The loads below run past
  // it, a try fails as unreachable and waits for Retry, which is pressed here, and said. A phone
  // and its Mac are two addresses, and a page loaded that often is what the limit is for.
  let retried = 0;
  const showingAfterLoad = (id: string) => {
    let pressedAt = 0;
    return until(`${id} after a new load`, 45_000, async () => {
      if ((await testid(page, id).count()) > 0) return true;
      // Once the try has failed, and not again while the next one is under way.
      const retry = testid(page, "retry-connection");
      if (Date.now() - pressedAt > 8_000 && (await retry.count())) {
        pressedAt = Date.now();
        retried += 1;
        await retry.first().click().catch(() => {});
      }
      return false;
    });
  };
  const sheetEntry = () => until("the sheet's history entry", 5_000, () => page.evaluate(() => ((history.state as { nsh?: number } | null)?.nsh ?? 0) >= 1));
  await row.waitFor({ timeout: 10_000 });
  await expectAt("the roster", "/");
  await row.click();
  await showing("conversation");
  await expectAt("a conversation", writerAt);
  await page.goBack();
  await putAway("conversation");
  await expectAt("Back to the roster", "/");
  await page.goForward();
  await showing("conversation");
  await expectAt("Forward to the conversation", writerAt);
  step("a conversation has its address: the browser's Back closes it, Forward opens it again");
  const entries = await page.evaluate(() => history.length);
  await testid(page, "top-back").click();
  await putAway("conversation");
  await expectAt("the page's own Back", "/");
  if ((await page.evaluate(() => history.length)) !== entries) throw new Error("the page's own Back left an entry behind");
  step("the page's own Back walks history back, leaving no entry to bounce into");

  await row.click();
  await showing("conversation");
  await testid(page, "top-more").click();
  await showing("mobile-actions-menu");
  await sheetEntry();
  await page.goBack();
  await putAway("mobile-actions-menu");
  if (!(await testid(page, "conversation").count())) throw new Error("Back closed the conversation with the sheet");
  await page.goBack();
  await putAway("conversation");
  await expectAt("Back after the sheet", "/");
  step("Back closes the conversation's sheet first, then the conversation");

  await row.click();
  await showing("conversation");
  await testid(page, "top-more").click();
  await showing("mobile-actions-menu");
  await testid(page, "mobile-trace").click();
  await showing("trace-pane");
  await until("the flow page's address", 10_000, () => new URL(page.url()).searchParams.get("o") === "trace");
  // The job it settles on goes into the address (`k`): a reload there comes back to it, through the edge.
  await Bun.sleep(1500);
  const flowAt = here();
  const withJob = new URL(page.url()).searchParams.has("k");
  if (withJob) {
    await page.reload();
    await showingAfterLoad("trace-pane");
    await expectAt("the reloaded flow page", flowAt);
  }
  await page.goBack();
  await putAway("trace-pane");
  await expectAt("Back from the flow page", writerAt);
  await page.goBack();
  await putAway("conversation");
  await expectAt("Back to the roster", "/");
  step(`the flow page has its address${withJob ? " with its job, which a reload comes back to" : ""}: Back to the conversation, then to the roster`);

  await testid(page, "nav-settings").click();
  await showing("settings-modal");
  await expectAt("settings", "/?o=settings");
  await sheetEntry();
  await page.goBack();
  await putAway("settings-modal");
  await expectAt("Back from settings", "/");
  await row.waitFor({ timeout: 5_000 });
  step("settings has its address: one Back closes it, and the page stays");

  // Settings on a phone drills down: the list of tabs, a tab, a section of it. The browser's Back
  // steps out one level at a time, as the page's own ‹ does, and only off the list closes settings.
  await testid(page, "nav-settings").click();
  await showing("settings-modal");
  await expectAt("settings", "/?o=settings");
  await sheetEntry();
  await testid(page, "settings-tab-models").click();
  await showing("section-endpoints");
  await testid(page, "section-endpoints").click();
  await showing("models-panel");
  // The endpoint editor is a page over it with pages of its own: the connector tiles, a
  // connector's form. Back steps out of the form to the tiles, then closes the editor.
  const depth = (at: number) => until(`history at depth ${at}`, 5_000, () => page.evaluate((n) => ((history.state as { nsh?: number } | null)?.nsh ?? 0) === n, at));
  const deep = await page.evaluate(() => history.length);
  await testid(page, "provider-add").click();
  await showing("connector-pick-custom");
  await depth(2);
  await testid(page, "connector-pick-custom").click();
  await putAway("connector-pick-custom");
  await page.goBack();
  await showing("connector-pick-custom");
  await depth(2);
  await page.goBack();
  await putAway("provider-editor");
  await showing("models-panel");
  await expectAt("Back out of the endpoint editor", "/?o=settings");
  await depth(1);
  await page.goBack();
  await putAway("models-panel");
  await showing("section-endpoints");
  await expectAt("Back from a section", "/?o=settings");
  await sheetEntry();
  await page.goBack();
  await putAway("settings-models");
  await showing("settings-nav");
  await expectAt("Back from a tab", "/?o=settings");
  await sheetEntry();
  // Each Back the dialog took as a step gets its entry again, and leaves no more behind.
  const after = await page.evaluate(() => history.length);
  if (after !== deep) throw new Error(`stepping back in settings left history at ${after} entries, from ${deep}`);
  await page.goBack();
  await putAway("settings-modal");
  await expectAt("Back off the list of tabs", "/");
  await row.waitFor({ timeout: 5_000 });
  step("settings steps back one level at a time: the endpoint editor's form, the editor, a section, its tab, then settings itself");

  // A Bot's settings drill down the same way: its sections, one of them; then the conversation.
  await row.click();
  await showing("conversation");
  await testid(page, "top-more").click();
  await showing("mobile-actions-menu");
  await testid(page, "mobile-settings").click();
  await showing("bot-nav");
  const botSettingsAt = here();
  await sheetEntry();
  await testid(page, "bot-tab-basics").click();
  await showing("bot-detail");
  await page.goBack();
  await putAway("bot-detail");
  await showing("bot-nav");
  await expectAt("Back from a Bot's section", botSettingsAt);
  await sheetEntry();
  await page.goBack();
  await putAway("session-settings-drawer");
  await showing("conversation");
  await expectAt("Back out of a Bot's settings", writerAt);
  await page.goBack();
  await putAway("conversation");
  await expectAt("Back to the roster", "/");
  step("a Bot's settings step back one level at a time too: a section, the settings, then the conversation");

  // Another conversation than the Writer's, whose rows the steps above went through.
  const editorRow = testid(page, `session-${mac.editorDirect}`);
  const editorAt = `/?s=${mac.editorDirect}`;
  await editorRow.click();
  await showing("conversation");
  await expectAt("the Editor's conversation", editorAt);
  await page.reload();
  await showingAfterLoad("conversation");
  await expectAt("the reloaded conversation", editorAt);
  step("a reload inside a conversation comes back to it");
  await page.goto(`${origin}${editorAt}`);
  await showingAfterLoad("conversation");
  await page.goBack();
  await putAway("conversation");
  await expectAt("Back from a link's first entry", "/");
  await row.waitFor({ timeout: 5_000 });
  step(`a link to a conversation: Back goes to the roster, not out of the page${retried ? ` (Retry pressed ${retried}×: the relay's handshakes a minute, loopback's for the page and the Mac both)` : ""}`);

  // Another tab of the page: it waits behind this one until asked to take the device's link over.
  const second = await context.newPage();
  await second.goto(`${origin}/`);
  await testid(second, "tab-standby").waitFor({ timeout: 30_000 });
  await testid(second, "tab-takeover").click();
  await testid(second, `session-${mac.writerDirect}`).waitFor({ timeout: 40_000 });
  await testid(page, "tab-standby").waitFor({ timeout: 20_000 });
  await second.close();
  await testid(page, "tab-takeover").click();
  await row.waitFor({ timeout: 40_000 });
  step("a second tab waits behind the first; taking over moves the link, and back again");

  if (bounceEdge) {
    await bounceEdge(async () => {
      await until("the lost connection said over the shell", 30_000, async () => (await testid(page, "connecting").count()) + (await testid(page, "unreachable").count()) > 0);
      if (!(await row.isVisible())) throw new Error("the shell went away with the connection");
      await page.screenshot({ path: shot("3c-offline") });
    });
    // Retry once a try has failed, and seldom: each try is two handshakes of the relay's 10 a minute here.
    let pressedAt = 0;
    await until("the link back", 120_000, async () => {
      const retry = testid(page, "retry-connection");
      if (Date.now() - pressedAt > 20_000 && (await retry.count())) {
        pressedAt = Date.now();
        await retry.first().click().catch(() => {});
      }
      return (await testid(page, "connecting").count()) + (await testid(page, "unreachable").count()) === 0;
    });
    step("the relay out of reach: the shell stays under the banner, which goes once the link is back");
  }

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

  const refused = problems.filter((line) => /CSP violation|Content Security Policy|Refused to (?:load|execute|compile|connect|apply|frame|create)/i.test(line));
  if (refused.length) throw new Error(`the page broke the production policy:\n  ${refused.slice(0, 20).join("\n  ")}`);
  if (localOnly.length) throw new Error(`the page asked for what only a local window runs: ${localOnly.join(", ")}`);
  const refusedQueries = [...addresses].filter((search) => search !== "" && !ALLOWED_QUERY.test(search.slice(1)));
  if (refusedQueries.length) throw new Error(`the page wrote addresses the edge refuses on a reload: ${refusedQueries.join(", ")}`);
  step(`no policy violation, no request for the local endpoint's code; ${addresses.size} addresses, each one the edge lets through`);

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
