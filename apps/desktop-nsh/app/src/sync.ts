/**
 * The window's copy of the runtime's state, kept current the way the Svelte messenger keeps it
 * (`apps/messenger/src/lib/event-sync.ts`, `snapshot.ts`): one sync-v1 socket, a snapshot as the
 * baseline, then sequenced events applied in order; a gap, a new event instance or `resnapshot`
 * fetches the snapshot again. Stream frames (terminal bytes) bypass the sequence.
 */
import { batch, signal } from "nsh";
import type {
  Bot,
  DurableEvent,
  Message,
  RuntimeSnapshot,
  SequencedEvent,
  SessionSnapshot,
  SessionSummary,
  StreamFrame,
  Turn,
} from "@real-bot/protocol";
import { api, eventsUrl, token } from "./api";

export type Connection = "connecting" | "live" | "offline";

export const connection = signal<Connection>("connecting");
export const sessions = signal<SessionSummary[]>([]);
export const bots = signal<Record<string, Bot>>({});
export const openSessionId = signal<string | null>(null);
/** The open conversation's messages, newest first (the inverted list's order). */
export const messages = signal<Message[]>([]);
export const olderCursor = signal<string | null>(null);
/** The open conversation's live turns (their partial text streams in). */
export const liveTurns = signal<Turn[]>([]);
/** Where terminals open (Settings' workspace). */
export const workspacePath = signal<string | null>(null);

let instance = "";
let watermark = 0;
let baseline = false;
let pending: SequencedEvent[] = [];
let socket: WebSocket | null = null;
let retry = 0;
const streamListeners = new Map<string, Set<(frame: StreamFrame) => void>>();

