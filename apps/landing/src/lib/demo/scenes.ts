import type { BotId, Dict } from '$lib/i18n';

/**
 * The walkthrough is a sequence of scenes. Each scene starts from the final
 * state of the previous one and adds a handful of timed beats. The state for
 * (scene, beat) is a pure function, so jumping around while scrolling is safe.
 */

export const SCENE_COUNT = 12; // 0 = hero, 1..11 = steps

/** Beat offsets in ms from scene activation. beat 0 = scene just activated. */
export const SCENE_BEATS: readonly (readonly number[])[] = [
  /* 0 hero      */ [700],
  /* 1 settings  */ [400, 1500, 2500, 3300, 4600, 5300],
  /* 2 create    */ [300, 900, 1400, 2400, 3400, 4500, 5100],
  /* 3 hire      */ [300, 2600, 3100, 4200, 4700, 5300, 6000],
  /* 4 group     */ [300, 900, 3000, 3500, 4200, 5400],
  /* 5 approval  */ [400, 1000, 1500, 2800, 3400],
  /* 6 handoff   */ [400, 1100, 1800, 2500, 3300, 4400, 5600],
  /* 7 artifact  */ [400, 1000, 2200, 3200],
  /* 8 flow      */ [400, 1100, 1800, 2800, 3500],
  /* 9 terminal  */ [400, 1200, 1900, 2600, 3300, 4600, 5400, 6200],
  /* 10 tray     */ [500, 1100, 2300, 3700],
  /* 11 remote   */ [400, 1300, 2300, 3100, 4700, 5300, 6000]
];

export type Part = { type: 'text'; text: string } | { type: 'mention'; bot: BotId };

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; time: string }
  | {
      kind: 'bot';
      id: string;
      bot: BotId;
      time: string;
      parts: Part[];
      artifacts?: string[];
      streaming?: boolean;
    }
  | { kind: 'replying'; id: string; bots: BotId[] }
  | { kind: 'approval'; id: string; bot: BotId; status: 'pending' | 'allowed'; time: string };

export type SessionId = 'coordinator' | 'research';

/** Where the keyboard is. Only drawn once the window holds more than one pane. */
export type PaneId = 'chat' | 'right' | 'bottom';

export type MockState = {
  roster: BotId[];
  groups: { id: 'research'; name: string; pending: boolean }[];
  youBot: BotId[];
  active: 'none' | SessionId;
  wizardComplete: boolean;
  /** Settings modal: how many field groups are revealed (0 = closed). */
  settings: number;
  /** New-bot slide-out: how many fields are filled (0 = closed). */
  create: number;
  transcripts: Record<SessionId, TranscriptItem[]>;
  composer: { text: string } | null;
  judgement: boolean;
  /** Researcher's shell command: output lines shown while it runs, then one folded line. */
  command: { running: boolean; lines: number } | null;
  /** The workbench: the conversation pane, plus a right column once something opens beside it. */
  right: { tabs: ('preview' | 'flow')[]; active: 'preview' | 'flow' } | null;
  /** A pane split off under the right column: empty until something is picked into it. */
  bottom: 'empty' | 'terminal' | null;
  focus: PaneId;
  /** The ⋯ menu in a narrow conversation pane's header. */
  chatMenu: boolean;
  /** The right-click menu in the right pane. */
  splitMenu: boolean;
  preview: { edited: boolean; saved: boolean } | null;
  flow: { unfolded: boolean; coordinator: boolean };
  terminal: { lines: number } | null;
  /** `badge` is the Dock count: it outlives the banner and clears once the conversation is read. */
  tray: { menu: boolean; banner: boolean; badge: boolean } | null;
  /** A paired phone reaching the Mac through your own relay, while the window stays hidden. */
  phone: { view: 'list' | 'chat'; composer: string | null } | null;
  /** `touch` draws a fingertip instead of the pointer, for taps on the phone. */
  cursor: { target: string; click: boolean; touch?: boolean } | null;
};

const EMPTY: MockState = {
  roster: [],
  groups: [],
  youBot: [],
  active: 'none',
  wizardComplete: false,
  settings: 0,
  create: 0,
  transcripts: { coordinator: [], research: [] },
  composer: null,
  judgement: false,
  command: null,
  right: null,
  bottom: null,
  focus: 'chat',
  chatMenu: false,
  splitMenu: false,
  preview: null,
  flow: { unfolded: false, coordinator: false },
  terminal: null,
  tray: null,
  phone: null,
  cursor: null
};

