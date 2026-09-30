/**
 * When a task's scripted follow-up lines are due. The S and R benchmark families need a line typed
 * partway through a run without you at the keyboard — a stop, the same complaint again — timed off
 * the run's own clock or off the first file the team hands over; pure over that clock, so the
 * timing rules are unit-tested without a runtime. `run.ts` calls `dueSteps` once a poll tick and
 * posts whatever comes back, in the task's script order, each step firing exactly once; a
 * `bot_direct` step posts into the session `resolveBotDirects` found for its Bot.
 */
import { USER_MEMBER } from "@real-bot/protocol";
import type { Store } from "../../src/store";
import { isAppFile } from "./deliveries";
import type { ScriptStep } from "./tasks";

export function dueSteps(steps: readonly ScriptStep[], fired: ReadonlySet<string>, elapsedMs: number, firstDeliverySeen: boolean): ScriptStep[] {
  return steps.filter((step) => {
    if (fired.has(step.id)) return false;
    if (step.after.kind === "seconds") return elapsedMs >= step.after.after_s * 1000;
    return firstDeliverySeen;
  });
}

/**
 * Whether a `seconds` step could still post before the run's deadline: an unfired one whose due
 * time has not passed the deadline yet. `run.ts`'s `waitSettled` treats a hit as busy, not settled
 * — otherwise a run that goes quiet early (a small task settling around 50s, say) would return
 * before its +90s/+150s lines ever got a chance to fire, silently truncating the script. An unfired
 * `first_delivery` step is not counted here: whether it ever fires depends on the team actually
 * delivering something, which a run that is otherwise settled will never do — waiting on it would
 * just run the clock out to `timeout` instead of a true `settled`. It shows up as `unfired` in the
 * run's `script` stats instead (see `report.ts`), not as a reason to keep waiting. Returns the first
 * pending step, for the caller to name in its log.
 */
export function scriptDueBeforeDeadline(
  steps: readonly ScriptStep[],
  fired: ReadonlySet<string>,
  taskPostedAtMs: number,
  deadlineMs: number,
): ScriptStep | null {
  for (const step of steps) {
    if (fired.has(step.id)) continue;
    if (step.after.kind === "first_delivery") continue;
    if (taskPostedAtMs + step.after.after_s * 1000 <= deadlineMs) return step;
  }
  return null;
}

/**
 * The two things `fireDueScriptSteps` needs off the run's clock and the workspace: how long since
 * the task line posted, and (only when something is still waiting on it) whether the team has
 * delivered a first new file yet. Pulled out as its own pure function so the coordinator's later
 * clock-zero (`taskPostedAtMs`, well after the run's own start) and the `isAppFile` filter (a lone
 * `map.md` from the plan mirror is not a delivery) are each testable without a runtime.
 */
export function scriptClock(input: {
  taskPostedAtMs: number;
  nowMs: number;
  seeded: ReadonlySet<string>;
  listing: readonly string[];
  needsFirstDelivery: boolean;
}): { elapsedMs: number; firstDeliverySeen: boolean } {
  return {
    elapsedMs: input.nowMs - input.taskPostedAtMs,
    firstDeliverySeen: input.needsFirstDelivery
      ? input.listing.some((path) => !input.seeded.has(path) && !isAppFile(path))
      : false,
  };
}

/**
 * Each named Bot's direct-with-you session, read from the store once the team has formed, for the
 * `bot_direct` script target. Every Bot gets that direct the moment it is created, whoever creates
 * it (the runner under `manual`, the Coordinator's own tool call under `coordinator`), so the
 * lookup is by name and works under either setup. A name with no Bot (or no direct) is left out,
 * and the step aimed at it is skipped.
 */
export function resolveBotDirects(
  store: Pick<Store, "listBots" | "findDirectSession">,
  botNames: readonly string[],
): Record<string, string> {
  const byName = new Map(store.listBots().map((bot) => [bot.name, bot.id]));
  const out: Record<string, string> = {};
  for (const name of botNames) {
    const id = byName.get(name);
    const direct = id ? store.findDirectSession(USER_MEMBER, id) : null;
    if (direct) out[name] = direct.id;
  }
  return out;
}
