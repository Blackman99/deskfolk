/**
 * The promo's story, played on the real messenger against the isolated demo daemon: first launch
 * on the video engine makes a Producer from its director template, you hand it a 6-second promo
 * film and its tagline, it brings in a Reviewer and a group you put on the video engine too,
 * and you walk away; your numbers become checks the app runs, a stop holds until you lift it, and what
 * is handed over moves only on those checks and the Reviewer's evidence. The same steps run for the
 * shoot (real models, recorded) and for every replay (the tape answers), so a replay reaches the
 * same states in the same order. Every wait reads the daemon's state (tickets' stages, the ball on
 * them, holds, submissions), not "no turn is live": from engine level 6 a Bot's turn ends while the
 * app polls its render, and the story must not run ahead of that.
 */
import { execFileSync } from 'node:child_process';
import type { Frame, Locator, Page } from 'playwright';

export type Lang = 'zh' | 'en';

export type StoryText = {
  providerName: string;
  endpoint: string;
  key: string;
  defaultModel: string;
  producer: { name: string; duties: string; boundaries: string };
  reviewerName: string;
  /** Pinned off camera, so the Reviewer's pass is a second model's word, not the Producer's own. */
  reviewerModel: string;
  teamAsk: string;
  groupName: string;
  goal: string;
  /** Three lines on their own, each read by the control rules: stop, a new ask while stopped, go on. */
  stop: string;
  change: string;
  go: string;
  /** Your word on a hand-over that waits on you (ADR 0084): it lets it through, as 放行 on a card did. */
  pass: string;
  status: string;
};

export const MODELS = ['grok-4.7-build-fast', 'gemini-3.8-flash-high'];

export const TEXT: Record<Lang, StoryText> = {
  zh: {
    providerName: '本地 vLLM',
    endpoint: 'http://127.0.0.1:8000/v1',
    key: 'sk-local-7f3a9c2e41b8',
    defaultModel: 'grok-4.7-build-fast',
    producer: {
      name: '制片',
      duties:
        '把交给你的活从头做到交付：开工前把活拆成任务，每个任务的审查者都设为审片；交付前自己先按用户的要求核对；做完交给审片审，按审查意见改。',
      boundaries: '只在工作区里动手；不替审片下结论；用户说停就停，等他说继续再接着做。'
    },
    reviewerName: '审片',
    reviewerModel: 'gemini-3.8-flash-high',
    teamAsk:
      '帮我建一个 Bot，名字叫「审片」：职责是审你交出来的视频和文案，逐条对照用户的要求，看帧、核对时长和分辨率，带依据地判通过或打回；边界是只审不改。再建个群「发布」，把你们两个都拉进来。现在只把人和群建好，先别开工，任务我稍后在群里发。',
    groupName: '发布',
    goal:
      '给「晨光」手冲壶做一支宣传短片：时长 6 秒，分辨率 1080×1920，片尾带品牌 logo，成片存为 launch/dawn_final.mp4；再配一句主标语，写进 launch/copy.md。品牌 logo 在 /Users/Shared/dawn-brand/logo.png，先拷进 launch/ 再用。画面用 grok-imagine 生成视频。',
    stop: '先停一下',
    change: '片尾的 logo 再大一点。',
    go: '继续',
    pass: '可以，就用这版。',
    status: '怎么样了'
  },
  en: {
    providerName: 'Local vLLM',
    endpoint: 'http://127.0.0.1:8000/v1',
    key: 'sk-local-7f3a9c2e41b8',
    defaultModel: 'grok-4.7-build-fast',
    producer: {
      name: 'Producer',
      duties:
        'Take the job you are given from start to delivery: before starting, split it into tickets with Reviewer as the reviewer of each; check your work against the user’s asks before handing it over; when done, hand it to Reviewer and fix what the review sends back.',
      boundaries: 'Act only inside the workspace; never rule on your own work for Reviewer; when the user says stop, stop and wait for them to say continue.'
    },
    reviewerName: 'Reviewer',
    reviewerModel: 'gemini-3.8-flash-high',
    teamAsk:
      'Make me a Bot called “Reviewer”: it reviews the videos and copy you hand over, item by item against the user’s asks, looking at frames and checking length and size, and passes or sends back with evidence; it reviews, it does not edit. Then make a group called “Launch” with the two of you. Only set up the Bot and the group for now; don’t start any work, I’ll post the job in the group.',
    groupName: 'Launch',
    goal:
      'Make a promo film for the “Dawn” pour-over kettle: length 6 seconds, resolution 1080×1920, ending on the brand logo, saved as launch/dawn_final.mp4; plus a one-line tagline in launch/copy.md. The brand logo is at /Users/Shared/dawn-brand/logo.png; copy it into launch/ first. Generate the footage as a video with grok-imagine.',
    stop: 'Pause.',
    change: 'Make the logo at the end bigger.',
    go: 'Continue.',
    pass: 'Looks good, go with this one.',
    status: 'How is it going?'
  }
};