function clone(s: MockState): MockState {
  return {
    ...s,
    roster: [...s.roster],
    groups: s.groups.map((g) => ({ ...g })),
    youBot: [...s.youBot],
    transcripts: {
      coordinator: s.transcripts.coordinator.map((i) => ({ ...i })),
      research: s.transcripts.research.map((i) => ({ ...i }))
    },
    composer: s.composer ? { ...s.composer } : null,
    command: s.command ? { ...s.command } : null,
    right: s.right ? { ...s.right, tabs: [...s.right.tabs] } : null,
    preview: s.preview ? { ...s.preview } : null,
    flow: { ...s.flow },
    terminal: s.terminal ? { ...s.terminal } : null,
    tray: s.tray ? { ...s.tray } : null,
    phone: s.phone ? { ...s.phone } : null,
    cursor: s.cursor ? { ...s.cursor } : null
  };
}

function dropReplying(items: TranscriptItem[]): void {
  const idx = items.findIndex((i) => i.kind === 'replying');
  if (idx >= 0) items.splice(idx, 1);
}

/* ---- Per-scene beat appliers. Each receives the state at beat 0 and the beat index. ---- */

function scene1(s: MockState, beat: number): MockState {
  // Settings wizard: reveal fields, save, close.
  s.settings = 1;
  if (beat >= 1) s.settings = 2; // workspace typed
  if (beat >= 2) s.settings = 3; // endpoint typed
  if (beat >= 3) s.settings = 4; // key set
  if (beat >= 4) s.settings = 5; // models listed
  if (beat >= 5) s.cursor = { target: 'settings-save', click: true };
  if (beat >= 6) {
    s.settings = 0;
    s.wizardComplete = true;
    s.cursor = null;
  }
  return s;
}

function scene2(s: MockState, beat: number): MockState {
  if (beat >= 1) s.cursor = { target: 'roster-add', click: true };
  if (beat >= 2) {
    s.create = 1;
    s.cursor = null;
  }
  if (beat >= 3) s.create = 2; // name + avatar
  if (beat >= 4) s.create = 3; // duties
  if (beat >= 5) s.create = 4; // boundaries
  if (beat >= 6) s.cursor = { target: 'create-save', click: true };
  if (beat >= 7) {
    s.create = 0;
    s.cursor = null;
    s.roster = ['coordinator'];
    s.youBot = ['coordinator'];
    s.active = 'coordinator';
  }
  return s;
}

function scene3(s: MockState, beat: number, t: Dict): MockState {
  const items = s.transcripts.coordinator;
  if (beat >= 1) s.composer = { text: t.script.userCreateTeam };
  if (beat >= 2) {
    s.composer = null;
    items.push({ kind: 'user', id: 'u1', text: t.script.userCreateTeam, time: '14:20' });
  }
  if (beat >= 3) items.push({ kind: 'replying', id: 'r1', bots: ['coordinator'] });
  if (beat >= 4) s.roster = ['coordinator', 'researcher'];
  if (beat >= 5) {
    s.roster = ['coordinator', 'researcher', 'writer'];
    s.youBot = ['coordinator', 'researcher', 'writer'];
  }
  if (beat >= 6) s.groups = [{ id: 'research', name: t.script.groupName, pending: false }];
  if (beat >= 7) {
    dropReplying(items);
    items.push({
      kind: 'bot',
      id: 'b1',
      bot: 'coordinator',
      time: '14:21',
      parts: [{ type: 'text', text: t.script.coordinatorCreated }]
    });
  }
  return s;
}

function scene4(s: MockState, beat: number, t: Dict): MockState {
  const items = s.transcripts.research;
  if (beat >= 1) s.cursor = { target: 'group-research', click: true };
  if (beat >= 2) {
    s.active = 'research';
    s.cursor = null;
    s.composer = { text: t.script.userGroupGoal };
  }
  if (beat >= 3) {
    s.composer = null;
    items.push({ kind: 'user', id: 'g1', text: t.script.userGroupGoal, time: '14:24' });
  }
  if (beat >= 4) s.judgement = true;
  if (beat >= 5) items.push({ kind: 'replying', id: 'gr1', bots: ['researcher'] });
  if (beat >= 6) {
    dropReplying(items);
    items.push({
      kind: 'bot',
      id: 'g2',
      bot: 'researcher',
      time: '14:25',
      parts: [{ type: 'text', text: t.script.researcherRead }]
    });
  }
  return s;
}