export function onStream(id: string, listener: (frame: StreamFrame) => void): () => void {
  let set = streamListeners.get(id);
  if (!set) streamListeners.set(id, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
}

export function start(): void {
  connect();
}

function connect(): void {
  connection.set("connecting");
  baseline = false;
  pending = [];
  const ws = new WebSocket(eventsUrl());
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token, protocol: "sync-v1" }));
  // The socket exists, so events from here on are buffered: the snapshot can be the baseline.
  void loadSnapshot();
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let frame: { type?: string } & Record<string, unknown>;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (frame.type) {
      case "ready":
        retry = 0;
        break;
      case "resnapshot":
        void loadSnapshot();
        break;
      case "stream": {
        const stream = frame as unknown as StreamFrame;
        for (const listener of streamListeners.get(stream.id) ?? []) listener(stream);
        break;
      }
      case "event":
        receive(frame as unknown as SequencedEvent);
        break;
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    connection.set("offline");
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

function receive(frame: SequencedEvent): void {
  if (!baseline) {
    pending.push(frame);
    return;
  }
  if (frame.event_instance_id !== instance) {
    void loadSnapshot();
    return;
  }
  if (frame.seq <= watermark) return;
  if (frame.seq !== watermark + 1) {
    void loadSnapshot();
    return;
  }
  watermark = frame.seq;
  reduce(frame.payload);
}

let loading: Promise<void> | null = null;
let readyLogged = false;

async function loadSnapshot(): Promise<void> {
  if (loading) return loading;
  baseline = false;
  loading = (async () => {
    try {
      const snap = await api<RuntimeSnapshot>("/v1/snapshot");
      instance = snap.event_instance_id;
      watermark = snap.watermark_seq;
      batch(() => {
        sessions.set(sortSessions(snap.sessions.filter((s) => !s.archived_at)));
        bots.set(Object.fromEntries(snap.bots.map((b) => [b.id, b])));
        workspacePath.set(snap.settings.workspace_path ?? null);
      });
      baseline = true;
      connection.set("live");
      if (!readyLogged) {
        readyLogged = true;
        // What start-up measurements wait for (scripts/package.ts --measure).
        console.log(`ready: ${snap.sessions.length} conversations`);
      }
      const queued = pending.sort((a, b) => a.seq - b.seq);
      pending = [];
      for (const frame of queued) receive(frame);
      const open = openSessionId();
      if (open) await openSession(open);
    } catch (error) {
      console.error("snapshot failed", String(error));
      connection.set("offline");
      socket?.close();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export async function openSession(id: string): Promise<void> {
  openSessionId.set(id);
  olderAgain = false;
  const snap = await api<SessionSnapshot>(`/v1/sessions/${encodeURIComponent(id)}/snapshot?limit=60`);
  if (openSessionId() !== id) return;
  batch(() => {
    messages.set(newestFirst(snap.session.messages.items.filter(shown)));
    olderCursor.set(snap.session.messages.next ?? null);
    liveTurns.set(snap.session.turns.filter(isLive));
    sessions.set(sessions().map((s) => (s.id === id ? { ...s, unread_count: 0 } : s)));
  });
}

let loadingOlder = false;
let olderAgain = false;

/**
 * The next older page. The list asks once per approach to its end, so an ask that comes while a
 * page is still on its way is kept and served when that page lands; dropping it would leave the
 * list at its end with older lines never loaded.
 */
export async function loadOlder(): Promise<void> {
  if (loadingOlder) {
    olderAgain = true;
    return;
  }
  const id = openSessionId();
  const cursor = olderCursor();
  if (!id || !cursor) return;
  loadingOlder = true;
  try {
    const page = await api<{ items: Message[]; next?: string | null }>(
      `/v1/sessions/${encodeURIComponent(id)}/messages?limit=60&cursor=${encodeURIComponent(cursor)}`,
    );
    if (openSessionId() !== id) return;
    const known = new Set(messages().map((m) => m.id));
    batch(() => {
      messages.set([...messages(), ...newestFirst(page.items.filter((m) => shown(m) && !known.has(m.id)))]);
      olderCursor.set(page.next ?? null);
    });
  } finally {
    loadingOlder = false;
  }
  if (olderAgain) {
    olderAgain = false;
    await loadOlder();
  }
}

export async function send(body: string): Promise<void> {
  const id = openSessionId();
  if (!id || !body.trim()) return;
  await api<Message>(`/v1/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: { body } });
}

function reduce(event: DurableEvent): void {
  switch (event.event) {
    case "session.upsert": {
      const { event: _e, occurred_at: _o, ...row } = event;
      const list = sessions();
      const at = list.findIndex((s) => s.id === row.id);
      // A partial row: it carries no last message, live turns or waiting card.
      const merged = at >= 0 ? { ...list[at]!, ...stripUndefined(row) } : (row as SessionSummary);
      const next = at >= 0 ? list.map((s, i) => (i === at ? merged : s)) : [...list, merged];
      sessions.set(sortSessions(next.filter((s) => !s.archived_at)));
      break;
    }
    case "session.removed":
      sessions.set(sessions().filter((s) => s.id !== event.id));
      if (openSessionId() === event.id) openSessionId.set(null);
      break;
    case "session.cleared":
      sessions.set(sessions().map((s) => (s.id === event.id ? { ...s, last_message: null, unread_count: 0 } : s)));
      if (openSessionId() === event.id) messages.set([]);
      break;
    case "message.created":
    case "message.upsert": {
      const { event: kind, occurred_at: _o, ...message } = event;
      const isOpen = openSessionId() === message.session_id;
      sessions.set(
        sortSessions(
          sessions().map((s) => {
            if (s.id !== message.session_id) return s;
            const unread =
              kind === "message.created" && message.author !== "user" && !isOpen
                ? (s.unread_count ?? 0) + 1
                : s.unread_count;
            const last = kind === "message.created" || s.last_message?.id === message.id ? message : s.last_message;
            return { ...s, last_message: last, unread_count: unread, updated_at: kind === "message.created" ? message.created_at : s.updated_at };
          }),
        ),
      );
      if (isOpen && shown(message)) {
        const list = messages();
        const at = list.findIndex((m) => m.id === message.id);
        messages.set(at >= 0 ? list.map((m, i) => (i === at ? message : m)) : newestFirst([message, ...list]));
      }
      break;
    }
    case "turn.upsert": {
      const { event: _e, occurred_at: _o, ...turn } = event;
      if (openSessionId() !== turn.session_id) break;
      const rest = liveTurns().filter((t) => t.id !== turn.id);
      liveTurns.set(isLive(turn) ? [...rest, turn] : rest);
      break;
    }
    case "bot.upsert": {
      const { event: _e, occurred_at: _o, deleted_at, ...bot } = event;
      const next = { ...bots() };
      if (deleted_at) delete next[bot.id];
      else next[bot.id] = bot;
      bots.set(next);
      break;
    }
  }
}

function isLive(turn: Turn): boolean {
  return turn.status === "running" || turn.status === "waiting_approval" || turn.status === "waiting_ask";
}

function shown(message: Message): boolean {
  return (message.kind as string) !== "profile_change" && !message.withdrawn_at;
}

function newestFirst(list: Message[]): Message[] {
  return [...list].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

function sortSessions(list: SessionSummary[]): SessionSummary[] {
  return [...list].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

function stripUndefined<T extends object>(row: T): Partial<T> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as Partial<T>;
}
