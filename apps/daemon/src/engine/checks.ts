/**
 * Running a plan's acceptance checks: the app's own proof, not a Bot's say-so. `beforeSettle` and
 * `afterSettle` are the quiet-stretch hooks `organizer.ts` calls around filing a plan; `run` is
 * also what a manual create/redefine/`POST .../checks/run` kicks off. One run per plan at a time —
 * a second call while one is in flight is folded into a rerun once the first finishes, rather than
 * started alongside it — and command checks are serialized daemon-wide, so a plan full of `bun
 * test` checks does not turn into several at once fighting over the same CPU.
 */
import type { AcceptanceCheck, Locale } from "@real-bot/protocol";
import { evaluateCheck, type CheckVerdict, type ContinuityEvalDeps } from "../acceptance-eval";
import { NO_ABLATION, type Ablation } from "../ablation";
import type { JudgeContinuity } from "../continuity-check";
import type { TurnAdmission } from "../quiesce";
import { parsePlanSpec, type Store, type Task } from "../store";
import type { WakeWatch } from "../wake";

export type CheckEvaluator = (
  root: string | null,
  check: AcceptanceCheck,
  opts: { signal?: AbortSignal; wake?: WakeWatch; locale?: Locale; continuity?: ContinuityEvalDeps },
) => Promise<CheckVerdict>;

export type PlanChecksDeps = {
  store: Store;
  admission?: TurnAdmission;
  wake: WakeWatch;
  /** Rewrites a plan's `map.md` and its tickets' `ticket.md`; called once after a run finishes. */
  renderMirrors: (taskId: string) => void;
  log?: (line: string) => void;
  /** Injectable for tests; defaults to the real `evaluateCheck`. */
  evaluate?: CheckEvaluator;
  /**
   * The vision model a `continuity` check asks. The daemon wires the default endpoint's default
   * model (see `engine/continuity-judge.ts`); a suite that never creates a `continuity` check can
   * leave this out — the default throws, which reads as that check's own `error` outcome.
   */
  judgeContinuity?: JudgeContinuity;
  /** Benchmark switches (see `ablation.ts`): `acceptance-checks` makes every method here a no-op. */
  ablation?: Ablation;
};

export type RunOptions = {
  cause: "settle" | "user" | "edit";
  /** `all`: every active check. `unrun`: only ones with no finished run yet. Default: every check named by `checkIds`, else all. */
  only?: "all" | "unrun";
  checkIds?: string[];
};

export type PlanChecks = {
  run: (taskId: string, opts: RunOptions) => Promise<void>;
  /** Runs every active check first, but only when {@link Store.checkStale} says the plan needs it. */
  beforeSettle: (taskId: string) => Promise<void>;
  /** Runs whatever has no finished run yet — an organizer-added check catching up after a settle. */
  afterSettle: (taskId: string) => Promise<void>;
  /** Kills whatever is running now (command checks included) and drops queued work. */
  abortAll: () => void;
};

/** A plan's whole run gives up after this long; whatever is left over reads as `blocked`. */
const RUN_BUDGET_MS = 15 * 60_000;

