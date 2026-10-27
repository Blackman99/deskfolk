/**
 * The README's desktop shots the film does not end on, taken from what a live take left behind
 * (demo-up.ts brings it up again): the job's task map beside the group, and a project session.
 *
 *   node scripts/film/desk.ts --demo /private/tmp/deskfolk-demo --out ../../docs/assets [--shots map,project]
 *
 * Writes app-<lang>-map.jpg and app-<lang>-project.jpg, 1480×924 CSS px at 2× like the shots cut
 * from the film, in the take's language and theme. Run it right after the take whose look the
 * README keeps (zh-light for the Chinese one, en-dark for the English one), before the next take
 * wipes the folder, and after phone.ts.
 *
 * map: the group's job as a town (the conversation header's Map), dragged beside the chat, at a
 * moment in the replay when the Bots are at work. The town's light follows the clock of the moment
 * shown, in the browser's time zone: `--map-tz` picks the zone, so a take filmed at night can still
 * be shown in daylight.
 *
 * project: Claude Code in a small site's folder under the demo's home (dawn-site, set up here with
 * the take's film and tagline), asked to put the film on the first screen. The run is real, on your
 * own Claude Code sign-in, lent to the demo's home while it runs (see `lend`); none of your Claude
 * Code settings come with it.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { bringUp, look } from './demo-up.ts';
import { TEXT, dragPath, type Lang } from './story.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');
const REPO = path.resolve(LANDING, '../..');

const { values: opts } = parseArgs({
  options: {
    demo: { type: 'string', default: '/private/tmp/deskfolk-demo' },
    out: { type: 'string' },
    shots: { type: 'string', default: 'map,project' },
    'map-tz': { type: 'string' },
    'map-at': { type: 'string', default: '0.62' },
    model: { type: 'string', default: 'sonnet' },
    'daemon-port': { type: 'string', default: '17967' },
    'messenger-port': { type: 'string', default: '5227' },
    messenger: { type: 'string' }
  }
});

const MESSENGER = path.resolve(opts.messenger ?? path.join(REPO, 'apps/messenger'));
const demo = path.resolve(opts.demo!);
const dataDir = path.join(demo, 'data');
const demoHome = path.join(demo, 'home');
const shots = new Set(opts.shots!.split(',').filter(Boolean));
const log = (msg: string) => process.stdout.write(`[desk] ${msg}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The film's stage, in CSS px; the shots cut from the film have it at 2×. */
const DESK = { width: 1480, height: 924, scale: 2 };

const SITE = path.join(demoHome, 'dawn-site');
/**
 * Your Claude Code sign-in, lent to the demo's home for the project shot. Claude Code finds it by
 * HOME, in ~/.claude.json and the login keychain: the demo's home gets a copy of the one and a link
 * to the other, and keeps its own ~/.claude, so your CLAUDE.md, hooks and plugins stay out of the
 * shot and the session's files stay in the demo. Given back whatever way this ends.
 */
const STATE = path.join(demoHome, '.claude.json');
const KEYCHAINS = path.join(demoHome, 'Library', 'Keychains');
/** The demo's own .claude.json (the daemon's look for local agents writes one), kept aside meanwhile. */
const ASIDE = '.desk-aside';
const isLink = (at: string) => {
  try {
    return lstatSync(at).isSymbolicLink();
  } catch {
    return false;
  }
};
let lent = false;
function lend() {
  if (existsSync(KEYCHAINS) && !isLink(KEYCHAINS)) throw new Error(`${KEYCHAINS} is not a link this left behind`);
  if (existsSync(STATE) && !existsSync(STATE + ASIDE)) renameSync(STATE, STATE + ASIDE);
  copyFileSync(path.join(homedir(), '.claude.json'), STATE);
  mkdirSync(path.dirname(KEYCHAINS), { recursive: true });
  if (isLink(KEYCHAINS)) unlinkSync(KEYCHAINS);
  symlinkSync(path.join(homedir(), 'Library', 'Keychains'), KEYCHAINS);
  lent = true;
}
/** The link goes, never what it points at; the copy goes back to the demo's own. */
function giveBack() {
  if (!lent) return;
  if (isLink(KEYCHAINS)) unlinkSync(KEYCHAINS);
  if (existsSync(STATE + ASIDE)) renameSync(STATE + ASIDE, STATE);
  else rmSync(STATE, { force: true });
  lent = false;
}
process.on('exit', giveBack);

