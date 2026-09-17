import type { BotId, Dict } from '$lib/i18n';

/**
 * The walkthrough is a sequence of scenes. Each scene starts from the final
 * state of the previous one and adds a handful of timed beats. The state for
 * (scene, beat) is a pure function, so jumping around while scrolling is safe.
 */

export const SCENE_COUNT = 9; // 0 = hero, 1..8 = steps

/** Beat offsets in ms from scene activation. beat 0 = scene just activated. */
export const SCENE_BEATS: readonly (readonly number[])[] = [
  /* 0 hero      */ [700],
  /* 1 settings  */ [400, 1500, 2500, 3300, 4600, 5300],
  /* 2 create    */ [300, 900, 1400, 2400, 3400, 4500, 5100],
  /* 3 hire      */ [300, 2600, 3100, 4200, 4700, 5300, 6000],
  /* 4 group     */ [300, 900, 3000, 3500, 4200, 5400],
  /* 5 approval  */ [400, 1000, 1500, 2800, 3400],
  /* 6 handoff   */ [500, 1300, 2800],
  /* 7 artifact  */ [400, 1000, 2200, 3200],
  /* 8 tray      */ [500, 1100, 2400]
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
  preview: { edited: boolean; saved: boolean } | null;
  tray: { menu: boolean } | null;
  cursor: { target: string; click: boolean } | null;
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
  preview: null,
  tray: null,
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
    preview: s.preview ? { ...s.preview } : null,
    tray: s.tray ? { ...s.tray } : null,
    cursor: s.cursor ? { ...s.cursor } : null
  };
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
    const idx = items.findIndex((i) => i.kind === 'replying');
    if (idx >= 0) items.splice(idx, 1);
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
    const idx = items.findIndex((i) => i.kind === 'replying');
    if (idx >= 0) items.splice(idx, 1);
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
    const idx = items.findIndex((i) => i.kind === 'replying');
    if (idx >= 0) items.splice(idx, 1);
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
  // Base: researcher still replying after approval.
  if (beat >= 1) {
    const idx = items.findIndex((i) => i.kind === 'replying');
    if (idx >= 0) items.splice(idx, 1);
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
  if (beat >= 2) items.push({ kind: 'replying', id: 'gr4', bots: ['writer'] });
  if (beat >= 3) {
    const idx = items.findIndex((i) => i.kind === 'replying');
    if (idx >= 0) items.splice(idx, 1);
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
  if (beat >= 1) s.cursor = { target: 'artifact-report', click: true };
  if (beat >= 2) {
    s.cursor = null;
    s.preview = { edited: false, saved: false };
  }
  if (beat >= 3) s.preview = { edited: true, saved: false };
  if (beat >= 4) s.preview = { edited: true, saved: true };
  return s;
}

function scene8(s: MockState, beat: number): MockState {
  s.preview = null;
  if (beat >= 1) s.cursor = { target: 'window-close', click: true };
  if (beat >= 2) {
    s.cursor = null;
    s.tray = { menu: false };
  }
  if (beat >= 3) s.tray = { menu: true };
  return s;
}

function scene0(s: MockState, beat: number, t: Dict): MockState {
  // Hero: the finished team, with Coordinator wrapping up live.
  s.preview = null;
  s.tray = null;
  s.cursor = null;
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
  scene8
];

/** Final state after the last beat of `scene` (scene >= 1). */
function finalState(scene: number, t: Dict): MockState {
  if (scene <= 0) return clone(EMPTY);
  const base = scene === 1 ? clone(EMPTY) : finalState(scene - 1, t);
  return APPLIERS[scene](base, SCENE_BEATS[scene].length, t);
}

export function stateAt(scene: number, beat: number, t: Dict): MockState {
  if (scene === 0) {
    // Hero builds on the completed walkthrough up to the handoff scene.
    return scene0(finalState(6, t), beat, t);
  }
  const base = scene === 1 ? clone(EMPTY) : finalState(scene - 1, t);
  return APPLIERS[scene](base, beat, t);
}

export function maxBeat(scene: number): number {
  return SCENE_BEATS[scene]?.length ?? 0;
}