export function createPlanChecks(deps: PlanChecksDeps): PlanChecks {
  const { store, admission, wake, renderMirrors } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const evaluate = deps.evaluate ?? evaluateCheck;
  const ablation = deps.ablation ?? NO_ABLATION;
  const judgeContinuity: JudgeContinuity =
    deps.judgeContinuity ??
    (async () => {
      throw new Error("continuity checks are not wired up here");
    });

  const inFlight = new Map<string, Promise<void>>();
  const rerun = new Map<string, RunOptions>();
  const controllers = new Map<string, AbortController>();
  // Command checks run one at a time, daemon-wide (FIFO), whichever plan they belong to.
  let commandChain: Promise<void> = Promise.resolve();

  function exclusiveCommand<T>(fn: () => Promise<T>): Promise<T> {
    const result = commandChain.then(fn, fn);
    commandChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * A command with no cwd runs at the workspace root, the same base a file check's path is read
   * from and the one the file tree shows — not a Bot shell's default ticket dir. A command the
   * organizer promotes from a turn's run carries that run's cwd.
   */
  function effectiveCwd(check: AcceptanceCheck): string | null {
    if (check.kind !== "command") return check.cwd;
    return check.cwd ?? ".";
  }

  async function evaluateOne(check: AcceptanceCheck, root: string | null, signal: AbortSignal, task: Task): Promise<CheckVerdict> {
    const resolved: AcceptanceCheck = check.kind === "command" ? { ...check, cwd: effectiveCwd(check) } : check;
    const locale = store.settingsCached().locale;
    if (check.kind === "continuity") {
      const continuity: ContinuityEvalDeps = {
        planDir: task.dir,
        rules: parsePlanSpec(task.spec)?.rules ?? [],
        sessionId: task.session_id,
        judge: judgeContinuity,
      };
      // Continuity checks spawn ffmpeg and ask a vision model — heavier than any other kind — so
      // they share the same daemon-wide exclusive queue a `command` check's `bun test` would.
      return exclusiveCommand(() => evaluate(root, resolved, { signal, wake, locale, continuity }));
    }
    if (check.kind === "command") return exclusiveCommand(() => evaluate(root, resolved, { signal, wake, locale }));
    return evaluate(root, resolved, { signal, wake, locale });
  }

  async function runOnce(taskId: string, opts: RunOptions): Promise<void> {
    if (ablation.has("acceptance-checks") || admission?.draining) return;
    let task;
    try {
      task = store.getTask(taskId);
    } catch {
      return;
    }
    let checks: AcceptanceCheck[];
    try {
      checks = store.listChecks(taskId);
    } catch {
      return;
    }
    let targets = checks;
    if (opts.checkIds?.length) {
      const want = new Set(opts.checkIds);
      targets = targets.filter((check) => want.has(check.id));
    } else if (opts.only === "unrun") {
      targets = targets.filter((check) => !check.last_run);
    }
    if (targets.length === 0) return;

    const root = store.workspacePath();
    const controller = new AbortController();
    controllers.set(taskId, controller);
    const startedAt = Date.now();
    let ran = false;
    try {
      for (const check of targets) {
        if (admission?.draining || controller.signal.aborted) break;
        if (Date.now() - startedAt > RUN_BUDGET_MS) {
          try {
            const skipped = store.beginCheckRun(check.id, opts.cause);
            store.finishCheckRun(skipped.id, { outcome: "blocked", exitCode: null, detail: store.settingsCached().locale === "en" ? "out of time this run" : "这一轮检查的时间用完了", output: null });
            ran = true;
          } catch {
            // the check went away meanwhile
          }
          continue;
        }
        let runId: string;
        try {
          runId = store.beginCheckRun(check.id, opts.cause).id;
        } catch {
          continue;
        }
        ran = true;
        let verdict: CheckVerdict;
        try {
          verdict = await evaluateOne(check, root, controller.signal, task);
        } catch (error) {
          verdict = { outcome: "error", exitCode: null, detail: error instanceof Error ? error.message : "check failed", output: null };
        }
        try {
          store.finishCheckRun(runId, verdict);
        } catch (error) {
          log(`[checks] plan ${taskId}: could not close a run: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      controllers.delete(taskId);
    }
    if (ran) {
      try {
        renderMirrors(taskId);
      } catch (error) {
        log(`[checks] plan ${taskId}: could not render mirrors: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function run(taskId: string, opts: RunOptions): Promise<void> {
    if (ablation.has("acceptance-checks")) return;
    const existing = inFlight.get(taskId);
    if (existing) {
      rerun.set(taskId, opts);
      await existing;
      return;
    }
    const promise = runOnce(taskId, opts)
      .catch((error) => log(`[checks] plan ${taskId}: run failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        inFlight.delete(taskId);
      });
    inFlight.set(taskId, promise);
    await promise;
    const next = rerun.get(taskId);
    if (next) {
      rerun.delete(taskId);
      await run(taskId, next);
    }
  }

  async function beforeSettle(taskId: string): Promise<void> {
    if (ablation.has("acceptance-checks")) return;
    let stale = false;
    try {
      stale = store.checkStale(taskId);
    } catch {
      return;
    }
    if (!stale) return;
    await run(taskId, { cause: "settle", only: "all" });
  }

  async function afterSettle(taskId: string): Promise<void> {
    if (ablation.has("acceptance-checks")) return;
    await run(taskId, { cause: "settle", only: "unrun" });
  }

  function abortAll(): void {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    rerun.clear();
  }

  return { run, beforeSettle, afterSettle, abortAll };
}