function scene5(s: MockState, beat: number): MockState {
  const items = s.transcripts.research;
  s.judgement = false;
  if (beat >= 1) items.push({ kind: 'replying', id: 'gr2', bots: ['researcher'] });
  if (beat >= 2) {
    dropReplying(items);
    items.push({ kind: 'approval', id: 'ap1', bot: 'researcher', status: 'pending', time: '14:26' });
  }
  if (beat >= 3) s.groups = s.groups.map((g) => ({ ...g, pending: true }));
  if (beat >= 4) s.cursor = { target: 'allow-once', click: true };
  if (beat >= 5) {
    s.cursor = null;
    s.groups = s.groups.map((g) => ({ ...g, pending: false }));
    const card = items.find((i) => i.kind === 'approval');
    if (card && card.kind === 'approval') card.status = 'allowed';
    items.push({ kind: 'replying', id: 'gr3', bots: ['researcher'] });
  }
  return s;
}

function scene6(s: MockState, beat: number, t: Dict): MockState {
  const items = s.transcripts.research;
  // Base: Researcher still replying after the approval. Its command runs under that line.
  if (beat >= 1) s.command = { running: true, lines: 1 };
  if (beat >= 2) s.command = { running: true, lines: 2 };
  if (beat >= 3) s.command = { running: true, lines: 3 };
  if (beat >= 4) s.command = { running: true, lines: t.script.commandOutput.length };
  if (beat >= 5) {
    s.command = { running: false, lines: t.script.commandOutput.length };
    dropReplying(items);
    items.push({
      kind: 'bot',
      id: 'g3',
      bot: 'researcher',
      time: '14:29',
      parts: [
        { type: 'text', text: t.script.researcherHandoff[0] },
        { type: 'mention', bot: 'writer' },
        { type: 'text', text: t.script.researcherHandoff[1] }
      ],
      artifacts: [t.script.researcherNotePath]
    });
  }
  if (beat >= 6) items.push({ kind: 'replying', id: 'gr4', bots: ['writer'] });
  if (beat >= 7) {
    dropReplying(items);
    items.push({
      kind: 'bot',
      id: 'g4',
      bot: 'writer',
      time: '14:33',
      parts: [{ type: 'text', text: t.script.writerDone }],
      artifacts: [t.script.reportPath]
    });
  }
  return s;
}

function scene7(s: MockState, beat: number): MockState {
  // The file opens in a pane of its own beside the conversation.
  if (beat >= 1) s.cursor = { target: 'artifact-report', click: true };
  if (beat >= 2) {
    s.cursor = null;
    s.right = { tabs: ['preview'], active: 'preview' };
    s.focus = 'right';
    s.preview = { edited: false, saved: false };
  }
  if (beat >= 3) s.preview = { edited: true, saved: false };
  if (beat >= 4) s.preview = { edited: true, saved: true };
  return s;
}

function scene8(s: MockState, beat: number): MockState {
  // The conversation pane is narrow now, so Trace sits in its ⋯ menu.
  if (beat >= 1) s.cursor = { target: 'chat-more', click: true };
  if (beat >= 2) {
    s.chatMenu = true;
    s.cursor = { target: 'menu-trace', click: true };
  }
  if (beat >= 3) {
    s.chatMenu = false;
    s.cursor = null;
    s.right = { tabs: ['preview', 'flow'], active: 'flow' };
    s.focus = 'right';
  }
  if (beat >= 4) s.cursor = { target: 'route-line', click: true };
  if (beat >= 5) {
    s.cursor = null;
    s.flow = { ...s.flow, unfolded: true };
  }
  return s;
}

