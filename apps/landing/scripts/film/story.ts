/**
 * The promo's story, played on the real messenger against the isolated demo daemon: you hand a
 * 6-second promo film and its tagline to a Producer, which brings in a Reviewer,
 * and walk away; your numbers become checks the app runs, a stop holds until you lift it, and what
 * is handed over moves only on those checks and the Reviewer's evidence. The same steps run for the
 * shoot (real models, recorded) and for every replay (the tape answers), so a replay reaches the
 * same states in the same order. Every wait reads the daemon's state (tickets' stages, the ball on
 * them, holds, submissions), not "no turn is live": from engine level 6 a Bot's turn ends while the
 * app polls its render, and the story must not run ahead of that.
 */
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
  const focused = () => app.locator('.wb-leaf.is-focused');
  const follow = () =>
    focused()
      .locator('.stream')
      .first()
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }))
      .catch(() => {});
  const composer = () => focused().locator('.composer-input');

  /* The daemon's state, read the way the board reads it. */
  const bots = async () => items(await s.api('GET', '/v1/bots'));
  const sessions = async () => items(await s.api('GET', '/v1/sessions'));
  const planOf = async (sessionId: string) => items(await s.api('GET', `/v1/sessions/${sessionId}/tasks`))[0] ?? null;
  const detail = async (planId: string) => s.api('GET', `/v1/tasks/${planId}`);
  const holdsInForce = async () => items(await s.api('GET', '/v1/holds'));
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
  // Saving setup on an empty roster leads on to the wizard's last step, the first Bot.
  await app.locator('#onboarding-bot-name').waitFor({ timeout: 30_000 });
  await s.focus(null);

  // Off camera: the image and video server, as it would already be in a lived-in setup.
  await s.api('POST', '/v1/mcp-servers', { name: 'grok-imagine', url: 'http://127.0.0.1:8100/mcp', auth: 'demo-token' });
  for (let i = 0; i < 60; i++) {
    const server = items(await s.api('GET', '/v1/mcp-servers')).find((x: any) => x.name === 'grok-imagine');
    const tools = server?.tool_catalog;
    if (tools && (Array.isArray(tools) ? tools.length : tools.tools?.length)) break;
    await sleep(500);
  }

  /* 2 · The first Bot, the Producer, made in the wizard's last step over the suggested one */
  await s.scene(2);
  const card = app.locator('.onboarding-card');
  await s.focus(card);
  await s.type(app.locator('#onboarding-bot-name'), t.producer.name);
  await s.type(app.locator('#onboarding-bot-duties'), t.producer.duties);
  await s.type(app.locator('#onboarding-bot-boundaries'), t.producer.boundaries);
  await s.click(card.locator('.step-nav-footer .btn-step-primary'));
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

  /* 4 · The job goes to the group: the Producer lays it out in tickets, the Reviewer on each */
  await s.scene(4);
  await s.click(groupRow);
  await composer().waitFor();
  await s.type(composer(), t.goal);
  await s.press(composer(), 'Enter');
  // The plan opens with the Producer's first segment, and your line is filed under it there.
  const plan = await until('the plan', () => planOf(group.id), 5 * 60_000);

  const tab = (name: RegExp) => app.locator('.wb-tab', { hasText: name }).first();
  const paneOf = (el: Locator) => app.locator('.wb-leaf').filter({ has: el }).first();
  const flowTab = () => tab(re('流程', ' flow'));
  const artifactTab = () => tab(re('的产物', 'artifacts'));
  const chatTab = () =>
    app.locator('.wb-tab', { hasText: t.groupName }).filter({ hasNotText: re('的产物|流程', 'artifacts| flow') }).first();
  const board = () => app.locator('.trace-pane').first();
  /** The board's Plan / Tickets panel: a tab on a narrow pane, a toggle beside the board on a wide one. */
  const boardTab = async (name: RegExp) => {
    const segment = board().getByRole('tab', { name }).first();
    if (await segment.count()) {
      if ((await segment.getAttribute('aria-selected')) !== 'true') await s.click(segment);
      return;
    }
    // By its name: the toggle's text starts with the space before its icon.
    const toggle = board().locator('.trace-side-toggles').getByRole('button', { name }).first();
    if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) !== 'true') await s.click(toggle);
  };

  await s.attempt('board', async () => {
    await s.hover(chatTab());
    await s.click(chatTab().locator('.wb-tab-more'));
    await s.click(app.locator('[data-testid="wb-context-menu"] [data-action="trace"]'));
    await board().waitFor({ timeout: 20_000 });
    await s.hold(700);
    await s.drag(flowTab().locator('.wb-tab-button').first(), paneOf(chatTab()), 'south');
    await app.locator('.wb-leaf').nth(1).waitFor({ timeout: 10_000 });
    // The tickets it laid out, the Reviewer on each
    await boardTab(re('^任务', '^Tickets'));
    const rows = board().locator('.ticket-row');
    await rows.first().waitFor({ timeout: 60_000 });
    await s.focus(rows.first().locator('xpath=..'));
    await s.hold(2200);
    await s.focus(null);
  });

  /* 5 · Outside the workspace, it asks first; then your asks, written up, and what counts as done */
  const approval = app.locator('.msg.is-approval').filter({ has: app.locator('.approval-acts button') }).first();
  await until('the approval card', async () => (await approval.count()) > 0, 15 * 60_000);
  await s.scene(5);
  await follow();
  await s.focus(approval);
  await s.hold(900);
  await s.attempt('approve', () => s.click(approval.getByRole('button', { name: re('允许一次', 'Allow once') })));
  await s.focus(null);
  await follow();
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
    // The segment makes its pictures first, and an image can take minutes on a slow day.
    45 * 60_000
  );
  await s.attempt('asks and checks', async () => {
    await boardTab(re('^要点$', '^Plan$'));
    // Your requirements, each on your own words
    const asks = board().locator('.plan-req').first();
    await asks.waitFor({ timeout: 30_000 });
    await s.focus(asks.locator('xpath=..'));
    await s.hold(2200);
    for (let i = 0; i < 4; i++) {
      const proposed = board().locator('.plan-spec-checks-orphans .check-pill').filter({ has: app.locator('.check-pill-label') });
      const pills = await proposed.all();
      let confirmed = false;
      for (const pill of pills) {
        await s.focus(pill);
        await s.click(pill);
        const confirm = board().locator('.check-confirm').first();
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
  // Who reviews: the Producer may have named the Reviewer when it laid out the tickets; any it left
  // open, you pick on the board.
  await s.attempt('reviewer', async () => {
    const tickets = await until('the tickets', async () => {
      await unblock(true);
      const d = await detail(plan.id);
      return d.tickets?.length ? d.tickets : null;
    }, 10 * 60_000);
    const open = tickets.filter((x: any) => !x.reviewer_bot_id && x.owner_bot_id !== reviewer.id);
    if (!open.length) return;
    await boardTab(re('^任务', '^Tickets'));
    for (const ticket of open) {
      const row = board().locator(`.ticket-row[data-ticket-id="${ticket.id}"]`).first();
      await s.focus(row);
      await s.click(row.locator('.ticket-main'));
      const pick = board().getByRole('combobox', { name: re('审查者', 'Reviewer') }).first();
      await pick.waitFor({ timeout: 10_000 });
      await s.click(pick);
      await s.click(app.getByRole('option', { name: t.reviewerName, exact: true }));
      await s.hold(600);
    }
    await s.focus(null);
  });

  /* 6 · You leave; the app polls the render itself */
  await s.scene(6);
  await s.leave();
  // The stop that follows lands while the Producer waits on the render, with no turn of its to cut.
  // A picture made another way has no render to wait on: then a quiet moment, held for 10 s.
  let quietSince = 0;
  const leftAt = Date.now();
  await until(
    'the render the app polls',
    async () => {
      await unblock(true);
      const d = await detail(plan.id);
      if ((d.tickets ?? []).some((x: any) => x.ball?.kind === 'app' && x.ball?.reason === 'job')) return true;
      const busy = (await sessions()).some((x: any) => (x.live_turns ?? []).length > 0);
      quietSince = busy ? 0 : quietSince || Date.now();
      if (Date.now() - leftAt > 8 * 60_000 && quietSince && Date.now() - quietSince > 10_000) {
        s.log('no render to wait on: going on from a quiet moment');
        return true;
      }
      return false;
    },
    40 * 60_000
  );
  await s.hold(2400);
  await s.back();

  /* 7 · A stop is a state: it holds until you lift it */
  await s.scene(7);
  await follow();
  // Your stop, told from any hold already standing: a new id in force, then that id lifted.
  const standing = new Set((await holdsInForce()).map((h: any) => h.id));
  await s.type(composer(), t.stop);
  await s.press(composer(), 'Enter');
  const stop = await until('the stop in force', async () => (await holdsInForce()).find((h: any) => !standing.has(h.id)), 60_000, 500);
  await s.hold(1600);
  await s.type(composer(), t.change);
  await s.press(composer(), 'Enter');
  await s.idle(5 * 60_000, { approve: false });
  await s.hold(1200);
  await s.type(composer(), t.go);
  await s.press(composer(), 'Enter');
  await until('the stop lifted', async () => !(await holdsInForce()).some((h: any) => h.id === stop.id), 60_000, 500);
  await s.hold(1200);

  /* 8 · Done has a definition: checks the app runs, a review with evidence, your release */
  await s.scene(8);
  const seenFailed = new Set<string>();
  const pressed = new Set<string>();
  await until(
    'every ticket through',
    async () => {
      await unblock(true);
      // A hand-over that lands on your card (a text answer always does): released on camera.
      const page = await s.api('GET', `/v1/sessions/${group.id}/messages?limit=60`);
      for (const m of items(page.items ? page : { items: page.messages ?? page })) {
        if (m.control?.kind !== 'review_item' || pressed.has(m.id) || m.control?.acted?.length) continue;
        const release = app.locator(`[data-message-id="${m.id}"] .control-actions button`, { hasText: re('^放行$', '^Approve$') }).first();
        if (!(await release.count())) continue;
        pressed.add(m.id);
        await follow();
        await s.focus(release);
        await s.hold(700);
        await s.click(release);
        await s.focus(null);
      }
      // A hand-over the checks sent back: the board shows which one failed.
      for (const sub of items(await s.api('GET', `/v1/tasks/${plan.id}/submissions`))) {
        if (sub.state !== 'checks_failed' || seenFailed.has(sub.id)) continue;
        seenFailed.add(sub.id);
        await s.attempt('failed check', async () => {
          await boardTab(re('^要点$', '^Plan$'));
          const failing = board().locator('.check-pill.is-fail').first();
          await s.focus((await failing.count()) ? failing : board());
          await s.hold(2400);
          await s.focus(null);
        });
      }
      await follow();
      const tickets = (await detail(plan.id)).tickets ?? [];
      return tickets.length > 0 && tickets.every((x: any) => ['approved', 'done', 'dropped'].includes(stageOf(x)));
    },
    90 * 60_000,
    1500
  );
  await s.hold(1500);

  /* 9 · Back to the result: ask how it went, see it on the board, play it beside the chat */
  await s.scene(9);
  await s.type(composer(), t.status);
  await s.press(composer(), 'Enter');
  await sleep(1500);
  await follow();
  const answer = focused().locator('[data-message-id]').last();
  await s.focus(answer);
  await s.hold(2600);
  await s.attempt('artifact pane', async () => {
    await follow();
    const film = /^launch\/[^\s/]+\.(mp4|mov|webm)$/;
    const video = app
      .locator('.attachment-file-btn', { hasText: /launch\/[^\s/]+\.(mp4|mov|webm)/ })
      .or(app.locator('[data-message-id]').getByText(film))
      .last();
    if (!(await video.count())) {
      s.log('no link to a film in launch/ in the chat');
      return;
    }
    await s.focus(video);
    await s.click(video);
    await app.locator('.artifact-pane').waitFor({ timeout: 20_000 });
    await s.focus(null);
    await s.hold(700);
    await s.drag(artifactTab().locator('.wb-tab-button').first(), paneOf(chatTab()), 'east');
    await app.locator('.wb-leaf').nth(2).waitFor({ timeout: 10_000 });
    await boardTab(re('^任务', '^Tickets'));
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
