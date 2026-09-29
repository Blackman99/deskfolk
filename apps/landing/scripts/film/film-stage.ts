/**
 * The film side of live.ts: the landing's /film/<lang>/live page holds the demo messenger in its
 * stage, and this drives it — bar-aligned parts, a cursor that travels before every real click, a
 * camera that frames what the story points at, typing at a watchable pace — while Chrome's
 * screencast is sampled at a steady 60 fps into ffmpeg. Sound cues are stamped on the same clock.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { CDPSession, Frame, Locator, Page } from 'playwright';
import type { Cue, Timeline } from './audio.ts';
import { dragPath, type Lang, type Stage } from './story.ts';

/** 112 BPM by default: a bar every 2.14 s, which the parts snap to and the music is written in. */
const BPM = Number(process.env.FILM_BPM ?? 112);
const BAR = 240_000 / BPM;
const BEAT = BAR / 4;
/** How much of every hold the story asks for is kept: the film runs tighter than a person would. */
const HOLD = 0.6;
const FPS = 60;

type Api = (method: string, path: string, body?: unknown) => Promise<any>;

export type FilmRun = {
  stage: Stage;
  /** Logo and hero before the story; call once the recorder runs. */
  intro: () => Promise<void>;
  /** Trust points, end card and tail after it; returns the timeline the music is composed to. */
  outro: () => Promise<Timeline>;
  cues: Cue[];
};