/** What the story needs from whoever runs it: the shoot does it plainly, the film with a cursor and a camera. */
export type Stage = {
  lang: Lang;
  app: Page | Frame;
  phone: () => Promise<Page | Frame>;
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  /** Starts walkthrough step n (1-based); the film waits for the next bar line. */
  scene: (n: number) => Promise<void>;
  focus: (target: Locator | null) => Promise<void>;
  click: (target: Locator, opts?: { button?: 'left' | 'right' }) => Promise<void>;
  hover: (target: Locator) => Promise<void>;
  /** Drags `source` (a tab) and lets go just inside `pane`'s edge on `side`, which splits the pane there. */
  drag: (source: Locator, pane: Locator, side: 'north' | 'south' | 'east' | 'west') => Promise<void>;
  type: (target: Locator, text: string) => Promise<void>;
  press: (target: Locator, key: string) => Promise<void>;
  hold: (ms: number) => Promise<void>;
  /** Until no turn is live and no judgement is pending anywhere. */
  idle: (timeoutMs?: number, opts?: { approve?: boolean }) => Promise<void>;
  /** The window hides to the tray (the film composes the desktop); nothing comes up while the work goes on. */
  leave: () => Promise<void>;
  /** Back from the tray: Show window. */
  back: () => Promise<void>;
  /** A step that only shows the UI: the shoot logs a failure and carries on, the film stops. */
  attempt: (what: string, fn: () => Promise<void>) => Promise<void>;
  log: (msg: string) => void;
};

/**
 * From a tab's middle to just inside a pane's edge: 8% of the pane's smaller side, well within the
 * workbench's edge band (22% of it, 32 to 96 px) at any camera scale.
 */
export async function dragPath(source: Locator, pane: Locator, side: 'north' | 'south' | 'east' | 'west') {
  const a = await source.boundingBox();
  const b = await pane.boundingBox();
  if (!a || !b) throw new Error('nothing to drag, or nowhere to drop it');
  const inset = Math.min(b.width, b.height) * 0.08;
  const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const to =
    side === 'east'
      ? { x: b.x + b.width - inset, y: b.y + b.height / 2 }
      : side === 'west'
        ? { x: b.x + inset, y: b.y + b.height / 2 }
        : side === 'south'
          ? { x: b.x + b.width / 2, y: b.y + b.height - inset }
          : { x: b.x + b.width / 2, y: b.y + inset };
  return { from, to };
}

