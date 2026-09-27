/**
 * The promo's story, played on the real messenger against the isolated demo daemon: from the
 * first-run wizard to a launch kit (tagline and copy, a poster, a 6-second teaser) made by a team
 * the first Bot hires itself. The same steps run for the shoot (real models, recorded) and for
 * every replay (the tape answers), so a replay reaches the same states in the same order.
 */
import type { Frame, Locator, Page } from 'playwright';

export type Lang = 'zh' | 'en';

export type StoryText = {
  providerName: string;
  endpoint: string;
  key: string;
  defaultModel: string;
  coordinator: { name: string; duties: string; boundaries: string };
  teamAsk: string;
  groupName: string;
  goal: string;
  phoneMention: string;
  phoneAsk: string;
  terminalCommand: string;
};

export const MODELS = ['grk-4.7-build-fast', 'gemini-3.8-flash-high'];

export const TEXT: Record<Lang, StoryText> = {
  zh: {
    providerName: '本地 vLLM',
    endpoint: 'http://127.0.0.1:8000/v1',
    key: 'sk-local-7f3a9c2e41b8',
    defaultModel: 'grk-4.7-build-fast',
    coordinator: {
      name: 'Coordinator',
      duties: '把目标拆成任务，点名分给最合适的队友；队友交付后对照要求验收，最后在群里总结交付。',
      boundaries: '不替队友做他们的活；不反复查看进度，等队友 @ 你；只在工作区里动手。'
    },
    teamAsk:
      '帮我把发布团队搭起来：Writer 写主标语和发布文案；Designer 用 grok-imagine 出竖版海报，存进工作区，做完 @Director；Director 用 grok-imagine 把海报做成 6 秒竖版预告片，下载进工作区，用 ffprobe 核对时长和分辨率，做完 @Coordinator 验收。大家的命令里一律用工作区相对路径。然后建个群「发布」，把你们四个都拉进来。现在只搭团队，先别开工，具体任务我稍后在群里发。',
    groupName: '发布',
    goal:
      '给「晨光」手冲壶做一套发布物料：一句主标语和一段发布文案、一张竖版海报、一段 6 秒预告片，都放进 launch/。品牌 logo 在 /Users/Shared/dawn-brand/logo.png，先拷进 launch/ 再用，海报上要带上它。',
    phoneMention: 'Writer',
    phoneAsk: '再给一版英文主标语，放进 launch/copy.md 末尾。',
    terminalCommand: 'du -sh launch/*'
  },
  en: {
    providerName: 'Local vLLM',
    endpoint: 'http://127.0.0.1:8000/v1',
    key: 'sk-local-7f3a9c2e41b8',
    defaultModel: 'grk-4.7-build-fast',
    coordinator: {
      name: 'Coordinator',
      duties: 'Break the goal into tasks and name the best teammate for each; when they deliver, check it against the ask and sum up the delivery in the group.',
      boundaries: 'Never do a teammate’s work; don’t keep checking on progress, wait for an @; act only inside the workspace.'
    },
    teamAsk:
      'Set up the launch team for me: Writer writes the tagline and launch copy; Designer makes a vertical poster with grok-imagine, saves it in the workspace, then @Director; Director turns the poster into a 6-second vertical teaser with grok-imagine, downloads it into the workspace, checks its length and size with ffprobe, then @Coordinator to review. Everyone uses workspace-relative paths in commands. Then make a group called “Launch” with all four of you. Only set up the team for now; don’t start any work, I’ll post the task in the group.',
    groupName: 'Launch',
    goal:
      'Make a launch kit for the “Dawn” pour-over kettle: a tagline and a short launch blurb, a vertical poster, and a 6-second teaser, all in launch/. The brand logo is at /Users/Shared/dawn-brand/logo.png; copy it into launch/ first, and the poster must carry it.',
    phoneMention: 'Writer',
    phoneAsk: 'Add a Chinese tagline too, at the end of launch/copy.md.',
    terminalCommand: 'du -sh launch/*'
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
  /** Step 10: the window hides to the tray and the finished work comes back as a banner (film only). */
  tray: () => Promise<void>;
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
  await app.locator('.onboarding-screen').waitFor({ state: 'detached', timeout: 30_000 });
  await s.focus(null);

  // Off camera: the image and video server, as it would already be in a lived-in setup.
  await s.api('POST', '/v1/mcp-servers', { name: 'grok-imagine', url: 'http://127.0.0.1:8100/mcp', auth: 'demo-token' });
  for (let i = 0; i < 60; i++) {
    const list = await s.api('GET', '/v1/mcp-servers');
    const server = (Array.isArray(list) ? list : list.items).find((x: any) => x.name === 'grok-imagine');
    const tools = server?.tool_catalog;
    if (tools && (Array.isArray(tools) ? tools.length : tools.tools?.length)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  /* 2 · The first Bot */
  await s.scene(2);
  await s.click(app.locator(`button.add[title="${s.lang === 'zh' ? '新建 Bot' : 'New bot'}"]`));
  const sheet = app.locator('.create-bot-modal');
  await sheet.waitFor();
  await s.focus(sheet);
  await s.type(app.locator('#bot-name'), t.coordinator.name);
  await s.type(app.locator('#bot-duties'), t.coordinator.duties);
  await s.type(app.locator('#bot-boundaries'), t.coordinator.boundaries);
  await s.click(sheet.locator('.modal-foot.actions button').first());
  await sheet.waitFor({ state: 'detached' });
  await s.focus(null);

  /* 3 · It hires the rest */
  await s.scene(3);
  const composer = () => focused().locator('.composer-input');
  await composer().waitFor();
  await s.type(composer(), t.teamAsk);
  await s.press(composer(), 'Enter');
  await s.idle();
  const groupRow = app.locator('.groups .row', { hasText: t.groupName }).first();
  await groupRow.waitFor({ timeout: 60_000 });

  /* 4 · The goal goes to the group; the unmentioned decide */
  await s.scene(4);
  await s.click(groupRow);
  await composer().waitFor();
  await s.type(composer(), t.goal);
  await s.press(composer(), 'Enter');

  /* 5 · The approval card: reading the logo outside the workspace */
  const approval = app.locator('.msg.is-approval').filter({ has: app.locator('.approval-acts button') }).first();
  // Waiting without approving anything, so the card is still there to click.
  const shown = await Promise.race([
    approval.waitFor({ timeout: 15 * 60_000 }).then(() => true),
    s.idle(15 * 60_000, { approve: false }).then(
      () => false,
      () => false
    )
  ]);
  await s.scene(5);
  if (shown && (await approval.count())) {
    await s.focus(approval);
    await s.hold(900);
    await s.attempt('approve', () => s.click(approval.getByRole('button', { name: re('允许一次', 'Allow once') })));
    await s.focus(null);
    // Reaching the card scrolled the chat off the bottom; back down, and it follows new messages again.
    await follow();
  } else s.log('no approval card came up');

  /* 6 · Handoffs and commands */
  await s.scene(6);
  await s.idle(25 * 60_000);

  /* 7–9 · Artifact, flow and terminal beside the conversation: one screen, four panes */
  const tab = (name: RegExp) => app.locator('.wb-tab', { hasText: name }).first();
  const paneOf = (el: Locator) => app.locator('.wb-leaf').filter({ has: el }).first();
  const artifactTab = () => tab(re('的产物', 'artifacts'));
  const flowTab = () => tab(re('流程', ' flow'));
  const chatTab = () =>
    app.locator('.wb-tab', { hasText: t.groupName }).filter({ hasNotText: re('的产物|流程', 'artifacts| flow') }).first();

  /* 7 · The artifact opens in a pane of its own, dragged beside the chat */
  await s.scene(7);
  await s.attempt('artifact pane', async () => {
    await follow();
    await s.hold(600);
    // Files a shell step wrote are cited in the text; either the link or the chip opens the pane.
    // Whatever the Director named it (trailer.mp4, teaser.mp4 …), as long as it is a film in launch/.
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
    await s.hold(900);
    await s.drag(artifactTab().locator('.wb-tab-button').first(), paneOf(artifactTab()), 'east');
    await app.locator('.wb-leaf').nth(1).waitFor({ timeout: 10_000 });
    await s.focus(paneOf(artifactTab()));
    // Play the teaser in its pane. A click on the picture is taken by the annotation layer over it,
    // so the pointer goes to the play control and the video is started directly.
    const player = app.locator('.artifact-pane video').first();
    if (await player.count()) {
      await s.focus(player);
      await s.hover(player);
      await player.evaluate((v: HTMLVideoElement) => {
        v.muted = true;
        void v.play();
      });
    }
    await s.hold(3200);
    await s.focus(null);
  });

  /* 8 · The flow board, dragged under the chat */
  await s.scene(8);
  await s.attempt('flow board', async () => {
    await s.hover(chatTab());
    await s.click(chatTab().locator('.wb-tab-more'));
    await s.click(app.locator('[data-testid="wb-context-menu"] [data-action="trace"]'));
    await app.locator('.trace-pane').waitFor({ timeout: 20_000 });
    await s.hold(900);
    await s.drag(flowTab().locator('.wb-tab-button').first(), paneOf(chatTab()), 'south');
    await app.locator('.wb-leaf').nth(2).waitFor({ timeout: 10_000 });
    await s.focus(paneOf(flowTab()));
    await s.hold(2600);
    await s.focus(null);
  });

  /* 9 · Your own terminal, split off under the artifact */
  await s.scene(9);
  await s.attempt('terminal', async () => {
    await s.click(artifactTab().locator('.wb-tab-button').first(), { button: 'right' });
    await s.click(app.locator('[data-testid="wb-context-menu"] [data-split="down"]'));
    const empty = app.locator('.wb-empty').last();
    await empty.waitFor();
    await s.click(empty.locator('button.wb-menu-row').first());
    const term = app.locator('.terminal-host').last();
    await term.waitFor({ timeout: 20_000 });
    await s.focus(paneOf(term));
    await s.hold(1000);
    await s.click(term);
    const termInput = app.locator('.xterm-helper-textarea').last();
    await s.type(termInput, t.terminalCommand);
    await s.press(termInput, 'Enter');
    await s.hold(1400);
    await s.focus(null);
    await s.hold(1400);
  });

  /* 10 · Hidden to the tray: the film composes this one */
  await s.scene(10);
  await s.tray();

  /* 11 · Carry on from the phone */
  await s.scene(11);
  const phone = await s.phone();
  const phoneRow = phone.locator('.groups .row', { hasText: t.groupName }).first();
  await phoneRow.waitFor({ timeout: 30_000 });
  await s.click(phoneRow);
  const phoneComposer = phone.locator('.composer-input');
  await phoneComposer.waitFor();
  await s.type(phoneComposer, `@${t.phoneMention.slice(0, 3)}`);
  // Pick the suggestion when it shows; otherwise the full name reads as the same mention.
  const suggestion = phone.locator('.mention-autocomplete-popup .autocomplete-item', { hasText: t.phoneMention }).first();
  const offered = await suggestion.waitFor({ timeout: 1500 }).then(
    () => true,
    () => false
  );
  if (offered) {
    // Tab takes the highlighted suggestion; a pointer trip to it can outlast the popup.
    await s.press(phoneComposer, 'Tab');
    await s.type(phoneComposer, ` ${t.phoneAsk}`);
  } else {
    await s.type(phoneComposer, `${t.phoneMention.slice(3)} ${t.phoneAsk}`);
  }
  await s.press(phoneComposer, 'Enter');
  await s.idle(5 * 60_000);
  await s.hold(1500);
}