const ASK: Record<Lang, string> = {
  zh: '首页首屏的海报换成 media/dawn_final.mp4 这支新片：静音、循环、自动播放，手机上内联播放，加载前先显示海报；主标语换成 copy.md 里那句。',
  en: 'Swap the poster on the first screen for the new film, media/dawn_final.mp4: muted, looping, autoplay, inline on phones, the poster shown until it loads; and use the tagline in copy.md.'
};

type Api = (method: string, p: string, body?: unknown) => Promise<any>;

function apiOf(): Api {
  const desc = JSON.parse(readFileSync(path.join(dataDir, 'local-api.json'), 'utf-8')) as { port: number; token: string };
  return async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${desc.port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${desc.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}

const items = (x: any): any[] => (Array.isArray(x) ? x : (x?.items ?? []));

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value as T;
    await sleep(everyMs);
  }
  throw new Error(`waited too long for ${what}`);
}

async function openDesk(url: string, timezoneId?: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const { lang, theme } = look(demo);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: DESK.width, height: DESK.height },
    deviceScaleFactor: DESK.scale,
    colorScheme: theme,
    locale: lang === 'zh' ? 'zh-CN' : 'en-US',
    ...(timezoneId ? { timezoneId } : {})
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__runtime?.connection === 'connected', null, { timeout: 60_000, polling: 200 });
  return { page, close: () => browser.close() };
}