const re = (zh: string, en: string) => new RegExp(`${zh}|${en}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const items = (x: any): any[] => (Array.isArray(x) ? x : (x?.items ?? []));

/** A ticket that hands over a file or an answer: every one, now that tickets are made for delivery. */
const stageOf = (ticket: any): string => ticket.stage ?? ticket.status ?? '';

export async function playStory(s: Stage): Promise<void> {
  const t = TEXT[s.lang];
  const app = s.app;
  /**
   * The conversation's pane: the one with a composer. Not the focused one, which is the board's once
   * a pill or a ticket there was clicked, and has no composer to type the stop into.
   */
  const chat = () => app.locator('.wb-leaf').filter({ has: app.locator('.composer-input') }).first();
  const follow = () =>
    chat()
      .locator('.stream')
      .first()
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }))
      .catch(() => {});
  const composer = () => chat().locator('.composer-input');

  /* The daemon's state, read the way the board reads it. */
  const bots = async () => items(await s.api('GET', '/v1/bots'));
  const sessions = async () => items(await s.api('GET', '/v1/sessions'));
  /**
   * The job your line opened in that conversation, named after the line (its first 40 characters).
   * The conversation's list also carries jobs from elsewhere that worked there, such as the one in
   * the Producer's direct that made the group: the first item is not always yours.
   */
  const planOf = async (sessionId: string, line: string) => {
    const said = line.replace(/\s+/g, ' ').trim();
    return items(await s.api('GET', `/v1/sessions/${sessionId}/tasks`)).find((x: any) => x.session_id === sessionId && said.startsWith(x.title)) ?? null;
  };
  const detail = async (planId: string) => s.api('GET', `/v1/tasks/${planId}`);
  const holdsInForce = async () => items(await s.api('GET', '/v1/holds'));
  const groupLines = async (sessionId: string) => {
    const page = await s.api('GET', `/v1/sessions/${sessionId}/messages?limit=60`);
    return items(page.items ? page : { items: page.messages ?? page });
  };
  /** Whether a render of the job is still out. No route lists renders, so the demo daemon's own database is read. */
  const renderOut = (planId: string): boolean => {
    try {
      const sql = `SELECT count(*) FROM external_jobs WHERE task_id = '${planId}' AND state = 'pending'`;
      return Number(execFileSync('sqlite3', ['-readonly', '/private/tmp/deskfolk-demo/data/state.sqlite', sql], { encoding: 'utf-8' }).trim()) > 0;
    } catch {
      return false;
    }
  };
  const until = async <T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read().catch(() => null);
      if (value) return value as T;
      await sleep(everyMs);
    }
    throw new Error(`waited too long for ${what}`);
  };
  /**
   * What only you can give while the story waits, given off camera the way the old film's idle did:
   * an approval the story is not showing, and a Bot's question. Cards on the board side are the
   * story's to press on camera (`releaseCards`).
   */
  const answered = new Set<string>();
  const unblock = async (approve: boolean) => {
    if (approve) {
      for (const a of items(await s.api('GET', '/v1/approvals?status=pending'))) {
        const age = Date.now() - Date.parse(a.created_at ?? new Date().toISOString());
        if (age < 2500) continue;
        s.log(`approving ${a.kind ?? ''} ${String(a.summary ?? a.target ?? '').slice(0, 80)}`);
        await s.api('POST', `/v1/approvals/${a.id}/resolve`, { action: 'allow_once' }).catch(() => {});
      }
    }
    for (const x of await sessions()) {
      for (const turn of x.live_turns ?? []) {
        if (turn.status !== 'waiting_ask' || !turn.pending_ask_id || answered.has(turn.pending_ask_id)) continue;
        answered.add(turn.pending_ask_id);
        s.log(`answering a question in ${x.name}`);
        await s.api('POST', `/v1/messages/${turn.pending_ask_id}/answer`, {
          custom: s.lang === 'zh' ? '你来定，按最合理的方案做。' : 'Your call; go with the most sensible option.'
        });
      }
    }
  };

  /* 1 · First-run wizard */
  await s.scene(1);
  await app.locator('.onboarding-card').waitFor({ timeout: 60_000 });
  await s.focus(app.locator('.onboarding-card'));
  await s.click(app.getByRole('button', { name: re('使用推荐目录', 'Use recommended') }));
  await s.hold(500);
  await s.click(app.locator('.onboarding-card .btn-step-primary'));
  await s.type(app.locator('#onboarding-provider-name'), t.providerName);
  await s.type(app.locator('#onboarding-endpoint'), t.endpoint);
  await s.type(app.locator('#onboarding-endpoint-key'), t.key);
  // Typing both fields fetches the models after a pause the story cannot see; fetch them outright.
  const fetchModels = app.locator('.btn-fetch-models-mini');
  await s.click(fetchModels);
  await s.hold(500);
  await app.locator('.btn-fetch-models-mini:not([disabled])').waitFor({ timeout: 30_000 });
  await s.click(app.locator('.onboarding-card .btn-step-primary'));
  await app.locator('.model-chip', { hasText: t.defaultModel }).first().waitFor({ timeout: 30_000 });
  await s.hold(700);
  await s.click(app.locator('#onboarding-default-model'));
  await s.click(app.getByRole('option', { name: t.defaultModel, exact: true }));
  await s.hold(400);
  await s.click(app.locator('.onboarding-card .btn-step-primary'));
  // Saving setup on an empty roster leads on to the wizard's last step: a way of working and the first Bots.
  await app.locator('[data-team-step]').waitFor({ timeout: 30_000 });
  await s.focus(null);

  // Off camera: the image and video server, as it would already be in a lived-in setup.
  await s.api('POST', '/v1/mcp-servers', { name: 'grok-imagine', url: 'http://127.0.0.1:8100/mcp', auth: 'demo-token' });
  for (let i = 0; i < 60; i++) {
    const server = items(await s.api('GET', '/v1/mcp-servers')).find((x: any) => x.name === 'grok-imagine');
    const tools = server?.tool_catalog;
    if (tools && (Array.isArray(tools) ? tools.length : tools.tools?.length)) break;
    await sleep(500);
  }

  /*
   * 2 · The way of working, video, and the first Bot: its director template made into the Producer.
   * Only the one Bot: it brings in the Reviewer itself in step 3. Its direct runs the video engine.
   */
  await s.scene(2);
  const card = app.locator('.onboarding-card');
  await s.focus(card);
  await s.click(app.locator('[data-team-way="video"]'));
  await app.locator('[data-team-template="director"]').waitFor({ timeout: 10_000 });
  await s.hold(600);
  for (const id of ['writer', 'subtitler', 'reviewer']) {
    const pick = app.locator(`[data-team-pick="${id}"]`);
    if ((await pick.count()) && (await pick.isChecked())) await s.click(pick);
  }
  const director = app.locator('[data-team-template="director"]');
  await s.click(director.locator('.team-edit'));
  await s.type(app.locator('[data-team-name="director"]'), t.producer.name);
  const fields = director.locator('.team-fields textarea');
  await s.type(fields.nth(0), t.producer.duties);
  await s.type(fields.nth(1), t.producer.boundaries);
  await s.click(director.locator('.team-edit'));
  await s.hold(500);
  await s.click(app.locator('[data-team-create]'));
  await app.locator('.onboarding-screen').waitFor({ state: 'detached', timeout: 30_000 });
  await s.focus(null);

  /* 3 · One line, and it brings in the Reviewer and makes the group */
  await s.scene(3);
  await composer().waitFor();
  await s.type(composer(), t.teamAsk);
  await s.press(composer(), 'Enter');
  const reviewer = await until('the Reviewer', async () => (await bots()).find((b: any) => b.name === t.reviewerName), 10 * 60_000);
  const group = await until(
    'the group with both Bots',
    async () => (await sessions()).find((x: any) => x.kind === 'group' && x.name === t.groupName),
    10 * 60_000
  );
  await s.idle(10 * 60_000);
  const producer = (await bots()).find((b: any) => b.name === t.producer.name);
  if (!producer) throw new Error('no Producer on the roster');
  // Off camera: the Reviewer on a model of its own, and the Producer confirmed as the group's lead,
  // so a line to the group goes to it and it may lay out the tickets.
  await s.api('PATCH', `/v1/bots/${reviewer.id}`, { model: t.reviewerModel });
  await s.api('PUT', `/v1/sessions/${group.id}/lead`, { bot_id: producer.id, confirmed: true });
  const groupRow = app.locator('.groups .row', { hasText: t.groupName }).first();
  await groupRow.waitFor({ timeout: 60_000 });
  // A group a Bot makes follows the default engine, general. This job is a film: in the group's
  // actions it goes on video, before the goal is said, so the scribe writes your asks down from it.
  const engineOf = async () => (await sessions()).find((x: any) => x.id === group.id)?.playbook_id ?? null;
  await s.attempt('group engine', async () => {
    await s.click(groupRow);
    await composer().waitFor();
    // Group settings: a side of the conversation's pane, toggled from its tab's menu.
    const groupTab = app
      .locator('.wb-tab', { hasText: t.groupName })
      .filter({ hasNot: app.locator('.wb-tab-icon[data-kind="trace"]') })
      .first();
    const toggleSettings = async () => {
      await s.hover(groupTab);
      await s.click(groupTab.locator('.wb-tab-more'));
      await s.click(app.locator('[data-testid="wb-context-menu"] [data-action="settings"]'));
    };
    await toggleSettings();
    const picker = app.locator('.pane-side [data-playbook-picker]').first();
    await picker.waitFor({ timeout: 10_000 });
    await s.focus(picker);
    await s.hold(600);
    await s.click(picker.locator('button').first());
    await s.click(app.getByRole('option', { name: re('^视频$', '^Video$') }).first());
    await until('the group on video', async () => (await engineOf()) === 'video', 10_000, 300);
    await s.hold(900);
    await s.focus(null);
    await toggleSettings();
    await picker.waitFor({ state: 'hidden', timeout: 10_000 });
  });
  if ((await engineOf()) !== 'video') {
    s.log('putting the group on video off camera');
    await s.api('PUT', `/v1/sessions/${group.id}/playbook`, { playbook_id: 'video' });
  }

  /* 4 · The job goes to the group: the Producer lays it out in tickets, the Reviewer on each */
  await s.scene(4);
  await s.click(groupRow);
  await composer().waitFor();
  await s.type(composer(), t.goal);
  await s.press(composer(), 'Enter');
  // The plan opens with the Producer's first segment, and your line is filed under it there.
  const plan = await until('the plan', () => planOf(group.id, t.goal), 5 * 60_000);

  const tab = (name: RegExp) => app.locator('.wb-tab', { hasText: name }).first();
  const paneOf = (el: Locator) => app.locator('.wb-leaf').filter({ has: el }).first();
  /** The job's one tab (ADR 0086), told by its icon: the titles differ by language. */
  const flowTab = () => app.locator('.wb-tab').filter({ has: app.locator('.wb-tab-icon[data-kind="trace"]') }).first();
  const artifactTab = () => tab(re('的产物', 'artifacts'));
  const chatTab = () =>
    app
      .locator('.wb-tab', { hasText: t.groupName })
      .filter({ hasNot: app.locator('.wb-tab-icon[data-kind="trace"]') })
      .filter({ hasNotText: re('的产物', 'artifacts') })
      .first();
  /**
   * The job's tab: the rail of tickets, the flow and the inspector side by side, laid out by its own
   * width (ADR 0086). The inspector shows the whole job's plan while nothing is picked.
   */
  const job = () => app.locator('.job-pane').first();
  const inspector = () => job().locator('.job-inspector').first();
  /** The inspector's widen button: the plan over the whole tab, in its two columns. */
  const widen = () => inspector().locator('.insp-head .insp-icon[aria-pressed]').first();
  const setWide = async (on: boolean) => {
    const button = widen();
    if (!(await button.count())) return;
    if (((await button.getAttribute('aria-pressed')) === 'true') !== on) await s.click(button);
  };
  /**
   * The whole job's plan: standing in the inspector on a wide tab with nothing picked; a medium tab
   * asks for it from its title row, a narrow one shows it as its third part.
   */
  const showPlan = async () => {
    const plan = job().locator('.job-inspector-inner[data-inspector="spec"]');
    if (!(await plan.count())) {
      const toggle = job().locator('.job-chip.is-toggle');
      if (await toggle.count()) await s.click(toggle.first());
      else await s.click(job().locator('.trace-view-tab').last());
    }
    await plan.first().waitFor({ timeout: 10_000 });
  };

  // Off camera: the Reviewer on every ticket the Producer left without one, as soon as the tickets
  // exist and before anything is handed over, so a replay reaches the same reviews.
  const nameReviewer = async () => {
    for (const x of (await detail(plan.id)).tickets ?? []) {
      if (x.reviewer_bot_id || x.owner_bot_id === reviewer.id) continue;
      s.log(`naming the Reviewer on ${x.id} off camera`);
      await s.api('PATCH', `/v1/tickets/${x.id}`, { reviewer_bot_id: reviewer.id }).catch(() => {});
    }
  };
  // The tickets come when the Producer lays them out, mid-segment: watched for beside the story.
  let watching = true;
  const reviewerWatch = (async () => {
    while (watching) {
      await nameReviewer().catch(() => {});
      await sleep(300);
    }
  })();

  await s.attempt('job tab', async () => {
    await s.hover(chatTab());
    await s.click(chatTab().locator('.wb-tab-more'));
    await s.click(app.locator('[data-testid="wb-context-menu"] [data-action="trace"]'));
    await job().waitFor({ timeout: 20_000 });
    await s.hold(700);
    await s.drag(flowTab().locator('.wb-tab-button').first(), paneOf(chatTab()), 'south');
    await app.locator('.wb-leaf').nth(1).waitFor({ timeout: 10_000 });
    // The tickets it laid out on the rail, who makes each and the Reviewer on it
    const rail = job().locator('.ticket-rail');
    await rail.locator('.rail-row').first().waitFor({ timeout: 60_000 });
    await rail.locator('.rail-avatar.is-reviewer').first().waitFor({ timeout: 15_000 }).catch(() => {});
    await s.focus(rail);
    await s.hold(2200);
    // The engine the job runs on, in its title row
    const engine = job().locator('.job-chip[title]').first();
    if (await engine.count()) {
      await s.focus(engine);
      await s.hold(1100);
    }
    await s.focus(null);
  });

  /* 5 · Outside the workspace, it asks first; then your asks, written up, and what counts as done */
  const approval = app.locator('.msg.is-approval').filter({ has: app.locator('.approval-acts button') }).first();
  // Questions answered meanwhile, approvals not: this one is pressed on camera.
  await until('the approval card', async () => {
    await unblock(false);
    return (await approval.count()) > 0;
  }, 15 * 60_000).catch(() => s.log('no approval card came up'));
  await s.scene(5);
  await follow();
  await s.focus(approval);
  await s.hold(900);
  await s.attempt('approve', () => s.click(approval.getByRole('button', { name: re('允许一次', 'Allow once') })));
  await s.focus(null);
  await follow();
  // The render goes out a moment after the approval and can be back within a minute: catch it out.
  const rendering = async () => renderOut(plan.id) || ((await detail(plan.id)).tickets ?? []).some((x: any) => x.ball?.kind === 'app' && x.ball?.reason === 'job');
  const out = await until(
    'the render out',
    async () => {
      await unblock(true);
      return rendering();
    },
    15 * 60_000,
    500
  ).catch(() => false);

  /* 6 · You leave; the app polls the render itself */
  await s.scene(6);
  await s.leave();
  if (out) {
    await s.hold(2400);
    await until('the render in', async () => {
      await unblock(true);
      return !(await rendering());
    }, 40 * 60_000, 1000).catch(() => {});
  } else {
    s.log('no render to wait on: going on from a quiet moment');
    await s.idle(10 * 60_000).catch(() => {});
  }
  await s.hold(1600);
  await s.back();

  /* 7 · What counts as done, from your words; then a stop for now, and your next word sets it going again */
  await s.scene(7);
  // The numbers in your line become checks once the segment that filed it ends (it ends handing the
  // render to the app), and the plan is written up after it has been quiet a moment: offers on the
  // board, gates only once you confirm them.
  await until(
    'your asks written up, and checks proposed from your words',
    async () => {
      await unblock(true);
      const d = await detail(plan.id);
      const offered = (d.checks ?? []).filter((c: any) => c.origin === 'derived' && c.derived_state === 'proposed').length;
      return Boolean(d.spec) && offered >= 2;
    },
    45 * 60_000
  );
  await s.attempt('asks and checks', async () => {
    await showPlan();
    await setWide(true);
    // Your requirements, each on your own words
    const asks = job().locator('.plan-req').first();
    await asks.waitFor({ timeout: 30_000 });
    await s.focus(asks.locator('xpath=..'));
    await s.hold(2200);
    for (let i = 0; i < 4; i++) {
      const proposed = job().locator('.plan-spec-checks-orphans .check-pill').filter({ has: app.locator('.check-pill-label') });
      const pills = await proposed.all();
      let confirmed = false;
      for (const pill of pills) {
        await s.focus(pill);
        await s.click(pill);
        const confirm = job().locator('.check-confirm').first();
        if (await confirm.isVisible().catch(() => false)) {
          await s.click(confirm);
          await s.hold(700);
          confirmed = true;
          break;
        }
        await s.click(pill);
      }
      if (!confirmed) break;
    }
    await s.focus(null);
  });
  for (const c of (await detail(plan.id)).checks ?? []) {
    if (c.origin !== 'derived' || c.derived_state !== 'proposed') continue;
    s.log(`confirming check ${c.id} off camera`);
    await s.api('POST', `/v1/checks/${c.id}/confirm`).catch(() => {});
  }
  watching = false;
  await reviewerWatch;
  await nameReviewer();
  /**
   * Hand-overs waiting on your word (ADR 0084): no card, no notification; what you say next about
   * one lets it through. Said on camera, in the group. Still waiting two minutes after you said it,
   * it is said once more, then approved on the board off camera.
   */
  const submissionsOf = async () => items(await s.api('GET', `/v1/tasks/${plan.id}/submissions`));
  const awaitingWord = async () =>
    (await submissionsOf()).filter((sub: any) => sub.awaiting?.kind === 'approval' && !['approved', 'rejected', 'superseded'].includes(sub.state));
  const passedAt = new Map<string, number[]>();
  const passWaiting = async () => {
    const waiting = await awaitingWord();
    const due = waiting.filter((sub: any) => {
      const said = passedAt.get(sub.id) ?? [];
      return said.length === 0 || (said.length < 3 && Date.now() - said.at(-1)! > 2 * 60_000);
    });
    if (due.length === 0) return;
    const said = passedAt.get(due[0].id) ?? [];
    if (said.length < 2) {
      await follow();
      await s.type(composer(), t.pass);
      await s.press(composer(), 'Enter');
    } else {
      s.log(`approving ticket ${due[0].ticket_id} on the board off camera`);
      await s.api('PATCH', `/v1/tickets/${due[0].ticket_id}`, { status: 'approved' }).catch(() => {});
    }
    for (const sub of due) passedAt.set(sub.id, [...(passedAt.get(sub.id) ?? []), Date.now()]);
    await sleep(1500);
  };
  // Your stop and change land on work at rest: every ticket through, nobody at work, no render out.
  // Said while a turn runs, they race it, and a replay (answers far faster than a model) would have
  // the Producer past them before they are said.
  let restSince = 0;
  await until('the work at rest', async () => {
    await unblock(true);
    await passWaiting();
    const tickets = (await detail(plan.id)).tickets ?? [];
    const through = tickets.length > 0 && tickets.every((x: any) => ['approved', 'done', 'dropped'].includes(stageOf(x)));
    const busy = (await sessions()).some((x: any) => (x.live_turns ?? []).length > 0);
    const rest = through && !busy && !(await rendering());
    restSince = rest ? restSince || Date.now() : 0;
    return rest && Date.now() - restSince > 3000;
  }, 30 * 60_000, 1000);

  await follow();
  // Your stop, told from any hold already standing: a new id in force, then that id lifted.
  const standing = new Set((await holdsInForce()).map((h: any) => h.id));
  await s.type(composer(), t.stop);
  await s.press(composer(), 'Enter');
  const freshStop = async () => (await holdsInForce()).find((h: any) => !standing.has(h.id));
  const stop = await until('the stop in force', freshStop, 30_000, 500).catch(() => null);
  if (!stop) {
    // The reader did not read your line in time, so it went to the Bot as any line (ADR 0070): the
    // stop is placed off camera once the Bot has answered, as the Stop button would place it.
    await until('nobody at work', async () => !(await sessions()).some((x: any) => (x.live_turns ?? []).length > 0), 3 * 60_000, 1000).catch(() => {});
    s.log('placing the stop off camera');
    await s.api('POST', '/v1/holds', { scope: 'session', scope_id: group.id });
    await until('the stop in force', freshStop, 10_000, 500);
  }
  await s.hold(1600);
  await s.type(composer(), t.change);
  await s.press(composer(), 'Enter');
  const changedAt: string = await until(
    'your change',
    async () => (await groupLines(group.id)).filter((m: any) => m.kind === 'user' && m.body === t.change).at(-1)?.created_at ?? null,
    30_000,
    500
  );
  // Your change sets the Producer going again (a stop is for now): let it get to a resting point,
  // its approvals given off camera (left waiting, a command outside the workspace stalls it here).
  await s.idle(5 * 60_000).catch(() => s.log('still at work after your change'));
  // The render still out when you stopped finishes while the stop holds, and the app keeps its
  // result until you go on. Both shoots had it so, by seconds; waiting makes it the order a replay
  // keeps too, whatever its pace.
  await until('the render in', async () => !renderOut(plan.id), 10 * 60_000, 1000).catch(() => {});
  await s.hold(1200);

  /* 8 · Done has a definition: checks the app runs, a review with evidence, your word */
  await s.scene(8);
  const seenFailed = new Set<string>();
  await until(
    'every ticket through',
    async () => {
      await unblock(true);
      // A hand-over that waits on you (a text answer always does): your word, on camera.
      await passWaiting();
      // A hand-over the checks sent back: the board shows which one failed.
      for (const sub of await submissionsOf()) {
        if (sub.state !== 'checks_failed' || seenFailed.has(sub.id)) continue;
        seenFailed.add(sub.id);
        await s.attempt('failed check', async () => {
          await showPlan();
          const failing = job().locator('.check-pill.is-fail').first();
          await s.focus((await failing.count()) ? failing : inspector());
          await s.hold(2400);
          await s.focus(null);
        });
      }
      await follow();
      const tickets = (await detail(plan.id)).tickets ?? [];
      const through = tickets.length > 0 && tickets.every((x: any) => ['approved', 'done', 'dropped'].includes(stageOf(x)));
      // Your change: a hand-over made after it, approved, with nothing still being checked or reviewed.
      const subs = await submissionsOf();
      const open = subs.some((sub: any) => ['checking', 'submitted', 'in_review'].includes(sub.state));
      // And nothing still waiting on your word: coming back, the work is settled.
      const waiting = (await awaitingWord()).length > 0;
      return through && !open && !waiting && subs.some((sub: any) => sub.created_at > changedAt && sub.state === 'approved');
    },
    90 * 60_000,
    1500
  );
  // The reviewer's turn ends a moment after its approval: ask once nobody is at work, or the answer
  // lists it as still going (a quiet moment is the point of coming back).
  await until('nobody at work', async () => !(await sessions()).some((x: any) => (x.live_turns ?? []).length > 0), 3 * 60_000, 1000).catch(() => {});
  await s.hold(1500);

  /* 9 · Back to the result: ask how it went, see it on the board, play it beside the chat */
  await s.scene(9);
  await s.type(composer(), t.status);
  await s.press(composer(), 'Enter');
  const askedAt: string = await until(
    'your question',
    async () => (await groupLines(group.id)).filter((m: any) => m.kind === 'user' && m.body === t.status).at(-1)?.created_at ?? null,
    30_000,
    500
  );
  const reply = await until(
    'the answer',
    async () => {
      const m = (await groupLines(group.id)).find((x: any) => x.kind !== 'user' && x.kind !== 'system' && x.created_at > askedAt && x.body?.trim());
      const busy = (await sessions()).some((x: any) => (x.live_turns ?? []).length > 0);
      return m && !busy ? m : null;
    },
    5 * 60_000,
    500
  );
  await follow();
  await sleep(800);
  const answer = chat().locator(`[data-message-id="${reply.id}"]`).or(chat().locator('[data-message-id]').last()).first();
  await s.focus(answer);
  await s.hold(2600);
  await s.attempt('artifact pane', async () => {
    await follow();
    // The film the Producer delivered, in the job's own folder (work/<job>/launch/…): the hand-over's
    // chip when it handed over that one file, its bundle when it handed over two or more (the paths
    // in its title), else a link to it in a message (`artifact:` + the path URI-encoded, its folders
    // in the text but out of sight). The hand-over first: a path a reply writes is read from the
    // workspace's root, and the Bot's own folder may not be there.
    const film = /\.(mp4|mov|webm)$/;
    const handedOver = app.locator('.attachment-file-btn[title*="launch/"][title$=".mp4"], .attachment-bundle-btn[title*="launch/"][title*=".mp4"]').last();
    const video = (await handedOver.count())
      ? handedOver
      : app.locator('[data-message-id] a.md-artifact-link[href*="launch%2F"]', { hasText: film }).last();
    if (!(await video.count())) {
      s.log('no link to a film in launch/ in the chat');
      return;
    }
    await s.focus(video);
    await s.click(video);
    const pane = app.locator('.artifact-pane');
    await pane.waitFor({ timeout: 20_000 });
    // A bundle opens on its first file: the film is picked in its tree if that was another.
    if (!(await pane.locator('video').first().waitFor({ timeout: 3000 }).then(() => true, () => false))) {
      const row = pane.getByText(film).first();
      if (await row.count()) await s.click(row);
    }
    await s.focus(null);
    await s.hold(700);
    await s.drag(artifactTab().locator('.wb-tab-button').first(), paneOf(chatTab()), 'east');
    await app.locator('.wb-leaf').nth(2).waitFor({ timeout: 10_000 });
    // The board: the rail opened out over the rail and the flow, every ticket through.
    await setWide(false);
    const expand = job().locator('.rail-expand').first();
    if (await expand.count()) {
      await s.click(expand);
      await job().locator('.job-board').waitFor({ timeout: 10_000 });
    }
    const player = app.locator('.artifact-pane video').first();
    if (await player.count()) {
      await s.focus(player);
      await s.hover(player);
      await player.evaluate((v: HTMLVideoElement) => {
        v.muted = true;
        void v.play();
      });
    }
    await s.hold(3600);
    await s.focus(null);
    await s.hold(1800);
  });
}
