/**
 * The promo on the real app. Brings up an isolated demo daemon (apps/daemon/scripts/demo-studio.ts),
 * its model endpoint and MCP server (apps/daemon/scripts/demo-tape.ts) and the real messenger, then
 * plays story.ts on it.
 *
 *   node scripts/film/live.ts shoot [--lang zh]     real models and MCP, recorded to film-out/tape-<lang>/
 *   node scripts/film/live.ts replay [--lang zh]    the same story answered from the tape, no film
 *   node scripts/film/live.ts film [--lang zh] [--theme light] [--music track.mp3]
 *                                                    the replay, composed on /film/<lang>/live and recorded
 *
 * The shoot spends real money once (your endpoint, and Grok Imagine through your MCP server); keys
 * stay in your Keychain and are only added by demo-tape to upstream requests. The demo's HOME and
 * data live in /tmp/deskfolk-demo (wiped each run, the same path every run so a replay's commands
 * find what the shoot's did), and the brand logo it is handed sits in /Users/Shared/dawn-brand.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright';
import { createServer } from 'vite';
import { filmStage } from './film-stage.ts';
import { scoreAndMux } from './mux.ts';
import { MODELS, TEXT, dragPath, playStory, type Lang, type Stage } from './story.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');
const REPO = path.resolve(LANDING, '../..');
const MESSENGER = path.join(REPO, 'apps/messenger');

// SvelteKit and Tailwind find their configs from the working directory.
process.chdir(LANDING);

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lang: { type: 'string', default: 'zh' },
    theme: { type: 'string', default: 'light' },
    out: { type: 'string', default: path.join(LANDING, 'film-out') },
    music: { type: 'string' },
    headed: { type: 'boolean', default: false },
    // Another checkout's daemon for the demo (a worktree with changes not applied here yet).
    daemon: { type: 'string' },
    // The demo messenger's port, when another session's Vite already holds the default.
    'messenger-port': { type: 'string', default: '5217' },
    // Device pixels per CSS pixel on the film page. At 2 the homepage clips stay sharp on a
    // high-density screen, where a 1× recording is shown enlarged twice over.
    scale: { type: 'string', default: '2' },
    until: { type: 'string' }
  }
});
const mode = positionals[0] as 'shoot' | 'replay' | 'film';
if (!['shoot', 'replay', 'film'].includes(mode)) {
  console.error('usage: live.ts shoot|replay|film [--lang zh|en]');
  process.exit(1);
}
const DAEMON = opts.daemon ? path.resolve(opts.daemon) : path.join(REPO, 'apps/daemon');
const lang: Lang = opts.lang === 'en' ? 'en' : 'zh';
const theme = opts.theme === 'dark' ? 'dark' : 'light';
const outDir = path.resolve(opts.out);
const tapeDir = path.join(outDir, `tape-${lang}`);
const logDir = path.join(outDir, 'live', `${lang}-${mode}`);
// The real path (not /tmp) so the demo shell's prompt shortens the workspace to ~.
const DEMO_ROOT = '/private/tmp/deskfolk-demo';
const demoHome = path.join(DEMO_ROOT, 'home');
const dataDir = path.join(DEMO_ROOT, 'data');
const LOGO = '/Users/Shared/dawn-brand/logo.png';
const MESSENGER_PORT = Number(opts['messenger-port']);
const SCALE = Number(opts.scale) || 1;
const LANDING_PORT = 5288;
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** `--until n`: stop before step n + 1, to try the early steps without calling a model. */
class Stop extends Error {}

