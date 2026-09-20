import { HttpError } from "./errors";
import type { Store } from "./store";
import type { TurnEngine } from "./turn-engine";
import type { Scheduler } from "./scheduler";

export type DrainState = { phase: "running" | "draining" | "drained"; remaining: string[]; forced: boolean };
export type SupervisorControl = {
  kind: "window" | "standalone" | "none";
  writeStopLatch(): Promise<void>;
  clearStopLatch(): Promise<void>;
};

export class TurnAdmission {
  private paused = false;
  assertNew(): void {
    if (this.paused) throw new HttpError(409, "draining", "runtime is draining; new turns are paused");
  }
  get draining(): boolean { return this.paused; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
}

/** Lifecycle callers own exit and stop-latch writes; draining never owns either. */
export class Quiesce {
  private phase: DrainState["phase"] = "running";
  private turns = new Set<string>();
  private forced = false;
  private timer?: ReturnType<typeof setInterval>;
  private waiters = new Set<(state: DrainState) => void>();
  constructor(private readonly store: Store, private readonly engine: TurnEngine,
    readonly admission: TurnAdmission, private readonly scheduler: Scheduler | null) {}

  state(): DrainState {
    const live = new Set([
      ...this.store.listLiveTurns().map(t => t.id),
      ...this.engine.unsettledTurnIds(),
    ]);
    return { phase: this.phase, remaining: [...this.turns].filter(id => live.has(id)), forced: this.forced };
  }
  begin(): DrainState {
    if (this.phase !== "running") return this.state();
    this.admission.pause();
    try {
      this.scheduler?.pause();
      this.turns = new Set([
        ...this.store.listLiveTurns().map(t => t.id),
        ...this.engine.unsettledTurnIds(),
      ]);
      this.forced = false;
      this.phase = "draining";
      this.timer = setInterval(() => this.check(), 25);
      this.check();
      return this.state();
    } catch (error) {
      this.admission.resume();
      this.scheduler?.resume();
      this.phase = "running";
      throw error;
    }
  }
  wait(signal?: AbortSignal): Promise<DrainState> {
    this.begin();
    if (signal?.aborted) return Promise.reject(new HttpError(409, "cancelled", "drain wait cancelled"));
    if (this.phase === "drained") return Promise.resolve(this.state());
    return new Promise((resolve, reject) => {
      const done = (state: DrainState) => { signal?.removeEventListener("abort", abort); resolve(state); };
      const abort = () => { this.waiters.delete(done); reject(new HttpError(409, "cancelled", "drain wait cancelled")); };
      this.waiters.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  cancel(): DrainState {
    clearInterval(this.timer);
    this.timer = undefined;
    this.scheduler?.resume();
    this.admission.resume();
    this.phase = "running";
    this.turns.clear();
    this.forced = false;
    this.notify();
    return this.state();
  }
  /** Fences dispatch synchronously; already-started work remains visible until it settles. */
  force(): DrainState {
    this.begin();
    this.engine.abortAll();
    this.store.interruptRunningTurns();
    this.forced = true;
    this.check();
    return this.state();
  }
  close(): void { clearInterval(this.timer); this.notify(); }
  private check(): void {
    if (this.phase === "draining" && this.state().remaining.length === 0) {
      this.phase = "drained";
      clearInterval(this.timer);
      this.timer = undefined;
      this.notify();
    }
  }
  private notify(): void {
    const state = this.state();
    for (const resolve of this.waiters) resolve(state);
    this.waiters.clear();
  }
}
