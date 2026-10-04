/**
 * Finding large jobs (大活, ADR 0060). Two ways in: a line of yours filed under a job not read
 * either way yet is read with your other words about it (the reader, a model); and each supervisor
 * tick, a job with work going round on it and nothing through — {@link SIGNAL_SEGMENTS} segments, no
 * approval, no layout — is read once more with those facts beside your words (the signal). A
 * reading that finds it large marks it; a signal no model could read marks it anyway. Neither ever
 * takes back what you set, and neither marks a job small.
 */
import type { Reader } from "../reader";
import type { Store } from "../store";

export type ScaleWatchDeps = {
  store: Store;
  reader: Pick<Reader, "scale">;
  track: <T>(promise: Promise<T>) => Promise<T>;
  log?: (line: string) => void;
};

export type ScaleWatch = {
  /** Your line, once it is filed: each job it was filed under and not read yet is read. */
  noteLine: (messageId: string) => void;
  /** A supervisor tick: jobs the signal points at are read with their facts. */
  tick: () => void;
};

export function createScaleWatch(deps: ScaleWatchDeps): ScaleWatch {
  const { store } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));

  async function read(taskId: string, key: string, facts: { segments: number; handedBack: number } | null): Promise<void> {
    const input = store.scaleInputs(taskId);
    if (!input || input.said.length === 0) return;
    const reading = await deps.reader.scale({ key, sessionId: input.sessionId, title: input.title, goal: input.goal, said: input.said, facts });
    if (reading.source === "model" && reading.large) {
      store.markPlanScale({ taskId, value: "large", by: facts ? "signal" : "reader", why: reading.quote, unit: reading.unit });
    } else if (reading.source === "unread" && facts) {
      // The signal stands on its own when no model can read the job.
      store.markPlanScale({ taskId, value: "large", by: "signal",
        why: store.settingsCached().locale === "en" ? `${facts.segments} segments with nothing approved` : `做了 ${facts.segments} 段，还没有一件通过` });
    }
  }

  function guarded(work: () => Promise<void>, what: string): void {
    void deps.track(work().catch((error) => log(`[scale] ${what}: ${error instanceof Error ? error.message : String(error)}`)));
  }

  return {
    noteLine(messageId) {
      let tasks: string[] = [];
      try {
        tasks = [...new Set(store.filingsOfMessage(messageId).map((target) => target.taskId))];
      } catch {
        return;
      }
      for (const taskId of tasks) guarded(() => read(taskId, `scale:${taskId}:${messageId}`, null), `line ${messageId}`);
    },
    tick() {
      let plans: ReturnType<Store["signalledPlans"]> = [];
      try {
        plans = store.signalledPlans();
      } catch {
        return;
      }
      // Once per job and segment count: a job going round is asked again only after more segments.
      for (const plan of plans) {
        guarded(() => read(plan.taskId, `scale:${plan.taskId}:signal:${plan.segments}`, { segments: plan.segments, handedBack: plan.handedBack }), `plan ${plan.taskId}`);
      }
    },
  };
}
