/**
 * The phone on NSH web end to end, all on this Mac (ADR 0107, Phase 1c). Packages the hosted build
 * (`nsh package Hosted.tsx --target web`), starts a relay of its own (`apps/relay`) behind a TLS edge
 * on a free port that also serves the package — the relay's origin, as the deployed relay serves the
 * hosted page — and an isolated Mac (`phone-runtime.ts`) on the development remote channel. It
 * registers the Mac with the relay and opens a pairing window, then drives the page in a headless
 * browser: paste the code, compare the fingerprint, submit; approve on the Mac (the development
 * stand-in for Touch ID); then the app's shell on a phone's width: the roster, the projects tab
 * with every picture drawn (Claude's logo among them, which WebKit once refused), Back stepping out
 * of settings and a Bot's settings one level at a time (in Chromium the browser's own Back, which
 * passes over entries written with nothing pressed, and in settings Back after Back with nothing
 * pressed between, as on a phone, the page staying), a conversation over
 * it, its code block and table scrolling sideways while a vertical swipe on them still scrolls the
 * conversation, its code and a command's output in GitHub's colours, a line sent from the phone (read back from the Mac's database), a line written on the Mac
 * arriving live, Back to the roster, a reload that is still enrolled and under the service worker
 * (`/sw.js`, which the app's realm reaches as its own), a project session read back past its first
 * page that keeps the reader's place when a line comes into another conversation and when the relay
 * goes out of reach and the link comes back to the snapshot; and the same page at a tablet's width (the roster's column beside one page, no workbench). Screenshots go to `--shots`,
 * named after the browser. Stops everything it started. Never the stable or the dev instance,
 * never a remote host.
 *
 * The page is the one the relay serves (`phone-package.ts --build`), under the production edge's
 * headers and its content security policy: a policy violation fails the run, as does a request for
 * the chunks only a local window runs. A newer build put up while the page is open is offered, and
 * its reload keeps the device. `--edge caddy` serves through Caddy running the production
 * `deploy/remote/Caddyfile` (`CADDY_BIN`) instead of the script's own edge. `--host localhost`
 * puts the page at an origin its meta policy does not name, as the relay's domain is not.
 *
 *   bun apps/desktop-nsh/scripts/phone-web-e2e.ts [--no-build] [--browser chromium|webkit] [--shots <dir>]
 *                                                 [--edge bun|caddy] [--host localhost]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Playwright's types straight from `playwright-core` in pnpm's store: TypeScript does not follow
// the package's `@playwright/test` symlink for a relative import, so its `export * from
// "playwright/test"` resolves to nothing from here. The browsers come from this package's
// `@playwright/test` at run time (Bun follows the symlink), below.
import type { Browser, BrowserContext, BrowserType, Page, Worker } from "../../../node_modules/.pnpm/node_modules/playwright-core";
import { devSocketPath } from "../../daemon/src/remote/dev-setup";
import { ulid } from "../../daemon/src/ids";
import { hostSigningFingerprint } from "../app/src/m/remote/fingerprint.ts";
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

/** The hosted package, as the relay serves it. */
function build(): void {
  buildPhoneSite();
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
let persistent: BrowserContext | undefined;
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
  // `--host localhost`: an origin the page's own meta policy does not name (it names 127.0.0.1 for
  // the local window), so the link to the relay is allowed by `'self'` alone, as on the relay's domain.
  const origin = `https://${flag("host") ?? "127.0.0.1"}:${edgePort}`;
  if (edgeKind === "caddy" && !origin.startsWith("https://127.0.0.1:")) throw new Error("--edge caddy serves 127.0.0.1: leave --host out");
  const tls = certificate(work);
  const bootstrap = base64url(randomBytes(32));
  await startRelay(origin, relayPort, bootstrap);
  let bounceEdge: ((meanwhile: () => Promise<void>) => Promise<void>) | null = null;
  if (edgeKind === "caddy") {
    let httpPort = await freePort();
    while (httpPort === relayPort || httpPort === edgePort) httpPort = await freePort();
    const caddy = await startCaddyEdge({ port: edgePort, httpPort, relayPort, site, tls, dir: work });
    stops.push(() => caddy.stop());
  } else if (edgeKind === "bun") {
    let edge = startEdge({ port: edgePort, relayPort, site: () => site, tls });
    stops.push(() => {
      edge.stop(true);
    });
    // The relay out of reach for a while, as a phone's page loses it.
    bounceEdge = async (meanwhile) => {
      edge.stop(true);
      try {
        await meanwhile();
      } finally {
        edge = startEdge({ port: edgePort, relayPort, site: () => site, tls });
      }
    };
  } else throw new Error(`--edge ${edgeKind}: bun or caddy`);
  step(`relay on 127.0.0.1:${relayPort}, its origin and the NSH page at ${origin} (${edgeKind === "caddy" ? "Caddy, the production Caddyfile" : "the script's edge, the production headers"})`);

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
  const { chromium, webkit } = (await import("../node_modules/@playwright/test/index.mjs")) as { chromium: BrowserType; webkit: BrowserType };
  // The edge's certificate is made for the run: Chromium fetches a service worker's script only from
  // an origin whose certificate it trusts, whatever the context ignores.
  // A phone's screen: touches, which NSH's web runtime scrolls natively (without them its lists
  // scroll as a desktop browser's do).
  const screen = { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", hasTouch: true };
  // Chromium's Back is the browser's own, as a phone's Back button or gesture is: it passes over the
  // entries a page added with no tap since the last Back (Chromium's history intervention), where
  // `page.goBack()` goes to the previous entry whatever it is. Only an extension's
  // `chrome.tabs.goBack` reaches that Back here, and an extension needs the full Chromium, launched
  // with a profile of its own.
  let context: BrowserContext;
  let backWorker: Worker | undefined;
  if (engine === "webkit") {
    browser = await webkit.launch({ headless: true });
    context = await browser.newContext(screen);
  } else {
    const extension = join(work, "browser-back");
    mkdirSync(extension);
    writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "browser-back", version: "1", background: { service_worker: "back.js" } }));
    writeFileSync(join(extension, "back.js"), "self.browserBack = async () => { const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.goBack(tab.id); };\n");
    context = persistent = await chromium.launchPersistentContext(join(work, "profile"), {
      ...screen,
      channel: "chromium",
      headless: true,
      args: ["--ignore-certificate-errors", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    backWorker = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension:")) ?? (await context.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith("chrome-extension:") }));
  }
  // A fetch of a `blob:` address breaks the policy (`connect-src` names none) and was seen twice in
  // 2026-11-18's runs without its caller: say who asked, beside the refusal.
  await context.addInitScript(() => {
    const real = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("blob:")) console.log(`blob fetch in ${location.href.slice(0, 60)}: ${(new Error().stack ?? "").split("\n").slice(1, 7).map((l) => l.trim().slice(0, 90)).join(" < ")}`);
      return real(input, init);
    }) as typeof fetch;
  });
  // Every frame says what the policy refused: the browsers' own console lines differ, this does not.
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.effectiveDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  /**
   * The browser's Back (Chromium: its own, through the extension; WebKit: the previous entry). With
   * nothing of the page's left to go back to, a phone's Back leaves the page, or the installed app;
   * here the entry before the page shows it.
   */
  const back = async () => {
    if (!backWorker) {
      await page.goBack();
      return;
    }
    const went = await backWorker.evaluate(() => (self as unknown as { browserBack(): Promise<void> }).browserBack()).then(
      () => null,
      (error: Error) => error.message.split("\n")[0],
    );
    if (went) throw new Error(`the browser's Back has nowhere to go: a phone's would close the page (${went})`);
    await Bun.sleep(150);
    if (!page.url().startsWith(origin)) throw new Error(`the browser's Back left the page for ${page.url()}: the page's entries were all ones it wrote with no tap`);
  };
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

  // One tab (the extension's Back goes to the active one), and an entry before the page: where a
  // Back that leaves it lands.
  for (const other of context.pages()) if (other !== page) await other.close();
  await page.goto("data:text/html,<title>before the page</title>");
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

  // The reply's code block and table are wider than a phone: each scrolls sideways in a scroll view
  // of its own. A vertical swipe that starts on one still scrolls the conversation (NSH's
  // `overscroll-behavior: contain` kept it there, and the conversation stood still), a sideways one
  // the block (`PAGE_STYLE`). Chromium swipes by touch (DevTools' gestures); WebKit here has no
  // touch scrolling to drive, so there the rule itself is checked.
  const sideways = '[data-testid="conversation"] .nsh-scroll.nsh-ox';
  const wideViews = await until("the reply's code block and table, wider than the phone", 10_000, async () => {
    const seen = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.scrollWidth > el.clientWidth + 4).map((el) => getComputedStyle(el).overscrollBehaviorY), sideways);
    return seen.length >= 2 ? seen : undefined;
  });
  if (wideViews.some((v) => v !== "auto")) throw new Error(`a sideways scroll view keeps vertical swipes (overscroll-behavior-y ${wideViews.join(", ")})`);
  if (engine === "chromium") {
    const cdp = await context.newCDPSession(page);
    const transcript = () =>
      page.evaluate(() => {
        const list = [...document.querySelectorAll('[data-testid="conversation"] .nsh-scroll.nsh-oy')].find((el) => el.scrollHeight > el.clientHeight + 4);
        return list ? list.scrollTop : null;
      });
    await until("the conversation's history taller than the phone", 10_000, async () => (await transcript()) !== null).catch(async (error: Error) => {
      const lists = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="conversation"] .nsh-scroll')].map((el) => `${String((el as HTMLElement).className)} ${el.scrollHeight}/${el.clientHeight} ${el.scrollWidth}/${el.clientWidth}`),
      );
      throw new Error(`${error.message}: its scroll views ${lists.join(" | ")}`);
    });
    /** Puts the `n`th sideways view a third of the way down the conversation; its middle, to swipe on. */
    const bring = async (n: number) => {
      await page.evaluate(
        ([sel, i]) => {
          const list = [...document.querySelectorAll('[data-testid="conversation"] .nsh-scroll.nsh-oy')].find((el) => el.scrollHeight > el.clientHeight + 4);
          const view = [...document.querySelectorAll(sel as string)].filter((el) => el.scrollWidth > el.clientWidth + 4)[i as number];
          if (list && view) list.scrollTop += view.getBoundingClientRect().top - (list.getBoundingClientRect().top + list.clientHeight / 3);
        },
        [sideways, n],
      );
      await Bun.sleep(400);
      return page.evaluate(
        ([sel, i]) => {
          const r = [...document.querySelectorAll(sel as string)].filter((el) => el.scrollWidth > el.clientWidth + 4)[i as number]!.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        [sideways, n],
      );
    };
    for (const [n, what] of [[0, "code block"], [1, "table"]] as const) {
      const { x, y } = await bring(n);
      const before = await transcript();
      if (before === null) throw new Error("the conversation has nothing to scroll: the reply's history did not fill it");
      await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: 200, gestureSourceType: "touch", speed: 800 });
      await Bun.sleep(400);
      const after = (await transcript())!;
      if (Math.abs(after - before) < 100) throw new Error(`a vertical swipe on the reply's ${what} moved the conversation ${Math.round(after - before)} px`);
    }
    const { x, y } = await bring(0);
    const left = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.scrollWidth > el.clientWidth + 4)[0]!.scrollLeft, sideways);
    const leftBefore = await left();
    await cdp.send("Input.synthesizeScrollGesture", { x, y, xDistance: -200, gestureSourceType: "touch", speed: 800 });
    await Bun.sleep(400);
    if ((await left()) - leftBefore < 100) throw new Error(`a sideways swipe on the code block moved it ${Math.round((await left()) - leftBefore)} px`);
    await cdp.detach();
  }
  step(`the reply's code block and table scroll sideways; a vertical swipe on them scrolls the conversation${engine === "chromium" ? " (touch swipes)" : " (the page's rule; no touch swipes in WebKit here)"}`);

  // Code in GitHub's colours, as on the Mac: the page fetches giallo's grammars and themes from the
  // relay (`nsh-giallo.<hash>.bin`, the runtime's data `giallo`) once the app has started, and what
  // shows code draws it again. Before, the web had none: the reply's code took NSH's own colours and
  // a command's output none. The reply's code block, then the output of the command its turn ran.
  const keyword = "rgb(215, 58, 73)"; // GitHub light's keyword red, #D73A49
  const colourOf = (word: string, within: string) =>
    page.evaluate(
      ([w, sel]) => {
        // A run of one colour may hold several words (`export const`).
        const leaf = [...(document.querySelector(sel!)?.querySelectorAll("*") ?? [])].find((e) => e.childElementCount === 0 && (e.textContent ?? "").trim().split(/\s+/).includes(w!));
        return leaf ? getComputedStyle(leaf).color : null;
      },
      [word, within],
    );
  const inGitHubColours = async (what: string, word: string, within: string) =>
    until(`${what} in GitHub's colours`, 15_000, async () => (await colourOf(word, within)) === keyword).catch(async (error: Error) => {
      const shown = await page.evaluate(
        (sel) => [...(document.querySelector(sel)?.querySelectorAll("*") ?? [])].filter((e) => e.childElementCount === 0).slice(0, 8).map((e) => `${JSON.stringify(e.textContent?.slice(0, 24))} ${getComputedStyle(e).color}`),
        within,
      );
      throw new Error(`${error.message}: \`${word}\` is ${(await colourOf(word, within)) ?? "not there"}; it shows ${shown.join(" | ")}`);
    });
  await inGitHubColours("the reply's code block", "const", '[data-testid="conversation"]');
  await testid(page, "command-summary").first().click();
  await testid(page, "command-line").first().click();
  await testid(page, "command-output").first().waitFor({ timeout: 10_000 });
  await inGitHubColours("the command's output", "export", '[data-testid="command-output"]');
  step("code in GitHub's colours, as on the Mac: the reply's code block and a command's output (`cat src/summary.ts`)");

  // The command's card and its opened output are vertical scroll views inside the conversation,
  // short enough here to have nothing to scroll: a vertical swipe on either scrolls the conversation
  // too (`PAGE_STYLE`; NSH's `contain` kept it on them).
  const heldOn = await page.evaluate(() =>
    ["command-output", "command-line"].map((id) => {
      const view = document.querySelector(`[data-testid="${id}"]`)?.closest(".nsh-scroll");
      return view ? getComputedStyle(view).overscrollBehaviorY : "missing";
    }),
  );
  if (heldOn.some((v) => v !== "auto")) throw new Error(`the command's card or output keeps vertical swipes (overscroll-behavior-y ${heldOn.join(", ")})`);
  if (engine === "chromium") {
    const cdp = await context.newCDPSession(page);
    const conversationTop = () =>
      page.evaluate(() => {
        const list = [...document.querySelectorAll('[data-testid="conversation"] .nsh-scroll.nsh-oy')].find((el) => el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 300);
        return list ? list.scrollTop : null;
      });
    for (const id of ["command-output", "command-line"]) {
      // A third of the way down the conversation, clear of the composer.
      await page.evaluate((tid) => {
        const el = document.querySelector(`[data-testid="${tid}"]`)!;
        const list = [...document.querySelectorAll('[data-testid="conversation"] .nsh-scroll.nsh-oy')].find((x) => x.scrollHeight > x.clientHeight + 4 && x.clientHeight > 300)!;
        list.scrollTop += el.getBoundingClientRect().top - (list.getBoundingClientRect().top + list.clientHeight / 3);
      }, id);
      await Bun.sleep(400);
      const box = (await testid(page, id).first().boundingBox())!;
      const before = (await conversationTop())!;
      await cdp.send("Input.synthesizeScrollGesture", { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 20), yDistance: 200, gestureSourceType: "touch", speed: 800 });
      await Bun.sleep(400);
      const moved = (await conversationTop())! - before;
      if (Math.abs(moved) < 100) throw new Error(`a vertical swipe on the ${id} moved the conversation ${Math.round(moved)} px`);
    }
    await cdp.detach();
  }
  step(`a vertical swipe on the command's card and its opened output scrolls the conversation too${engine === "chromium" ? " (touch swipes)" : " (the page's rule)"}`);

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
  let reloadedAt = 0;
  const showingAfterLoad = (id: string) => {
    let pressedAt = 0;
    let pressed = 0;
    return until(`${id} after a new load`, 45_000, async () => {
      if ((await testid(page, id).count()) > 0) return true;
      // Once the try has failed, and not again while the next one is under way.
      const retry = testid(page, "retry-connection");
      if (Date.now() - pressedAt > 8_000 && (await retry.count())) {
        pressedAt = Date.now();
        retried += 1;
        pressed += 1;
        await retry.first().click().catch(() => {});
      }
      return false;
    }).catch((error: Error) => {
      throw new Error(`${error.message} (Retry pressed ${pressed}× for this load; the page is at ${here()})`);
    });
  };
  const sheetEntry = () => until("the sheet's history entry", 5_000, () => page.evaluate(() => ((history.state as { nsh?: number } | null)?.nsh ?? 0) >= 1));
  await row.waitFor({ timeout: 10_000 });
  await expectAt("the roster", "/");
  await row.click();
  await showing("conversation");
  await expectAt("a conversation", writerAt);
  await back();
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
  await back();
  await putAway("mobile-actions-menu");
  if (!(await testid(page, "conversation").count())) throw new Error("Back closed the conversation with the sheet");
  await back();
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
  await back();
  await putAway("trace-pane");
  await expectAt("Back from the flow page", writerAt);
  await back();
  await putAway("conversation");
  await expectAt("Back to the roster", "/");
  step(`the flow page has its address${withJob ? " with its job, which a reload comes back to" : ""}: Back to the conversation, then to the roster`);

  await testid(page, "nav-settings").click();
  await showing("settings-modal");
  await expectAt("settings", "/?o=settings");
  await sheetEntry();
  await back();
  await putAway("settings-modal");
  await expectAt("Back from settings", "/");
  await row.waitFor({ timeout: 5_000 });
  step("settings has its address: one Back closes it, and the page stays");

  // Settings is one of the bottom bar's places: no head over its list, the bar under it, and the
  // bar leaves it for another place, after which Back still stays on the page.
  await testid(page, "nav-settings").click();
  await showing("settings-nav");
  await expectAt("settings from the bar", "/?o=settings");
  await sheetEntry();
  if (await testid(page, "settings-root-close").count()) throw new Error("settings' list on a phone still has its head");
  await showing("mobile-nav");
  if ((await testid(page, "mobile-nav").count()) !== 1) throw new Error("two bottom bars under settings' list");
  await page.screenshot({ path: shot("3d-settings-list") });
  await testid(page, "nav-projects").click();
  await putAway("settings-modal");
  await expectAt("the bar out of settings", "/");
  await testid(page, "nav-sessions").click();
  await row.waitFor({ timeout: 5_000 });
  await row.click();
  await showing("conversation");
  await back();
  await putAway("conversation");
  await row.waitFor({ timeout: 5_000 });
  await expectAt("Back after leaving settings by the bar", "/");
  step("settings is one of the bottom bar's places: no head over its list, the bar under it; the bar leaves it, and Back stays on the page");

  // Settings on a phone drills down: the list of tabs, a tab, a section of it. Each page opened
  // has an entry of its own, settings' address with `#l<depth>`, so the browser's Back steps out
  // one level at a time, as the page's own ‹ does, and only off the list closes settings.
  await testid(page, "nav-settings").click();
  await showing("settings-modal");
  await expectAt("settings", "/?o=settings");
  await sheetEntry();
  await testid(page, "settings-tab-models").click();
  await showing("section-endpoints");
  await expectAt("a tab of settings", "/?o=settings#l1");
  await testid(page, "section-endpoints").click();
  await showing("models-panel");
  await expectAt("a section of a tab", "/?o=settings#l2");
  // The endpoint editor is a page over it with pages of its own: the connector tiles, a
  // connector's form. Back steps out of the form to the tiles, then closes the editor.
  const depth = (at: number) => until(`history at depth ${at}`, 5_000, () => page.evaluate((n) => ((history.state as { nsh?: number } | null)?.nsh ?? 0) === n, at));
  await testid(page, "provider-add").click();
  await showing("connector-pick-custom");
  await depth(2);
  await testid(page, "connector-pick-custom").click();
  await putAway("connector-pick-custom");
  await expectAt("a connector's form", "/?o=settings#l3");
  const deep = await page.evaluate(() => history.length);
  await back();
  await showing("connector-pick-custom");
  await depth(2);
  await expectAt("Back to the connector tiles", "/?o=settings#l2");
  await back();
  await putAway("provider-editor");
  await showing("models-panel");
  await expectAt("Back out of the endpoint editor", "/?o=settings#l2");
  await depth(1);
  await back();
  await putAway("models-panel");
  await showing("section-endpoints");
  await expectAt("Back from a section", "/?o=settings#l1");
  await back();
  await putAway("settings-models");
  await showing("settings-nav");
  await expectAt("Back from a tab", "/?o=settings");
  await sheetEntry();
  // Back goes over the entries the presses wrote, and writes none of its own.
  const after = await page.evaluate(() => history.length);
  if (after !== deep) throw new Error(`stepping back in settings left history at ${after} entries, from ${deep}: a Back wrote one`);
  await back();
  await putAway("settings-modal");
  await expectAt("Back off the list of tabs", "/");
  await row.waitFor({ timeout: 5_000 });
  step("settings steps back one level at a time: the endpoint editor's form, the editor, a section, its tab, then settings itself");

  // Escape (the shell's shortcut, before any dialog's) steps the endpoint editor back a page as its ‹
  // does, going back over that page's entry, and closes it from its first; Back then goes on from
  // the section. On a tab it closes settings.
  await testid(page, "nav-settings").click();
  await showing("settings-modal");
  await sheetEntry();
  await testid(page, "settings-tab-models").click();
  await testid(page, "section-endpoints").click();
  await testid(page, "provider-add").click();
  await showing("connector-pick-custom");
  await depth(2);
  await testid(page, "connector-pick-custom").click();
  await putAway("connector-pick-custom");
  await expectAt("a connector's form again", "/?o=settings#l3");
  // Escape in a field only leaves it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await showing("connector-pick-custom");
  await expectAt("Escape out of a connector's form", "/?o=settings#l2");
  await depth(2);
  await page.keyboard.press("Escape");
  await putAway("provider-editor");
  await showing("models-panel");
  await expectAt("Escape out of the endpoint editor", "/?o=settings#l2");
  await depth(1);
  await back();
  await showing("section-endpoints");
  await expectAt("Back after Escape", "/?o=settings#l1");
  await page.keyboard.press("Escape");
  await putAway("settings-modal");
  await row.waitFor({ timeout: 5_000 });
  await expectAt("Escape out of settings from a tab", "/");
  step("Escape steps the endpoint editor back a page and then closes it, Back goes on from the section, and Escape on a tab closes settings");

  // The same walk as a phone does it: Back after Back, nothing pressed between. Playwright's
  // `evaluate`, and every locator query, runs as a user gesture in Chromium (`userGesture: true`),
  // which is a tap to the history intervention: the checks above, between their Backs, keep the
  // page's entries from ever being passed over. Here the page is only read through a session of
  // our own, without a gesture.
  if (backWorker) {
    const quiet = await context.newCDPSession(page);
    const read = async <T>(expression: string): Promise<T> => ((await quiet.send("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value: T } }).result.value;
    const shownQuietly = (id: string) => `(() => { const el = document.querySelector('[data-testid="${id}"]'); return !!el && el.checkVisibility() && el.getBoundingClientRect().width > 0; })()`;
    const goneQuietly = (id: string) => `!document.querySelector('[data-testid="${id}"]')`;
    const nshDepth = "(history.state?.nsh ?? 0)";
    /** Back after Back, each to the screen `there` says, read with no gesture. */
    const walkBack = async (name: string, walk: Array<[string, string]>) => {
      // Whatever NSH writes a turn after the last press: as a person's first Back would come.
      await Bun.sleep(400);
      for (const [what, there] of walk) {
        await back();
        await until(`Back to ${what}`, 10_000, () => read<boolean>(there)).catch((error: Error) => {
          throw new Error(`${error.message} (${name}, Back after Back with nothing pressed between): the page is at ${here()}`);
        });
        await Bun.sleep(400);
      }
    };
    const theList = `${shownQuietly("settings-nav")} && ${goneQuietly("settings-main")}`;
    const theRoster = `${goneQuietly("settings-modal")} && ${shownQuietly(`session-${mac.writerDirect}`)}`;
    const openSettings = async () => {
      await testid(page, "nav-settings").click();
      await showing("settings-modal");
      await sheetEntry();
    };

    await openSettings();
    await testid(page, "settings-tab-models").click();
    await showing("section-endpoints");
    await testid(page, "section-endpoints").click();
    await showing("models-panel");
    await testid(page, "provider-add").click();
    await showing("connector-pick-custom");
    await depth(2);
    await testid(page, "connector-pick-custom").click();
    await putAway("connector-pick-custom");
    await walkBack("Models", [
      ["the connector tiles", shownQuietly("connector-pick-custom")],
      ["the editor closed", `${goneQuietly("provider-editor")} && ${shownQuietly("models-panel")} && ${nshDepth} === 1`],
      ["Models' sections", shownQuietly("section-endpoints")],
      ["settings' list", theList],
      ["the roster", theRoster],
    ]);
    await expectAt("Back after Back out of settings", "/");
    step("Back after Back with nothing pressed between (a phone's Back): the editor's form, the editor, a section, the tab, settings, and the page stays");

    // The page's own ‹ steps out by going back over its page's entry: the next Back is the level
    // under it, not the page again.
    await openSettings();
    await testid(page, "settings-tab-models").click();
    await testid(page, "section-endpoints").click();
    await testid(page, "provider-add").click();
    await showing("connector-pick-custom");
    await depth(2);
    await testid(page, "connector-pick-custom").click();
    await putAway("connector-pick-custom");
    await testid(page, "modal-back").click();
    await showing("connector-pick-custom");
    await expectAt("the editor's ‹", "/?o=settings#l2");
    await walkBack("‹ in the editor", [["the editor closed", `${goneQuietly("provider-editor")} && ${shownQuietly("models-panel")}`]]);
    await testid(page, "settings-mobile-back").click();
    await showing("section-endpoints");
    await expectAt("settings' ‹", "/?o=settings#l1");
    await walkBack("‹ in a section", [
      ["settings' list", theList],
      ["the roster", theRoster],
    ]);
    step("‹ goes back over its page's entry: Back after it is the level under, then settings, then the roster");

    // Prompts: a group, then a prompt's editor (a dialog over settings that Back closes).
    await openSettings();
    await testid(page, "settings-tab-prompts").click();
    await showing("section-turn");
    await testid(page, "section-turn").click();
    const promptRow = page.locator('[role="button"][data-testid^="prompt-turn"]').first();
    await promptRow.waitFor({ timeout: 15_000 });
    const promptId = await promptRow.getAttribute("data-testid");
    await promptRow.click();
    await showing("prompt-editor-page");
    await depth(2);
    await walkBack("Prompts", [
      ["the group", `${goneQuietly("prompt-editor-page")} && ${shownQuietly(promptId!)}`],
      ["Prompts' groups", shownQuietly("section-turn")],
      ["settings' list", theList],
      ["the roster", theRoster],
    ]);
    step("Prompts the same: a prompt's editor, its group, the groups, settings, the roster");

    // Interface, where it shows: a section of it.
    await openSettings();
    if (await testid(page, "settings-tab-interface").count()) {
      await testid(page, "settings-tab-interface").click();
      const section = page.locator('[data-testid="settings-main"] [data-testid^="section-"]').first();
      await section.waitFor({ timeout: 10_000 });
      const sectionId = await section.getAttribute("data-testid");
      await section.click();
      await putAway(sectionId!);
      await walkBack("Interface", [
        ["Interface's sections", shownQuietly(sectionId!)],
        ["settings' list", theList],
        ["the roster", theRoster],
      ]);
      step("Interface the same: a section, its list, settings, the roster");
    } else {
      await walkBack("settings' list", [["the roster", theRoster]]);
      step("(Interface is not among settings' tabs here)");
    }
    await quiet.detach();

    // A reload on a section: settings come back on their list, the entry says so, and one Back closes them.
    await openSettings();
    await testid(page, "settings-tab-models").click();
    await testid(page, "section-endpoints").click();
    await showing("models-panel");
    await expectAt("a section before the reload", "/?o=settings#l2");
    await page.reload();
    reloadedAt = Date.now();
    await showingAfterLoad("settings-nav");
    await expectAt("a section reloaded", "/?o=settings");
    await sheetEntry();
    await back();
    await putAway("settings-modal");
    await row.waitFor({ timeout: 10_000 });
    await expectAt("Back after a reload on a section", "/");
    // On into the earlier load's entries, as after any reload: its tab's entry is passed over to
    // settings' own (NSH hands each over as an `open`), and the next Back is the roster's.
    await back();
    await showing("settings-nav");
    await expectAt("Back onto the earlier load's settings", "/?o=settings");
    await back();
    await putAway("settings-modal");
    await row.waitFor({ timeout: 10_000 });
    await expectAt("Back past the earlier load's settings", "/");
    step("a reload on a section opens settings' list, and Back closes it onto the roster; Back on retraces the earlier load, its settings once, not a press per page");
  }

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
  await back();
  await putAway("bot-detail");
  await showing("bot-nav");
  await expectAt("Back from a Bot's section", botSettingsAt);
  await sheetEntry();
  await back();
  await putAway("session-settings-drawer");
  await showing("conversation");
  await expectAt("Back out of a Bot's settings", writerAt);
  // Closed by its own ✕ instead: the address goes back to the conversation, and Back still walks.
  await testid(page, "top-more").click();
  await showing("mobile-actions-menu");
  await testid(page, "mobile-settings").click();
  await showing("bot-nav");
  await sheetEntry();
  await testid(page, "sheet-close").click();
  await putAway("session-settings-drawer");
  await expectAt("a Bot's settings closed by its ✕", writerAt);
  await back();
  await putAway("conversation");
  await expectAt("Back to the roster", "/");
  step("a Bot's settings step back one level at a time too: a section, the settings, then the conversation");

  // Settings as the page's first screen (a link, a bookmark): the floor and the dialog's entry
  // are laid out otherwise, and no Back may go dead on the way out.
  // Settings the link names open on the roster instead when the page's first connection comes
  // late (seen 2026-11-18 at about 10 s, after the section reload above); a minute after that
  // reload the relay's handshakes are its own again.
  if (reloadedAt) await Bun.sleep(Math.max(0, reloadedAt + 61_000 - Date.now()));
  await page.goto(`${origin}/?o=settings`);
  await showingAfterLoad("settings-nav");
  await sheetEntry();
  await testid(page, "settings-tab-models").click();
  await showing("section-endpoints");
  await testid(page, "section-endpoints").click();
  await showing("models-panel");
  await expectAt("a section of settings opened by a link", "/?o=settings#l2");
  await back();
  await putAway("models-panel");
  await showing("section-endpoints");
  await expectAt("Back from a section of settings opened by a link", "/?o=settings#l1");
  await sheetEntry();
  await back();
  await putAway("settings-models");
  await showing("settings-nav");
  await sheetEntry();
  await back();
  await putAway("settings-modal");
  await row.waitFor({ timeout: 10_000 });
  await expectAt("Back off settings opened by a link", "/");
  step("settings opened by a link step back the same way, and the last Back lands on the roster");

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
  await back();
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

  // Reading back in a project session survives a link that comes back to the snapshot: the relay out
  // of reach while the Mac moves on by more events than a link replays (`RESUME_MAX_EVENTS`), so the
  // page takes the snapshot again (each conversation's last line only) and reads the open one's
  // history again. The conversation used to shrink to its last line meanwhile, and the reader
  // landed at the newest line. Chromium swipes by touch; WebKit here has none to drive.
  if (engine === "chromium" && bounceEdge) {
    await testid(page, "nav-projects").click();
    const projectRow = testid(page, `session-${mac.claudeProject}`).filter({ visible: true }).first();
    await projectRow.waitFor({ timeout: 15_000 });
    await projectRow.click();
    await until("the project session's newest line", 15_000, () => shownIn(page, "conversation", "项目第 30 答"));
    /** The project's transcript: how far it is from its newest line, its first line in view, and whether a line of its second page is in. */
    const reading = () =>
      page.evaluate(() => {
        const list = [...document.querySelectorAll('[data-testid="project-transcript"]')].find((el) => el.clientHeight > 100);
        if (!list) return null;
        const box = list.getBoundingClientRect();
        const leaves = [...list.querySelectorAll("*")].filter((el) => el.childElementCount === 0 && /^项目第 \d+ [问答]/.test((el.textContent ?? "").trim()));
        const shown = leaves
          .map((el) => ({ line: (el.textContent ?? "").trim().slice(0, 8), top: Math.round(el.getBoundingClientRect().top) }))
          .filter((at) => at.top >= box.top && at.top < box.bottom)
          .sort((a, b) => a.top - b.top);
        const number = (line: string) => Number(/第 (\d+)/.exec(line)?.[1] ?? 0);
        return { fromEnd: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop), first: shown[0] ?? null, paged: leaves.some((el) => number((el.textContent ?? "").trim()) <= 20) };
      });
    const lineNumber = (line: string | undefined) => Number(/第 (\d+)/.exec(line ?? "")?.[1] ?? 0);
    const cdp = await context.newCDPSession(page);
    const box = (await page.locator('[data-testid="project-transcript"]').filter({ visible: true }).first().boundingBox())!;
    // Back past the first page, into the lines the second one brought.
    const before = await until("a line of the second page at the top of the view", 60_000, async () => {
      const now = await reading();
      if (now?.paged && now.first && lineNumber(now.first.line) <= 20 && now.fromEnd > 1500) return now;
      await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 3), yDistance: 300, gestureSourceType: "touch", speed: 1200 });
      await Bun.sleep(500);
      return null;
    });
    await Bun.sleep(1000);
    const settledBefore = (await reading())!;
    /** Whether the reader is where they were: the same line at the top of the view, as far down it and from the newest line. */
    const held = (was: NonNullable<Awaited<ReturnType<typeof reading>>>, now: NonNullable<Awaited<ReturnType<typeof reading>>>) =>
      Boolean(was.first && now.first && was.first.line === now.first.line && Math.abs(was.first.top - now.first.top) <= 40 && Math.abs(was.fromEnd - now.fromEnd) <= 40);
    // A line written on the Mac into another conversation (the Writer's; its turn fails at once
    // against the fixture's endpoint) leaves the reader where they are. The project's rows were made
    // anew on every change of the snapshot's lines and handed to the list many times over, and NSH's
    // list measured every row again: on the web the transcript's height fell to its estimates and
    // came back within a frame, and the browser, which cannot scroll above the top, kept only part of
    // the way there and back. The reader was moved towards the newest line.
    await mac.api("POST", `/v1/sessions/${mac.writerDirect}/messages`, { body: `elsewhere-${Date.now().toString(36)}` });
    await Bun.sleep(3000);
    const elsewhere = (await reading())!;
    if (!held(settledBefore, elsewhere)) {
      throw new Error(`a line in another conversation moved the reader: ${JSON.stringify(settledBefore)} → ${JSON.stringify(elsewhere)}`);
    }
    step(`reading back in a project session, a line written into another conversation leaves the reader where they are (\`${elsewhere.first?.line}\` at the top, ${elsewhere.fromEnd} px from the newest line)`);
    const writerBot = (await mac.api<{ items: Array<{ id: string; name: string }> }>("GET", "/v1/bots")).items.find((bot) => bot.name === "Writer")!;
    await bounceEdge(async () => {
      await until("the lost link said over the conversation", 30_000, async () => (await testid(page, "connecting").count()) + (await testid(page, "unreachable").count()) > 0);
      for (let i = 0; i < 320; i += 20) {
        await Promise.all(Array.from({ length: 20 }, (_, k) => mac.api("PATCH", `/v1/bots/${writerBot.id}`, { duties: `写东西、改东西 ${i + k}` })));
      }
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
    await Bun.sleep(4000);
    const after = (await reading())!;
    await cdp.detach();
    // Where they were, among the lines the second page brought.
    if (!after.paged || !held(elsewhere, after)) {
      throw new Error(`the reader lost their place when the link came back: ${JSON.stringify(elsewhere)} → ${JSON.stringify(after)} (first reached ${JSON.stringify(before)})`);
    }
    await page.screenshot({ path: shot("3a-project-read-back") });
    step(`reading back in a project session survives a link that came back to the snapshot: \`${after.first?.line}\` still at the top, ${elsewhere.fromEnd} px from the newest line before, ${after.fromEnd} after`);
    await testid(page, "top-back").click();
    await until("the project session put down", 10_000, async () => (await testid(page, "conversation").count()) === 0);
    await testid(page, "nav-sessions").click();
    await row.waitFor({ timeout: 10_000 });
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

  const refused = problems.filter((line) => /CSP violation|Content Security Policy|Refused to (?:load|execute|compile|connect|apply|frame|create)|blob fetch in /i.test(line));
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
  await persistent?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