export async function filmStage(opts: {
  page: Page;
  app: Frame;
  phone: Frame;
  api: Api;
  lang: Lang;
  groupName: string;
  log: (msg: string) => void;
}): Promise<{ run: FilmRun; recorder: Recorder }> {
  const { page, app, phone, api, lang, log } = opts;
  const cues: Cue[] = [];
  let t0 = 0;
  const now = () => Date.now() - t0;
  const cue = (type: string) => t0 && cues.push({ t: now(), type });
  const film = (fn: string, arg?: unknown) =>
    page.evaluate(([f, a]) => (window as any).__film[f as string](a), [fn, arg] as const);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
  const bars = { logo: 0, hero: 1, steps: [] as number[], trust: 0, end: 0, tail: 0 };
  const untilBar = async (minGap = 900): Promise<number> => {
    const bar = Math.ceil((now() + minGap) / BAR);
    await sleep(bar * BAR - now());
    return bar;
  };

  /* Poll the daemon for things the picture shows and the soundtrack marks. */
  const seen = { messages: new Set<string>(), approvals: new Set<string>(), bots: 0 };
  let polling = true;
  const poll = async () => {
    while (polling) {
      try {
        const sessions = await api('GET', '/v1/sessions');
        for (const s of sessions.items ?? sessions) {
          const m = s.last_message;
          if (m?.id && !seen.messages.has(m.id)) {
            seen.messages.add(m.id);
            if (m.author && m.author !== 'user' && t0) cue('receive');
          }
        }
        const approvals = await api('GET', '/v1/approvals?status=pending');
        for (const a of approvals.items ?? []) {
          if (!seen.approvals.has(a.id)) {
            seen.approvals.add(a.id);
            cue('alert');
          }
        }
        const bots = await api('GET', '/v1/bots');
        const n = (bots.items ?? bots).length;
        if (n > seen.bots && seen.bots > 0) cue('pop');
        seen.bots = n;
      } catch {
        // the daemon is busy; try again
      }
      await sleep(250);
    }
  };
  void poll();

  /** Playwright only waits for the element to hold still inside its frame, not for the camera moving the frame. */
  const settle = async () => {
    for (let i = 0; i < 40 && !(await film('settled')); i++) await sleep(50);
  };
  const center = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await settle();
    const box = await target.boundingBox();
    if (!box) throw new Error(`nothing to point at: ${target}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  };
  /** A point on the phone gets a fingertip instead of the pointer; before it slides in, nothing is on it. */
  let phoneShown = false;
  const onPhone = async (p: { x: number; y: number }) => {
    if (!phoneShown) return false;
    const box = await page.locator('iframe[name="phone"]').boundingBox();
    return !!box && p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
  };
  const moveTo = async (target: Locator) => {
    const c = await center(target);
    const touch = await onPhone(c);
    await film('cursor', { x: c.x, y: c.y, touch });
    await sleep(380);
    return { ...c, touch };
  };

  let approvalGraceUntil = 0;
  const answered = new Set<string>();
  const idle = async (timeoutMs = 10 * 60_000) => {
    const until = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < until) {
      if (Date.now() > approvalGraceUntil) {
        const pending = await api('GET', '/v1/approvals?status=pending');
        for (const a of pending.items ?? []) {
          const age = Date.now() - Date.parse(a.created_at ?? new Date().toISOString());
          if (age < 2500) continue;
          // The story may have clicked this one a moment ago.
          await api('POST', `/v1/approvals/${a.id}/resolve`, { action: 'allow_once' }).catch(() => {});
        }
      }
      const sessions = await api('GET', '/v1/sessions');
      for (const x of sessions.items ?? sessions) {
        for (const turn of x.live_turns ?? []) {
          if (turn.status !== 'waiting_ask' || !turn.pending_ask_id || answered.has(turn.pending_ask_id)) continue;
          answered.add(turn.pending_ask_id);
          await api('POST', `/v1/messages/${turn.pending_ask_id}/answer`, {
            custom: lang === 'zh' ? '你来定，按最合理的方案做。' : 'Your call; go with the most sensible option.'
          });
        }
      }
      const busy = (sessions.items ?? sessions).some(
        (x: any) => (x.live_turns?.length ?? 0) > 0 || (Array.isArray(x.pending_judgements) ? x.pending_judgements.length : x.pending_judgements) > 0
      );
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 3) return;
      await sleep(500);
    }
    throw new Error('the team did not go idle in time');
  };

  const stage: Stage = {
    lang,
    app,
    phone: async () => {
      await film('phone', true);
      phoneShown = true;
      cue('whoosh');
      await sleep(600);
      return phone;
    },
    api,
    scene: async (n) => {
      // Step 1 follows the two hero bars; every later step starts on the first bar line after a short hold.
      const bar = n === 1 ? Math.max(3, await untilBar(0)) : await untilBar(400);
      if (bar * BAR > now()) await sleep(bar * BAR - now());
      bars.steps[n - 1] = bar;
      await film('set', { phase: 'steps', scene: n });
      log(`step ${n} at bar ${bar}`);
    },
    focus: async (target) => {
      if (!target) return film('focus', null);
      const box = await target.boundingBox().catch(() => null);
      await film('focus', box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null);
      await sleep(250);
    },
    click: async (target, o) => {
      const c = await moveTo(target);
      await settle();
      await film('cursor', { x: c.x, y: c.y, click: true, touch: c.touch });
      cue('click');
      if (process.env.FILM_DEBUG) {
        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null;
          return el ? `${el.tagName}.${el.className}`.slice(0, 80) : 'none';
        }, c);
        const inner = await target.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
          return `${el.tagName}.${el.className} disabled=${(el as HTMLButtonElement).disabled} rect=${[r.x, r.y, r.width, r.height].map(Math.round)} hit=${at?.tagName}.${at?.className}`.slice(0, 220);
        });
        log(`click at ${Math.round(c.x)},${Math.round(c.y)} page-hit=${hit} target=${inner}`);
      }
      await target.click({ button: o?.button ?? 'left' });
      if (process.env.FILM_DEBUG) {
        await sleep(300);
        log(`after: ${(await app.locator('#onboarding-workspace').innerText().catch(() => '?')).slice(0, 60)}`);
      }
      await sleep(220);
    },
    hover: async (target) => {
      await moveTo(target);
      await target.hover();
      await sleep(300);
    },
    drag: async (source, pane, side) => {
      await moveTo(source);
      await settle();
      const { from, to } = await dragPath(source, pane, side);
      await page.mouse.move(from.x, from.y);
      await film('cursor', { x: from.x, y: from.y, click: true });
      cue('click');
      await page.mouse.down();
      await sleep(120);
      // A small first move so the workbench takes it for a drag, then an eased glide to the edge.
      await page.mouse.move(from.x + 6, from.y + 2);
      const steps = 26;
      for (let i = 1; i <= steps; i++) {
        const k = 0.5 - Math.cos((Math.PI * i) / steps) / 2;
        const x = from.x + (to.x - from.x) * k;
        const y = from.y + (to.y - from.y) * k;
        await page.mouse.move(x, y);
        await film('cursor', { x, y, dragging: true });
        await sleep(16);
      }
      await sleep(250);
      await page.mouse.up();
      await film('cursor', { x: to.x, y: to.y });
      cue('whoosh');
      await sleep(500);
    },
    type: async (target, text) => {
      const tag = await target.evaluate((el) => el.tagName);
      if (!/xterm/.test(String(target))) await moveTo(target).catch(() => {});
      if (tag === 'INPUT' || tag === 'TEXTAREA') await target.fill('');
      // Focus once, then plain key events: per-character locator calls re-check the element every time.
      await target.focus();
      const per = Math.max(8, Math.min(35, 1400 / Math.max(1, text.length)));
      const chars = [...text];
      for (let i = 0; i < chars.length; i++) {
        await page.keyboard.type(chars[i]);
        if (i % 2 === 0) cue('key');
        await sleep(per);
      }
    },
    press: async (target, key) => {
      await target.press(key);
      if (key === 'Enter') cue('send');
    },
    hold: (ms) => sleep(ms * HOLD),
    idle: async (timeoutMs, o) => {
      approvalGraceUntil = o?.approve === false ? Infinity : Date.now() + 4000;
      try {
        await idle(timeoutMs);
      } finally {
        approvalGraceUntil = 0;
      }
    },
    tray: async () => {
      await film('hideCursor');
      await film('focus', null);
      await sleep(250);
      await film('desk', { on: true });
      cue('whoosh');
      await sleep(600);
      await film('desk', { menu: true });
      cue('tick');
      await sleep(700);
      await film('desk', { menu: false });
      await sleep(300);
      const sessions = await api('GET', '/v1/sessions');
      const group = (sessions.items ?? sessions).find((x: any) => x.name === opts.groupName);
      const bots = await api('GET', '/v1/bots');
      const coordinator = (bots.items ?? bots).find((b: any) => b.name === 'Coordinator');
      // The banner is the Coordinator's delivery summary, not whatever line happened to come last.
      const page = group ? await api('GET', `/v1/sessions/${group.id}/messages?limit=100`) : null;
      const list: any[] = page?.items ?? page?.messages ?? (Array.isArray(page) ? page : []);
      const newest = [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const summary = newest.find((m) => m.kind === 'bot' && m.author === coordinator?.id) ?? group?.last_message;
      const author = (bots.items ?? bots).find((b: any) => b.id === summary?.author)?.name ?? 'Coordinator';
      // A notification shows text, not Markdown.
      const body = String(summary?.body ?? '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      await film('desk', { banner: { title: `${opts.groupName} · ${author}`, body } });
      cue('notify');
      await sleep(600);
      await film('desk', { badge: true });
      cue('pop');
      await sleep(900);
    },
    attempt: async (_what, fn) => fn(),
    log
  };

  const recorder = new Recorder(page);
  const run: FilmRun = {
    stage,
    cues,
    intro: async () => {
      t0 = recorder.startedAt;
      await film('set', { phase: 'logo' });
      await sleep(BAR - now());
      await film('set', { phase: 'hero' });
      cue('whoosh');
    },
    outro: async () => {
      polling = false;
      await film('hideCursor');
      bars.trust = await untilBar(600);
      await film('set', { phase: 'trust' });
      const trustAt = bars.trust * BAR;
      for (let i = 1; i <= 4; i++) {
        await sleep(trustAt + 250 + (i - 1) * BEAT * 1.5 - now());
        await film('trust', i);
      }
      bars.end = bars.trust + 2;
      await sleep(bars.end * BAR - now());
      await film('set', { phase: 'end' });
      bars.tail = bars.end + 2;
      const totalBars = bars.tail + 1;
      await sleep(totalBars * BAR - now());
      return { bpm: BPM, barMs: BAR, totalBars, durationMs: totalBars * BAR, bars };
    }
  };
  return { run, recorder };
}

/**
 * Samples Chrome's screencast at a steady 60 fps into ffmpeg: the latest frame is written on every
 * tick, so the video runs in real time however unevenly frames arrive.
 */
export class Recorder {
  page: Page;
  cdp: CDPSession | null = null;
  ffmpeg: ChildProcess | null = null;
  latest: Buffer | null = null;
  ticks = 0;
  startedAt = 0;
  timer: ReturnType<typeof setInterval> | null = null;
  frames = 0;

  constructor(page: Page) {
    this.page = page;
  }

  /** `width` × `height` in CSS pixels; `scale` is the page's device pixel ratio, and the frames are that much larger. */
  async start(file: string, width: number, height: number, scale = 1) {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (ev: { data: string; sessionId: number }) => {
      this.latest = Buffer.from(ev.data, 'base64');
      this.frames++;
      void this.cdp!.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: Math.round(width * scale),
      maxHeight: Math.round(height * scale),
      everyNthFrame: 1
    });
    while (!this.latest) await new Promise((r) => setTimeout(r, 20));
    this.ffmpeg = spawn(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
        '-vf', 'scale=out_color_matrix=bt709:flags=lanczos,format=yuv420p',
        // Light enough to keep up in real time next to Chrome; live.ts re-encodes the final cut.
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-movflags', '+faststart', file
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    );
    this.startedAt = Date.now();
    const tick = () => {
      const due = Math.floor(((Date.now() - this.startedAt) * FPS) / 1000);
      while (this.ticks < due && this.latest) {
        this.ffmpeg!.stdin!.write(this.latest);
        this.ticks++;
      }
    };
    this.timer = setInterval(tick, 1000 / FPS / 2);
  }

  async stop(): Promise<{ seconds: number; screencastFps: number }> {
    if (this.timer) clearInterval(this.timer);
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    const done = new Promise<void>((resolve, reject) =>
      this.ffmpeg!.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    );
    this.ffmpeg!.stdin!.end();
    await done;
    const seconds = this.ticks / FPS;
    return { seconds, screencastFps: this.frames / seconds };
  }
}