const children: ChildProcess[] = [];
const closers: (() => Promise<void>)[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function log(msg: string) {
  process.stdout.write(`[live] ${msg}\n`);
}

function run(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO): ChildProcess {
  const file = createWriteStream(path.join(logDir, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(file);
  child.stderr!.pipe(file);
  children.push(child);
  return child;
}

async function shutdown() {
  for (const close of closers.reverse()) await close().catch(() => {});
  closers.length = 0;
  for (const c of children) c.kill('SIGTERM');
}
process.on('SIGINT', () => void shutdown().finally(() => process.exit(130)));
// Whatever way this process ends, its helpers go with it.
process.on('exit', () => children.forEach((c) => c.kill('SIGTERM')));

/** A brand mark for the story's kettle: a real file outside the workspace for the team to fetch. */
async function drawLogo(browser: Browser, file: string) {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#e8663d"/></linearGradient></defs>
      <rect x="16" y="16" width="480" height="480" rx="112" fill="#1d2a3a"/>
      <circle cx="256" cy="286" r="112" fill="url(#g)"/>
      <rect x="96" y="286" width="320" height="130" fill="#1d2a3a"/>
      <rect x="120" y="294" width="272" height="10" rx="5" fill="#ffb347"/>
      <text x="256" y="388" text-anchor="middle" font-family="Avenir Next, Helvetica Neue, sans-serif" font-weight="700" font-size="64" letter-spacing="10" fill="#f6efe6">DAWN</text>
      <text x="256" y="440" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="34" letter-spacing="16" fill="#c9b8a6">晨光</text>
    </svg></body></html>`);
  mkdirSync(path.dirname(file), { recursive: true });
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
  await page.close();
}

async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`${what} did not come up`);
    await sleep(250);
  }
}

async function startMessenger(): Promise<string> {
  run('messenger', process.execPath, [path.join(HERE, 'serve-quiet.mjs'), String(MESSENGER_PORT)], { ...process.env, REAL_BOT_DATA_DIR: dataDir }, MESSENGER);
  const url = `http://localhost:${MESSENGER_PORT}/`;
  await waitFor('the demo messenger', () => fetch(url).then((r) => r.ok).catch(() => false), 90_000);
  return url;
}

async function startLanding(): Promise<string> {
  const server = await createServer({
    root: LANDING,
    configFile: path.join(LANDING, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port: LANDING_PORT, strictPort: true, hmr: false, watch: null }
  });
  await server.listen();
  closers.push(() => server.close());
  return `http://localhost:${LANDING_PORT}`;
}

const connected = (target: Page | Frame) =>
  target.waitForFunction(() => (window as any).__runtime?.connection === 'connected', null, { timeout: 60_000, polling: 200 });

async function openApp(browser: Browser, url: string, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, colorScheme: theme, locale: lang === 'zh' ? 'zh-CN' : 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  await page.goto(url);
  await connected(page);
  return page;
}

async function main() {
  if (mode === 'shoot' && existsSync(path.join(tapeDir, 'tape.jsonl'))) {
    const old = `${tapeDir}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(tapeDir, old);
    log(`kept the previous tape at ${old}`);
  }
  if (mode !== 'shoot' && !existsSync(path.join(tapeDir, 'tape.jsonl'))) throw new Error(`no tape at ${tapeDir}; run the shoot first`);
  rmSync(DEMO_ROOT, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(demoHome, { recursive: true });
  mkdirSync(tapeDir, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: !opts.headed });
  closers.push(() => browser.close());
  await drawLogo(browser, LOGO);

  // The film streams answers faster than a model would; the plain replay keeps the tape's pace.
  const pace = mode === 'film' ? ['--pace', '0.55'] : [];
  run('tape', 'bun', [path.join(DAEMON, 'scripts/demo-tape.ts'), mode === 'shoot' ? 'record' : 'replay', '--tape', tapeDir, '--models', MODELS.join(','), ...pace], process.env);
  const studioEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: demoHome,
    PATH: `${path.join(demoHome, 'bin')}:${process.env.PATH}`,
    REAL_BOT_DATA_DIR: dataDir,
    REAL_BOT_REAL_HOME: homedir(),
    // The terminal helper is a build product; another checkout (--daemon) has none of its own.
    REAL_BOT_PTY_HELPER: process.env.REAL_BOT_PTY_HELPER ?? path.join(REPO, 'apps/runtime-helper/.build/debug/real-bot-pty')
  };
  delete studioEnv.ZDOTDIR;
  if (mode !== 'shoot') studioEnv.REAL_BOT_DEMO_CURLRC = '1';
  run('studio', 'bun', [path.join(DAEMON, 'scripts/demo-studio.ts')], studioEnv);
  await waitFor('the demo daemon', () => existsSync(path.join(dataDir, 'local-api.json')), 30_000);
  const desc = JSON.parse(readFileSync(path.join(dataDir, 'local-api.json'), 'utf-8')) as { port: number; token: string };
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${desc.port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${desc.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  await api('PATCH', '/v1/settings', { locale: lang, theme });
  const appUrl = await startMessenger();
  log(`demo daemon :${desc.port}, messenger ${appUrl}, logs ${logDir}`);

  try {
    if (mode === 'film') await film(appUrl, api);
    else await plain(browser, appUrl, api);
  } finally {
    const tape = await fetch('http://127.0.0.1:8000/__tape').then((r) => r.json()).catch(() => null);
    if (tape) {
      writeFileSync(path.join(logDir, 'tape-usage.json'), JSON.stringify(tape, null, 2));
      log(`tape: ${JSON.stringify(tape).slice(0, 600)}`);
    }
    await shutdown();
    rmSync(path.dirname(LOGO), { recursive: true, force: true });
  }
}

type Api = (method: string, path: string, body?: unknown) => Promise<any>;


/** The shoot, or a replay without a camera: the story played as plainly and quickly as it goes. */
async function plain(browser: Browser, appUrl: string, api: Api) {
  const desktop = await openApp(browser, appUrl, DESKTOP);
  let phonePage: Page | null = null;
  const answered = new Set<string>();
  const idle = async (timeoutMs = 10 * 60_000, o: { approve?: boolean } = {}) => {
    const until = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < until) {
      if (o.approve !== false) {
        const pending = await api('GET', '/v1/approvals?status=pending');
        for (const a of pending.items ?? []) {
          log(`approving ${a.kind ?? ''} ${String(a.summary ?? a.target ?? '').slice(0, 80)}`);
          await api('POST', `/v1/approvals/${a.id}/resolve`, { action: 'allow_once' }).catch(() => {});
        }
      }
      const sessions = await api('GET', '/v1/sessions');
      for (const x of sessions.items ?? sessions) {
        for (const turn of x.live_turns ?? []) {
          if (turn.status !== 'waiting_ask' || !turn.pending_ask_id || answered.has(turn.pending_ask_id)) continue;
          answered.add(turn.pending_ask_id);
          log(`answering a question in ${x.name}`);
          await api('POST', `/v1/messages/${turn.pending_ask_id}/answer`, {
            custom: lang === 'zh' ? '你来定，按最合理的方案做。' : 'Your call; go with the most sensible option.'
          });
        }
      }
      const busy = (sessions.items ?? sessions).some(
        (x: any) => (x.live_turns?.length ?? 0) > 0 || (Array.isArray(x.pending_judgements) ? x.pending_judgements.length : x.pending_judgements) > 0
      );
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 4) return;
      await sleep(1000);
    }
    throw new Error('the team did not go idle in time');
  };

  const stage: Stage = {
    lang,
    app: desktop,
    phone: async () => (phonePage ??= await openApp(browser, appUrl, PHONE)),
    api,
    scene: async (n) => {
      if (opts.until && n > Number(opts.until)) throw new Stop();
      log(`step ${n}`);
    },
    focus: async () => {},
    click: (target, o) => target.click({ button: o?.button ?? 'left' }),
    hover: async (target) => {
      await target.hover();
    },
    drag: async (source, pane, side) => {
      const { from, to } = await dragPath(source, pane, side);
      await desktop.mouse.move(from.x, from.y);
      await desktop.mouse.down();
      await desktop.mouse.move(from.x + 8, from.y + 3, { steps: 2 });
      await desktop.mouse.move(to.x, to.y, { steps: 12 });
      await sleep(250);
      await desktop.mouse.up();
      await sleep(300);
    },
    type: async (target: Locator, text: string) => {
      const tag = await target.evaluate((el) => el.tagName);
      if (tag === 'INPUT' || tag === 'TEXTAREA') await target.fill('');
      await target.pressSequentially(text, { delay: 6 });
    },
    press: (target, key) => target.press(key),
    hold: (ms) => sleep(Math.min(ms, 400)),
    idle,
    leave: async () => {},
    back: async () => {},
    attempt: async (what, fn) => {
      try {
        await fn();
      } catch (e) {
        log(`${what} failed (the run carries on): ${(e as Error).message.split('\n')[0]}`);
        await desktop.screenshot({ path: path.join(logDir, `failed-${what.replace(/\W+/g, '-')}.png`) }).catch(() => {});
      }
    },
    log
  };

  const started = Date.now();
  try {
    await playStory(stage).catch((e) => {
      if (!(e instanceof Stop)) throw e;
      log(`stopped before step ${Number(opts.until) + 1}`);
    });
    log(`story done in ${Math.round((Date.now() - started) / 1000)} s`);
    await desktop.screenshot({ path: path.join(logDir, 'last.png') });
  } catch (e) {
    await desktop.screenshot({ path: path.join(logDir, 'failure.png') }).catch(() => {});
    throw e;
  }
}

/** The replay on the film page: camera, cursor, bar-aligned parts, recorded, then scored. */
async function film(appUrl: string, api: Api) {
  const landing = await startLanding();
  // A browser of its own: Chrome's screencast only delivers device pixels when the display itself is
  // high-density, which emulating deviceScaleFactor does not make it. The logo the story hands over
  // stays drawn at 1× in the other one, so the commands' output matches the tape.
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !opts.headed,
    args: SCALE === 1 ? [] : [`--force-device-scale-factor=${SCALE}`]
  });
  closers.push(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: SCALE,
    colorScheme: theme,
    locale: lang === 'zh' ? 'zh-CN' : 'en-US'
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  await page.goto(`${landing}/film/${lang}/live?theme=${theme}&app=${encodeURIComponent(appUrl)}`);
  await page.waitForFunction(() => (window as any).__film?.ready, null, { timeout: 90_000, polling: 200 });
  await waitFor('the app frames', () => !!page.frame({ name: 'app' }) && !!page.frame({ name: 'phone' }), 30_000);
  const app = page.frame({ name: 'app' })!;
  const phone = page.frame({ name: 'phone' })!;
  await connected(app);
  await connected(phone);
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await sleep(1500);

  const { run, recorder } = await filmStage({ page, app, phone, api, lang, groupName: TEXT[lang].groupName, log });
  // A reload in either app frame (the dependency optimizer finding something new) loses the story's
  // state. Navigation events also fire for the app's own URL updates, so a mark set now tells instead.
  for (const f of [app, phone]) await f.evaluate(() => ((window as any).__filmMark = true));
  const reloaded = async () => {
    for (const f of [app, phone]) if (!(await f.evaluate(() => !!(window as any).__filmMark).catch(() => false))) return f.name();
    return null;
  };
  const tag = `deskfolk-live-${lang}-${theme}`;
  const silentPath = path.join(outDir, `${tag}.silent.mp4`);
  await recorder.start(silentPath, 1920, 1080, SCALE);
  let timeline;
  try {
    await run.intro();
    await playStory(run.stage);
    timeline = await run.outro();
    const lost = await reloaded();
    if (lost) throw new Error(`the ${lost} frame reloaded mid-recording (run the replay once to settle Vite's dependency cache)`);
  } catch (e) {
    await page.screenshot({ path: path.join(logDir, 'failure.png') }).catch(() => {});
    const partial = await recorder.stop().catch(() => null);
    if (partial) log(`stopped after ${partial.seconds.toFixed(1)} s, screencast ${partial.screencastFps.toFixed(1)} fps`);
    throw e;
  }
  const stats = await recorder.stop();
  log(`recorded ${stats.seconds.toFixed(1)} s, screencast ${stats.screencastFps.toFixed(1)} fps`);
  writeFileSync(path.join(outDir, `${tag}.timeline.json`), JSON.stringify(timeline, null, 2));
  writeFileSync(path.join(outDir, `${tag}.cues.json`), JSON.stringify(run.cues, null, 2));

  const finalPath = scoreAndMux({ silentPath, timeline, cues: run.cues, outDir, tag, music: opts.music });
  log(`film: ${finalPath}`);
}

main().catch((e) => {
  console.error(e);
  void shutdown().finally(() => process.exit(1));
});
