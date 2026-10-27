/**
 * The README's phone screenshots, taken from what a live take left behind: the take's demo daemon
 * is brought up again on its data (no model behind it, nothing new happens), the real messenger is
 * served beside it, and a phone-sized browser walks the finished job, one screen at a time.
 *
 *   node scripts/film/phone.ts --demo /private/tmp/deskfolk-demo --out ../../docs/assets
 *   node scripts/film/phone.ts --demo <dir> --serve     only bring it up, to look around
 *
 * `--demo` is the folder a take used (`data/` and `home/`): run it right after the take whose
 * language and theme the shots should have (zh-light for the Chinese README, en-dark for the
 * English one), before the next take wipes it. The workspace's paths are stored absolute, so the
 * folder must still be where the take had it.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { bringUp, look } from './demo-up.ts';
import { TEXT } from './story.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');
const REPO = path.resolve(LANDING, '../..');

const { values: opts } = parseArgs({
  options: {
    demo: { type: 'string', default: '/private/tmp/deskfolk-demo' },
    out: { type: 'string' },
    serve: { type: 'boolean', default: false },
    'daemon-port': { type: 'string', default: '17967' },
    'messenger-port': { type: 'string', default: '5227' },
    // Another checkout's messenger: two Vite servers on one checkout share its dependency cache, and
    // a take recording beside this one reloads when this one re-optimizes it.
    messenger: { type: 'string' }
  }
});

const MESSENGER = path.resolve(opts.messenger ?? path.join(REPO, 'apps/messenger'));
const demo = path.resolve(opts.demo!);
const dataDir = path.join(demo, 'data');
const daemonPort = Number(opts['daemon-port']);
const messengerPort = Number(opts['messenger-port']);
const log = (msg: string) => process.stdout.write(`[phone] ${msg}\n`);

/** A phone's screen, at three device pixels to the point so the README can show them sharp. */
const PHONE = { width: 390, height: 844, scale: 3 };

async function shoot(url: string, out: string) {
  const { lang, theme } = look(demo);
  const t = TEXT[lang];
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: PHONE.width, height: PHONE.height },
    deviceScaleFactor: PHONE.scale,
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
    locale: lang === 'zh' ? 'zh-CN' : 'en-US'
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__runtime?.connection === 'connected', null, { timeout: 60_000, polling: 200 });
  mkdirSync(out, { recursive: true });
  const shot = async (name: string) => {
    // Fonts, avatars and the transcript's own scrolling settle first.
    await page.waitForTimeout(1500);
    const file = path.join(out, `phone-${lang}-${name}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
    log(`${name}: ${file}`);
  };
  const group = () => page.locator('button.row', { hasText: t.groupName }).first();
  const toGroup = async () => {
    await page.goto(url);
    await group().click();
    await page.locator('.composer-input').waitFor();
  };

  // 1 · The list: the group, its two Bots, the files a phone sends in.
  await group().waitFor();
  await shot('list');

  // 2 · Back to the result: your 「怎么样了」 and the Producer's own answer, the film in it, with its
  // last line (commands, time) at the foot of the screen. A later line of the same Bot (a check-back
  // after the take, say) is a segment of its own, left below it. Scrolled as you would, by the
  // wheel, once the transcript has drawn and followed its foot.
  await toGroup();
  await page.waitForTimeout(1500);
  const stream = page.locator('.stream').first();
  const box = (await stream.boundingBox())!;
  // The transcript runs on under the composer: its foot is the composer's top, not the scroller's.
  const below = await page.evaluate((status) => {
    const lines = [...document.querySelectorAll('.msg')];
    const reply = lines[lines.findLastIndex((m) => m.textContent?.includes(status)) + 1];
    if (!reply) return 0;
    const foot = reply.closest('.msg-segment') ?? reply;
    let composer: Element = document.querySelector('.composer-input')!;
    while (composer.parentElement && composer.parentElement.getBoundingClientRect().height < 200) composer = composer.parentElement;
    return composer.getBoundingClientRect().top - foot.getBoundingClientRect().bottom;
  }, t.status);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  if (below > 6) await page.mouse.wheel(0, -(below - 6));
  await shot('chat');

  // 3 · The job's sheet at 要点: the goal, who makes and who reviews, the checks passed.
  await page.getByRole('button', { name: lang === 'zh' ? '更多会话操作' : 'More conversation actions' }).click();
  await page.getByRole('menuitem', { name: lang === 'zh' ? '经过' : 'Trace', exact: true }).click();
  await page.locator('.trace-view-tab').last().click();
  await shot('job');

  // 4 · The film, opened from the answer, a moment in.
  await toGroup();
  await page.locator('a.md-artifact-link', { hasText: 'dawn_final.mp4' }).last().click();
  const video = page.locator('video').first();
  await video.waitFor();
  await video.evaluate((v: HTMLVideoElement) => new Promise<void>((resolve) => {
    const seek = () => { v.currentTime = 3.2; v.addEventListener('seeked', () => resolve(), { once: true }); };
    if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
  }));
  await shot('film');
  await browser.close();
}

async function main() {
  const url = await bringUp(demo, { daemonPort, messengerPort, messenger: MESSENGER });
  log(`messenger ${url} on the daemon at :${daemonPort} (${dataDir})`);
  if (opts.serve) await new Promise(() => {});
  if (!opts.out) throw new Error('--out <folder> for the shots, or --serve');
  await shoot(url, path.resolve(opts.out));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
