/**
 * The engine's shared plumbing: the maps that hold every live turn and its in-flight work, the
 * small helpers that track a detached promise until it settles, and the three `publish*` calls
 * every other module reaches for. `publishTurn` is where a turn's end is noticed — the organizer
 * and a Bot↔Bot direct's quiet clock both learn about it here, so those two are passed in as
 * callbacks: they are built after core, once routing, spend and the direct-report module exist.
 */
import type { ClientEvent, Message, Spend, Turn } from "@real-bot/protocol";
import type { Store } from "../store";
import type { Live } from "./types";

export type CoreDeps = {
  store: Store;
  publish: (event: ClientEvent) => void;
  /** A turn reached a terminal state: its plan is filed once it has been quiet for a moment. */
  noteTurnEnded: (turn: Turn) => void;
  /** A turn ending in a Bot↔Bot direct restarts that direct's quiet clock. */
  noteDirectTurnEnded: (turn: Turn) => void;
};

export type Core = {
  lives: Map<string, Live>;
  tasks: Set<Promise<unknown>>;
  turnTasks: Map<string, Set<Promise<unknown>>>;
  track: <T>(promise: Promise<T>) => Promise<T>;
  trackTurn: <T>(turnId: string, promise: Promise<T>) => Promise<T>;
  active: (turnId: string, live: Live) => boolean;
  occurred: () => string;
  publishTurn: (turn: Turn, partial?: string | null) => void;
  publishMessage: (message: Message) => void;
  publishSpend: (row: Spend) => void;
};

export function createCore(deps: CoreDeps): Core {
  const { store, publish, noteTurnEnded, noteDirectTurnEnded } = deps;
  const lives = new Map<string, Live>();
  const tasks = new Set<Promise<unknown>>();
  const turnTasks = new Map<string, Set<Promise<unknown>>>();

  function track<T>(promise: Promise<T>): Promise<T> {
    tasks.add(promise);
    void promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
    return promise;
  }

  function trackTurn<T>(turnId: string, promise: Promise<T>): Promise<T> {
    const pending = turnTasks.get(turnId) ?? new Set<Promise<unknown>>();
    turnTasks.set(turnId, pending);
    pending.add(promise);
    const done = () => {
      pending.delete(promise);
      if (pending.size === 0) turnTasks.delete(turnId);
    };
    void promise.then(done, done);
    return track(promise);
  }

  function active(turnId: string, live: Live): boolean {
    if (live.abort.signal.aborted || lives.get(turnId) !== live) return false;
    return store.getTurn(turnId).status === "running";
  }

  function occurred(): string {
    return new Date().toISOString();
  }

  function publishTurn(turn: Turn, partial: string | null = null): void {
    store.setTurnPartial(turn.id, partial);
    publish({ event: "turn.upsert", occurred_at: occurred(), ...turn, partial_text: partial });
    // Every way a turn ends passes through here, so this is where its plan learns to file itself.
    if (turn.status !== "running" && turn.status !== "waiting_ask" && turn.status !== "waiting_approval") {
      noteTurnEnded(turn);
      noteDirectTurnEnded(turn);
    }
  }

  function publishMessage(message: Message): void {
    publish({ event: "message.created", occurred_at: occurred(), ...message });
  }

  function publishSpend(row: Spend): void {
    publish({ event: "spend.created", occurred_at: occurred(), ...row });
  }

  return { lives, tasks, turnTasks, track, trackTurn, active, occurred, publishTurn, publishMessage, publishSpend };
}