async function shot(page: Page, out: string, name: string) {
  // Fonts, avatars and the panes' own transitions settle first.
  await page.waitForTimeout(1500);
  const { lang } = look(demo);
  const file = path.join(out, `app-${lang}-${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
  log(`${name}: ${file}`);
}

/** Drags a tab by mouse to just inside a pane's edge, which splits the pane there (the app's drags are pointer events). */
async function drag(page: Page, tab: ReturnType<Page['locator']>, pane: ReturnType<Page['locator']>, side: 'east' | 'south') {
  const { from, to } = await dragPath(tab, pane, side);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 3, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await sleep(250);
  await page.mouse.up();
  await sleep(500);
}

async function mapShot(url: string, out: string) {
  const { lang } = look(demo);
  const t = TEXT[lang];
  const { page, close } = await openDesk(url, opts['map-tz']);
  try {
    await page.locator('.groups .row', { hasText: t.groupName }).first().click();
    await page.locator('.composer-input').waitFor();
    await page.getByRole('button', { name: lang === 'zh' ? '地图' : 'Map', exact: true }).first().click();
    const map = page.locator('.tm-scrub').first();
    await map.waitFor({ timeout: 30_000 });
    // The town beside the chat, not over it.
    const chatPane = page.locator('.wb-leaf').filter({ has: page.locator('.composer-input') }).first();
    const mapTab = page.locator('.wb-tab').filter({ has: page.locator('.wb-tab-icon[data-kind="map"]') }).first();
    if ((await page.locator('.wb-leaf').count()) < 2 && (await mapTab.count())) {
      await drag(page, mapTab.locator('.wb-tab-button').first(), chatPane, 'east');
      await page.locator('.wb-leaf').nth(1).waitFor({ timeout: 10_000 });
    }
    // The town gets the larger share: the chat keeps a readable column, the map the rest, a step closer.
    const sash = (await page.locator('.wb-sash').first().boundingBox())!;
    const left = (await chatPane.boundingBox())!.x;
    await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
    await page.mouse.down();
    await page.mouse.move(left + 520, sash.y + sash.height / 2, { steps: 12 });
    await page.mouse.up();
    await sleep(500);
    await page.getByRole('button', { name: lang === 'zh' ? '放大地图' : 'Zoom in', exact: true }).click();
    // A moment in the replay where the Bots are at work, not the town at rest after it.
    const max = Number(await map.getAttribute('max'));
    await map.evaluate((el: HTMLInputElement, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, max * Number(opts['map-at']));
    await shot(page, out, 'map');
  } finally {
    await close();
  }
}

/** dawn-site: a small product page for the kettle, its first screen still on a poster, with the take's film and tagline beside it. */
function setUpSite() {
  rmSync(SITE, { recursive: true, force: true });
  cpSync(path.join(HERE, 'dawn-site'), SITE, { recursive: true });
  const launch = execFileSync('find', [path.join(demoHome, 'deskfolk-workspace'), '-path', '*/launch/dawn_final.mp4'], { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  if (!launch) throw new Error('the take left no launch/dawn_final.mp4');
  mkdirSync(path.join(SITE, 'media'), { recursive: true });
  cpSync(launch, path.join(SITE, 'media', 'dawn_final.mp4'));
  const copy = path.join(path.dirname(launch), 'copy.md');
  if (existsSync(copy)) cpSync(copy, path.join(SITE, 'copy.md'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', path.join(SITE, 'media', 'dawn_final.mp4'), '-frames:v', '1', '-q:v', '3', path.join(SITE, 'media', 'poster.jpg')]);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Mochi', '-c', 'user.email=mochi@example.com', ...args], { cwd: SITE, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'First page');
}

async function projectShot(url: string, out: string) {
  const { lang } = look(demo);
  const api = apiOf();
  const session = await api('POST', '/v1/project-sessions', { dir: SITE });
  await api('PATCH', `/v1/project-sessions/${session.id}`, { model: opts.model });
  const { page, close } = await openDesk(`${url}?s=${session.id}`);
  try {
    const composer = page.locator('[data-project-chat] textarea').first();
    await composer.waitFor();
    await composer.click();
    await composer.pressSequentially(ASK[lang], { delay: 4 });
    await composer.press('Enter');
    const run = await until(
      'the run to end',
      async () => {
        const r = (await api('GET', `/v1/project-sessions/${session.id}/run`)).run;
        if (r?.status === 'waiting_approval') log(`waiting on a card: ${JSON.stringify(r.approval).slice(0, 160)}`);
        return r && !['running', 'waiting_approval'].includes(r.status) ? r : null;
      },
      15 * 60_000,
      2000
    );
    log(`run ${run.status}${run.error ? `: ${run.error}` : ''}`);
    // The page it changed, opened from its reply beside the chat with the project's tree, as source:
    // the change reads there, where the page's preview shows it at a fifth of its size.
    const changed = page.locator('[data-project-chat] a.md-artifact-link', { hasText: 'index.html' }).first();
    if (run.status !== 'completed' || !(await changed.count())) throw new Error('no finished run naming index.html to open: look at the session and run again');
    await changed.click();
    await page.locator('.wb-leaf').nth(1).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: lang === 'zh' ? '源码' : 'Source', exact: true }).first().click();
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 20_000 });
    await shot(page, out, 'project');
  } finally {
    await close();
    giveBack();
  }
}

async function main() {
  if (!opts.out) throw new Error('--out <folder> for the shots');
  const out = path.resolve(opts.out);
  mkdirSync(out, { recursive: true });
  // Claude Code is to read the account it finds in the demo's home, not one this shell points at.
  delete process.env.CLAUDE_CONFIG_DIR;
  // Before the daemon is up: it asks Claude Code whether it is signed in once, and keeps the answer.
  if (shots.has('project')) {
    setUpSite();
    lend();
  }
  const url = await bringUp(demo, { daemonPort: Number(opts['daemon-port']), messengerPort: Number(opts['messenger-port']), messenger: MESSENGER });
  log(`messenger ${url} (${dataDir})`);
  if (shots.has('map')) await mapShot(url, out);
  if (shots.has('project')) await projectShot(url, out);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
