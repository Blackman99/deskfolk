/**
 * The remote chapter's demo, as plain data: what Pudding is doing, what a tap on the phone does to
 * it, how far through the chapter each beat falls, and the messages the page and the pop-up phone
 * pass each other over a BroadcastChannel. No DOM in here, so it is all tested.
 */

export type Phase = 'working' | 'waiting' | 'stopped' | 'done';
export type Tab = 0 | 1 | 2 | 3;

export type RemoteState = {
  phase: Phase;
  tab: Tab;
  /** Counts the actions that changed something. */
  seq: number;
  /** The last approval was refused: Pudding carries on and says so. */
  denied: boolean;
};

export type RemoteAction =
  | { type: 'ask' }
  | { type: 'allow' }
  | { type: 'deny' }
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'finish' }
  | { type: 'reset' }
  | { type: 'tab'; tab: Tab };

export const CHANNEL_NAME = 'deskfolk-remote-demo';

export const INITIAL: RemoteState = { phase: 'working', tab: 0, seq: 0, denied: false };

const isTab = (v: unknown): v is Tab => v === 0 || v === 1 || v === 2 || v === 3;

/** The state after `action`; the same object when the action does not apply to where Pudding is. */
export function reduce(state: RemoteState, action: RemoteAction): RemoteState {
  const next = (patch: Partial<RemoteState>): RemoteState => ({ ...state, ...patch, seq: state.seq + 1 });
  switch (action.type) {
    case 'ask':
      return state.phase === 'working' ? next({ phase: 'waiting', denied: false }) : state;
    case 'allow':
      return state.phase === 'waiting' ? next({ phase: 'working', denied: false }) : state;
    case 'deny':
      return state.phase === 'waiting' ? next({ phase: 'working', denied: true }) : state;
    case 'stop':
      return state.phase === 'working' || state.phase === 'waiting' ? next({ phase: 'stopped' }) : state;
    case 'resume':
      // Your line after Stop: the app carries on from it and finishes.
      return state.phase === 'stopped' ? next({ phase: 'done', denied: false }) : state;
    case 'finish':
      return state.phase === 'working' ? next({ phase: 'done' }) : state;
    case 'reset':
      return { ...INITIAL, seq: state.seq + 1 };
    case 'tab':
      return isTab(action.tab) && action.tab !== state.tab ? next({ tab: action.tab }) : state;
    default:
      return state;
  }
}

/** The beats, as progress through the chapter: Pudding asks, is allowed, is stopped, carries on. */
export const MARKS = { ask: 0.22, allow: 0.45, stop: 0.65, resume: 0.85 } as const;

/** Where the demo is at progress `p` when nobody has touched it: a pure function, so it scrubs both ways. */
export function autoState(p: number): RemoteState {
  const phase: Phase =
    p >= MARKS.resume ? 'done' : p >= MARKS.stop ? 'stopped' : p >= MARKS.ask && p < MARKS.allow ? 'waiting' : 'working';
  return { phase, tab: 0, seq: 0, denied: false };
}

export type RippleTarget = 'allow' | 'stop' | 'resume';

/** How long before a beat its tap ripple starts, in progress. */
const RIPPLE = 0.03;

/** The tap ripple on a phone button just before a beat lands: which button and how far it has run (0 to 1). */
export function rippleAt(p: number): { target: RippleTarget; t: number } | null {
  for (const target of ['allow', 'stop', 'resume'] as const) {
    const at = MARKS[target];
    if (p >= at - RIPPLE && p < at) return { target, t: (p - (at - RIPPLE)) / RIPPLE };
  }
  return null;
}

export type RemoteMessage =
  | { v: 1; type: 'action'; action: RemoteAction; from: string }
  | { v: 1; type: 'state'; state: RemoteState; from: string }
  | { v: 1; type: 'hello'; from: string };

const PHASES: readonly string[] = ['working', 'waiting', 'stopped', 'done'];
const SIMPLE: readonly string[] = ['ask', 'allow', 'deny', 'stop', 'resume', 'finish', 'reset'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseAction(v: unknown): RemoteAction | null {
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  if (SIMPLE.includes(v.type)) return { type: v.type } as RemoteAction;
  if (v.type === 'tab' && isTab(v.tab)) return { type: 'tab', tab: v.tab };
  return null;
}

function parseState(v: unknown): RemoteState | null {
  if (!isRecord(v)) return null;
  const { phase, tab, seq, denied } = v;
  if (typeof phase !== 'string' || !PHASES.includes(phase) || !isTab(tab)) return null;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || typeof denied !== 'boolean') return null;
  return { phase: phase as Phase, tab, seq, denied };
}

/** A message from the other window if it is one of ours and well formed, else null. */
export function parseMessage(data: unknown): RemoteMessage | null {
  if (!isRecord(data) || data.v !== 1) return null;
  const from = data.from;
  if (typeof from !== 'string' || from.length === 0 || from.length > 64) return null;
  if (data.type === 'hello') return { v: 1, type: 'hello', from };
  if (data.type === 'action') {
    const action = parseAction(data.action);
    return action ? { v: 1, type: 'action', action, from } : null;
  }
  if (data.type === 'state') {
    const state = parseState(data.state);
    return state ? { v: 1, type: 'state', state, from } : null;
  }
  return null;
}