function scene9(s: MockState, beat: number): MockState {
  const items = s.transcripts.research;
  // Right-click in the flow pane, split down, start a terminal in the new pane.
  if (beat >= 1) s.cursor = { target: 'rc-point', click: true };
  if (beat >= 2) {
    s.splitMenu = true;
    s.cursor = { target: 'split-down', click: true };
  }
  if (beat >= 3) {
    s.splitMenu = false;
    s.cursor = null;
    s.bottom = 'empty';
    s.focus = 'bottom';
  }
  if (beat >= 4) s.cursor = { target: 'empty-new-terminal', click: true };
  if (beat >= 5) {
    s.cursor = null;
    s.bottom = 'terminal';
    s.terminal = { lines: 0 };
  }
  if (beat >= 6) s.terminal = { lines: 3 };
  if (beat >= 7) s.terminal = { lines: 99 };
  if (beat >= 8) {
    // Coordinator picks the job up to check it over; it is still going when the window closes.
    items.push({ kind: 'replying', id: 'gr5', bots: ['coordinator'] });
    s.flow = { ...s.flow, coordinator: true };
  }
  return s;
}

function scene10(s: MockState, beat: number, t: Dict): MockState {
  const items = s.transcripts.research;
  if (beat >= 1) s.cursor = { target: 'window-close', click: true };
  if (beat >= 2) {
    s.cursor = null;
    s.tray = { menu: false, banner: false, badge: false };
  }
  if (beat >= 3) s.tray = { menu: true, banner: false, badge: false };
  if (beat >= 4) {
    // Coordinator finishes while the window is away: a banner, and the Dock badge counts it.
    s.tray = { menu: false, banner: true, badge: true };
    dropReplying(items);
    items.push({
      kind: 'bot',
      id: 'g5',
      bot: 'coordinator',
      time: '14:36',
      parts: [{ type: 'text', text: t.script.coordinatorClose }]
    });
  }
  return s;
}

function scene11(s: MockState, beat: number, t: Dict): MockState {
  const items = s.transcripts.research;
  // The banner has gone by; the window stays hidden and the Mac keeps the work.
  if (s.tray) s.tray = { ...s.tray, menu: false, banner: false };
  if (beat >= 1) s.phone = { view: 'list', composer: null };
  if (beat >= 2) s.cursor = { target: 'phone-row-research', click: true, touch: true };
  if (beat >= 3) {
    // Read on the phone, so the Mac's Dock stops counting it.
    s.cursor = null;
    s.phone = { view: 'chat', composer: null };
    if (s.tray) s.tray.badge = false;
  }
  if (beat >= 4) s.phone = { view: 'chat', composer: t.script.phoneReply };
  if (beat >= 5) s.cursor = { target: 'phone-send', click: true, touch: true };
  if (beat >= 6) {
    s.cursor = null;
    s.phone = { view: 'chat', composer: null };
    items.push({ kind: 'user', id: 'g6', text: t.script.phoneReply, time: '14:41' });
  }
  // Writer picks it up on the Mac; the phone only watches it run.
  if (beat >= 7) items.push({ kind: 'replying', id: 'gr6', bots: ['writer'] });
  return s;
}

function scene0(s: MockState, beat: number, t: Dict): MockState {
  // Hero: the finished team beside its flow, with Coordinator wrapping up live.
  s.tray = null;
  s.cursor = null;
  s.focus = 'chat';
  s.flow = { unfolded: true, coordinator: true };
  if (beat >= 1) {
    s.transcripts.research.push({
      kind: 'bot',
      id: 'g5',
      bot: 'coordinator',
      time: '14:35',
      parts: [{ type: 'text', text: t.script.coordinatorClose }],
      streaming: true
    });
  }
  return s;
}

const APPLIERS: ((s: MockState, beat: number, t: Dict) => MockState)[] = [
  scene0,
  scene1,
  scene2,
  scene3,
  scene4,
  scene5,
  scene6,
  scene7,
  scene8,
  scene9,
  scene10,
  scene11
];

/** Final state after the last beat of `scene` (scene >= 1). */
function finalState(scene: number, t: Dict): MockState {
  if (scene <= 0) return clone(EMPTY);
  const base = scene === 1 ? clone(EMPTY) : finalState(scene - 1, t);
  return APPLIERS[scene](base, SCENE_BEATS[scene].length, t);
}

export function stateAt(scene: number, beat: number, t: Dict): MockState {
  if (scene === 0) {
    // Hero builds on the completed walkthrough up to the flow scene.
    return scene0(finalState(8, t), beat, t);
  }
  const base = scene === 1 ? clone(EMPTY) : finalState(scene - 1, t);
  return APPLIERS[scene](base, beat, t);
}

export function maxBeat(scene: number): number {
  return SCENE_BEATS[scene]?.length ?? 0;
}
