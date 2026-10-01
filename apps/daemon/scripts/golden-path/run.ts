/**
 * One benchmark run: an isolated runtime in this process (own data dir under the output folder,
 * own free port, in-memory keystore, never the Keychain), the endpoint configured through the
 * local API, the team formed the way the setup says, your one line posted in the group, then
 * waiting until the job settles (see `settle.ts`) while answering approvals and questions the way
 * `--approvals` says and counting them. Then the runtime stops, the checks run, the judge reads
 * the delivery, and the run's numbers come back.
 *
 * The workspace lives in a temporary folder outside any repository while the team works — a Bot
 * running `git` in it must not find yours — and is copied next to the data afterwards, with the
 * kept database pointed at the copy so `eval:goal-coverage --db` can re-judge it later.
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { USER_MEMBER, type Approval, type Message } from "@real-bot/protocol";
import { ablationLabel, ablationList, type Ablation } from "../../src/ablation";
import { deliveryExcerpt } from "../../src/closing-check";
import type { CompletionsClient } from "../../src/completions";
import { stateDbPath } from "../../src/descriptor";
import { COVERAGE_EXCERPT_LIMIT, goalCoveragePayload, type CoveragePayload } from "../../src/goal-coverage-eval";
import { ORGANIZER_SETTLE_TIMEOUT_MS, SETTLE_QUIET_MS } from "../../src/organizer";
import { startRuntime, type RuntimeHandle } from "../../src/runtime";
import { memoryKeyStore } from "../../src/secrets";
import type { Store } from "../../src/store";
import { judgeCoverage, lastBotWords } from "../goal-coverage-judge";
import { scoreAttribution, type AttributionResult } from "./attribution";
import { runChecks } from "./checks";
import { htmlForJudge, isAppFile, judgedFiles } from "./deliveries";
import { countInterventions, endedStalled, STALLED_PLAN, type Interventions } from "./interventions";
import {
  ablationLeaks,
  classifyFailure,
  failureDetail,
  isCompleted,
  spendBucket,
  type ProductCheckStats,
  type RunOutcome,
  type RunResult,
  type RunStats,
  type SpendBucketStats,
} from "./report";
import { dueSteps, resolveBotDirects, scriptClock, scriptDueBeforeDeadline } from "./script";
import { settleVerdict, type PlanSettleState, type SettleSnapshot, type SettleTiming } from "./settle";
import { seedDir, type GoldenTask, type LoadedTaskSet, type ScriptStep, type Setup } from "./tasks";

/** `mcp-fixture.ts` lives beside the engine, not beside this script. */
const MCP_FIXTURE = resolve(import.meta.dir, "..", "..", "src", "mcp-fixture.ts");

/** Base timing; `runOnce` spreads this with `settleFiles` set from the run's ablation. */
export const TIMING: Omit<SettleTiming, "settleFiles"> = {
  quietMs: 15_000,
  stableMs: 5_000,
  settleQuietMs: SETTLE_QUIET_MS,
  settleGraceMs: 3_000,
  organizerTimeoutMs: ORGANIZER_SETTLE_TIMEOUT_MS + 15_000,
};
const POLL_MS = 2_000;
const PROGRESS_MS = 30_000;
/** The group is ready once it exists and nothing has moved for this long. */
const TEAM_QUIET_MS = 5_000;
/** How long the Coordinator gets to hire and open the group, within the run's own budget. */
const TEAM_BUDGET_MS = 10 * 60_000;
const MAX_JUDGED_FILES = 16;
const MAX_LISTED_FILES = 200;
const HTML_READ_BYTES = 256 * 1024;
const LIVE = "('running', 'waiting_approval', 'waiting_ask')";

/** What you say when a Bot asks you something mid-run. Each answer still counts as an intervention. */
export const AUTO_ANSWER = "你们按自己的判断定就行，不用等我。";
export const AUTO_ANSWER_PICKED = "按推荐的来，后面的也按你们的判断定，不用等我。";

export type RunOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  judgeModel: string;
  timeoutMs: number;
  judgeTimeoutMs: number;
  approvals: "allow-once" | "deny";
  minPass: number;
  price: { input: number; output: number; cached_input?: number } | null;
  client: CompletionsClient;
  aborted: () => boolean;
  log: (line: string) => void;
};

type Api = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

function apiFor(handle: RuntimeHandle): Api {
  return async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${handle.origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? null : await res.json()) as T;
  };
}

const ms = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function listFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...listFiles(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

function fileContains(dir: string, needle: string): boolean {
  if (needle.length < 12 || !existsSync(dir)) return false;
  for (const rel of listFiles(dir)) {
    try {
      if (readFileSync(join(dir, rel)).includes(needle)) return true;
    } catch {
      // unreadable: nothing of ours in it
    }
  }
  return false;
}

/** L: a media MCP server whose jobs take `video_polls` checks to complete, registered before the task is posted. */
async function registerMcp(api: Api, task: GoldenTask, opts: RunOptions): Promise<void> {
  if (!task.mcp) return;
  await api("POST", "/v1/mcp-servers", {
    name: "media",
    transport: "stdio",
    command: process.execPath,
    args: [MCP_FIXTURE, "--media", `--video-polls=${task.mcp.video_polls}`],
    enabled: true,
  });
  opts.log(`[${task.id}] registered the media MCP fixture (video_polls=${task.mcp.video_polls})`);
}

async function configure(api: Api, workspace: string, opts: RunOptions): Promise<void> {
  const entry: { name: string; thinking_levels?: string[]; pricing?: RunOptions["price"] } = { name: opts.model };
  try {
    const probed = await api<{ catalog: Array<{ name: string; thinking_levels: string[] }> }>("POST", "/v1/models/probe", {
      endpoint_base_url: opts.baseUrl,
      endpoint_api_key: opts.apiKey,
    });
    const hit = probed.catalog.find((row) => row.name === opts.model);
    if (!hit) opts.log(`  the endpoint's /models does not list ${opts.model}; using it anyway`);
    else if (hit.thinking_levels.length > 0) entry.thinking_levels = hit.thinking_levels;
  } catch (error) {
    opts.log(`  could not list the endpoint's models (${errorText(error)}); thinking levels fall back to the app's defaults`);
  }
  if (opts.price) entry.pricing = opts.price;
  await api("PATCH", "/v1/settings", {
    workspace_path: workspace,
    endpoint_base_url: opts.baseUrl,
    endpoint_api_key: opts.apiKey,
    endpoint_models: [entry],
    endpoint_default_model: opts.model,
    locale: "zh",
  });
}

/** Approvals and questions, answered the way a human at the keyboard would under `--approvals`. */
type Pump = { handled: Set<string>; blockedTurns: Set<string> };

async function pump(store: Store, api: Api, state: Pump, opts: RunOptions, label: string): Promise<void> {
  for (const approval of store.listApprovals("pending") as Approval[]) {
    if (state.handled.has(approval.id)) continue;
    state.handled.add(approval.id);
    // A card that wants a key is never given one: the run has no key to hand a Bot.
    const action = opts.approvals === "allow-once" && !approval.requires_api_key ? "allow_once" : "deny";
    try {
      await api("POST", `/v1/approvals/${approval.id}/resolve`, { action });
      opts.log(`[${label}] approval ${approval.kind_key ?? "?"} (${(approval.summary ?? "").slice(0, 80)}) → ${action}`);
    } catch (error) {
      state.blockedTurns.add(approval.turn_id);
      opts.log(`[${label}] could not answer approval ${approval.id}: ${errorText(error)}`);
    }
  }
  const waiting = store.db
    .query<{ id: string; pending_ask_id: string }, []>(
      `SELECT id, pending_ask_id FROM turns WHERE status = 'waiting_ask' AND pending_ask_id IS NOT NULL`,
    )
    .all();
  for (const turn of waiting) {
    if (state.handled.has(turn.pending_ask_id)) continue;
    state.handled.add(turn.pending_ask_id);
    let ask: Message;
    try {
      ask = store.getMessage(turn.pending_ask_id);
    } catch {
      continue;
    }
    const first = ask.ask?.options?.[0]?.label;
    const answer = first ? { selected: [first], custom: AUTO_ANSWER_PICKED } : { custom: AUTO_ANSWER };
    try {
      await api("POST", `/v1/messages/${ask.id}/answer`, answer);
      opts.log(`[${label}] question "${ask.body.replace(/\s+/g, " ").slice(0, 80)}" → ${first ? `picked "${first}"` : "told them to decide"}`);
    } catch (error) {
      state.blockedTurns.add(turn.id);
      opts.log(`[${label}] could not answer question ${ask.id}: ${errorText(error)}`);
    }
  }
}

function scalar<T>(store: Store, sql: string, ...params: Array<string | number>): T | null {
  const row = store.db.query<{ v: T | null }, Array<string | number>>(sql).get(...params);
  return row?.v ?? null;
}

async function snapshot(store: Store, api: Api, state: Pump & { fingerprint: string; stableSince: number }, deadlineMs: number): Promise<SettleSnapshot> {
  const now = Date.now();
  const live = store.db.query<{ id: string }, []>(`SELECT id FROM turns WHERE status IN ${LIVE}`).all();
  let pendingJudgements = 0;
  try {
    const sessions = await api<{ items: Array<{ pending_judgements?: unknown[] }> }>("GET", "/v1/sessions");
    pendingJudgements = sessions.items.reduce((n, s) => n + (s.pending_judgements?.length ?? 0), 0);
  } catch {
    pendingJudgements = 1; // unknown reads as busy
  }
  const checkBackDueMs = store.db
    .query<{ due_at: string }, []>(`SELECT due_at FROM check_backs WHERE fired_at IS NULL AND voided_at IS NULL`)
    .all()
    .map((row) => Date.parse(row.due_at));
  const runningChecks = scalar<number>(store, `SELECT COUNT(*) AS v FROM acceptance_check_runs WHERE finished_at IS NULL`) ?? 0;
  const lastActivity = scalar<string>(
    store,
    `SELECT MAX(at) AS v FROM (
       SELECT MAX(updated_at) AS at FROM turns
       UNION ALL SELECT MAX(created_at) FROM messages
       UNION ALL SELECT MAX(created_at) FROM spend
       UNION ALL SELECT MAX(MAX(created_at, COALESCE(fired_at, ''), COALESCE(voided_at, ''))) FROM check_backs
       UNION ALL SELECT MAX(COALESCE(finished_at, started_at)) FROM acceptance_check_runs
     )`,
  );
  const fingerprint = [
    scalar<string>(
      store,
      `SELECT (SELECT COUNT(*) FROM turns) || '|' || (SELECT COUNT(*) FROM messages) || '|' || (SELECT COUNT(*) FROM spend)
         || '|' || (SELECT COUNT(*) FROM check_backs) || '|' || (SELECT COUNT(*) FROM judgements)
         || '|' || (SELECT COUNT(*) FROM task_spec_revisions) || '|' || COALESCE((SELECT MAX(updated_at) FROM turns), '')
         || '|' || COALESCE((SELECT MAX(updated_at) FROM tickets), '') AS v`,
    ),
    live.length,
    pendingJudgements,
    scalar<number>(store, `SELECT COUNT(*) AS v FROM acceptance_check_runs`) ?? 0,
  ].join("|");
  if (fingerprint !== state.fingerprint) {
    state.fingerprint = fingerprint;
    state.stableSince = now;
  }
  const plans: PlanSettleState[] = store.db
    .query<{ id: string; session_id: string }, []>(
      `SELECT DISTINCT t.id, t.session_id FROM tasks t JOIN turns u ON u.task_id = t.id WHERE t.session_id IS NOT NULL`,
    )
    .all()
    .map((plan) => {
      const since = store.lastSpecRevisionAt(plan.id);
      return {
        id: plan.id,
        lastTurnEndMs: ms(scalar<string>(store, `SELECT MAX(updated_at) AS v FROM turns WHERE task_id = ? AND status NOT IN ${LIVE}`, plan.id)),
        needsFiling: store.taskMessagesSince(plan.id, since, 1).length > 0 || store.taskArtifactsSince(plan.id, since, 1).length > 0,
        // The organizer's own rows: the scribe bills as `organize` too, with its own purpose (ADR 0042).
        organizedAtMs: ms(scalar<string>(store, `SELECT MAX(created_at) AS v FROM spend WHERE kind = 'organize' AND purpose IS NULL AND session_id = ?`, plan.session_id)),
      };
    });
  return {
    nowMs: now,
    deadlineMs,
    liveTurns: live.length,
    blockedTurns: live.filter((turn) => state.blockedTurns.has(turn.id)).length,
    pendingJudgements,
    checkBackDueMs,
    runningChecks,
    lastActivityMs: ms(lastActivity) ?? now,
    stableSinceMs: state.stableSince,
    plans,
  };
}

/** The group the Coordinator opened and sits in: the one with the most Bots, newest first. */
function coordinatorGroup(store: Store, botId: string): { id: string; name: string | null } | null {
  return (
    store.db
      .query<{ id: string; name: string | null }, [string, string]>(
        `SELECT s.id, s.name FROM sessions s
         JOIN session_participants p ON p.session_id = s.id AND p.member = ? AND p.left_at IS NULL
         WHERE s.kind = 'group' AND s.archived_at IS NULL
         ORDER BY (SELECT COUNT(*) FROM session_participants q WHERE q.session_id = s.id AND q.left_at IS NULL AND q.member != ?) DESC,
                  s.created_at DESC
         LIMIT 1`,
      )
      .get(botId, USER_MEMBER) ?? null
  );
}

type Waited = { outcome: RunOutcome; detail: string | null; endedAtMs: number };

type Team =
  | {
      ok: true;
      startedAtMs: number;
      /**
       * When the task line itself was posted: the script's clock zero (see `fireDueScriptSteps`).
       * A step's `after_s` counts from here, never from `startedAtMs`, which under `coordinator`
       * comes before the team formed (up to `TEAM_BUDGET_MS` earlier).
       */
      taskPostedAtMs: number;
      sessionId: string;
      sessionKind: "group" | "direct";
      taskMessageId: string;
      teamMs: number | null;
      /** The coordinator's own direct-with-you session, for a `coordinator` script target. Set only by that setup. */
      coordinatorDirectId: string | null;
    }
  | { ok: false; startedAtMs: number; waited: Waited };

async function formTeam(
  handle: RuntimeHandle,
  api: Api,
  state: Pump & { fingerprint: string; stableSince: number },
  task: GoldenTask,
  setup: Setup,
  timing: SettleTiming,
  opts: RunOptions,
  label: string,
): Promise<Team> {
  if (setup === "solo") {
    const solo = task.setups.solo!;
    const created = await api<{ bot: { id: string }; direct_session: { id: string } }>("POST", "/v1/bots", solo.bot);
    const startedAtMs = Date.now();
    const posted = await api<{ id: string }>("POST", `/v1/sessions/${created.direct_session.id}/messages`, { body: solo.message });
    opts.log(`[${label}] direct with ${solo.bot.name}; task posted`);
    return {
      ok: true,
      startedAtMs,
      taskPostedAtMs: startedAtMs,
      sessionId: created.direct_session.id,
      sessionKind: "direct",
      taskMessageId: posted.id,
      teamMs: null,
      coordinatorDirectId: null,
    };
  }
  if (setup === "manual") {
    const ids: string[] = [];
    for (const profile of task.setups.manual.bots) {
      const created = await api<{ bot: { id: string }; direct_session: { id: string } }>("POST", "/v1/bots", profile);
      ids.push(created.bot.id);
    }
    const group = await api<{ id: string }>("POST", "/v1/sessions", { name: task.setups.manual.group, members: ids });
    const startedAtMs = Date.now();
    const posted = await api<{ id: string }>("POST", `/v1/sessions/${group.id}/messages`, { body: task.message });
    opts.log(`[${label}] group ${task.setups.manual.group} with ${task.setups.manual.bots.map((b) => b.name).join(", ")}; task posted`);
    return {
      ok: true,
      startedAtMs,
      taskPostedAtMs: startedAtMs,
      sessionId: group.id,
      sessionKind: "group",
      taskMessageId: posted.id,
      teamMs: null,
      coordinatorDirectId: null,
    };
  }
  const lead = await api<{ bot: { id: string }; direct_session: { id: string } }>("POST", "/v1/bots", task.setups.coordinator.bot);
  const startedAtMs = Date.now();
  await api("POST", `/v1/sessions/${lead.direct_session.id}/messages`, { body: task.setups.coordinator.message });
  opts.log(`[${label}] asked ${task.setups.coordinator.bot.name} to hire the team and open a group`);
  const deadlineMs = startedAtMs + opts.timeoutMs;
  const teamDeadlineMs = Math.min(deadlineMs, startedAtMs + TEAM_BUDGET_MS);
  for (;;) {
    if (opts.aborted()) return { ok: false, startedAtMs, waited: { outcome: "aborted", detail: "interrupted while the team was forming", endedAtMs: Date.now() } };
    await pump(handle.store, api, state, opts, label);
    const snap = await snapshot(handle.store, api, state, deadlineMs);
    const group = coordinatorGroup(handle.store, lead.bot.id);
    const quiet =
      snap.liveTurns === 0 &&
      snap.pendingJudgements === 0 &&
      snap.nowMs - snap.stableSinceMs >= TEAM_QUIET_MS &&
      snap.nowMs - snap.lastActivityMs >= TEAM_QUIET_MS;
    if (group && (quiet || snap.nowMs >= teamDeadlineMs)) {
      const posted = await api<{ id: string }>("POST", `/v1/sessions/${group.id}/messages`, { body: task.message });
      const taskPostedAtMs = Date.now();
      const teamMs = taskPostedAtMs - startedAtMs;
      opts.log(`[${label}] ${task.setups.coordinator.bot.name} opened ${group.name ?? group.id} in ${Math.round(teamMs / 1000)}s; task posted`);
      return {
        ok: true,
        startedAtMs,
        taskPostedAtMs,
        sessionId: group.id,
        sessionKind: "group",
        taskMessageId: posted.id,
        teamMs,
        coordinatorDirectId: lead.direct_session.id,
      };
    }
    if (!group) {
      const verdict = settleVerdict(snap, timing);
      if (verdict.state !== "busy") {
        return { ok: false, startedAtMs, waited: { outcome: "setup_failed", detail: `${task.setups.coordinator.bot.name} settled without opening a group it is in`, endedAtMs: snap.lastActivityMs } };
      }
      if (snap.nowMs >= teamDeadlineMs) {
        return { ok: false, startedAtMs, waited: { outcome: "setup_failed", detail: `no group after ${Math.round((snap.nowMs - startedAtMs) / 60_000)} min`, endedAtMs: snap.nowMs } };
      }
    }
    await Bun.sleep(POLL_MS);
  }
}

/** A task's script steps in flight for one run: what has fired, what was skipped (no session for
 *  its target under this run's setup), and each posted line's message id (for G's attribution, read
 *  back once the run ends). */
type ScriptRunner = {
  task: GoldenTask;
  team: Extract<Team, { ok: true }>;
  workspace: string;
  seeded: ReadonlySet<string>;
  fired: Set<string>;
  skipped: Set<string>;
  posted: Array<{ step: ScriptStep; messageId: string }>;
  /** Named Bots' direct-with-you session, resolved from the store right after the team formed — see `resolveBotDirects`. */
  botDirects: Record<string, string>;
};

/**
 * Posts whatever of the task's script is due. `first_delivery` costs a workspace listing, so it is
 * only taken when a step is still waiting on it. A step with no session for its target under this
 * run's setup (a `bot_direct` naming a Bot `resolveBotDirects` never found, say) is skipped, not
 * retried: the run's log names it, `runner.skipped` records it for the final `RunResult.script`
 * stats, and it never counts toward G's attribution since it never posted.
 */
async function fireDueScriptSteps(api: Api, runner: ScriptRunner, nowMs: number, opts: RunOptions, label: string): Promise<void> {
  const pending = runner.task.script.filter((step) => !runner.fired.has(step.id));
  if (pending.length === 0) return;
  const needsFirstDelivery = pending.some((step) => step.after.kind === "first_delivery");
  const { elapsedMs, firstDeliverySeen } = scriptClock({
    taskPostedAtMs: runner.team.taskPostedAtMs,
    nowMs,
    seeded: runner.seeded,
    listing: needsFirstDelivery ? listFiles(runner.workspace) : [],
    needsFirstDelivery,
  });
  for (const step of dueSteps(pending, runner.fired, elapsedMs, firstDeliverySeen)) {
    runner.fired.add(step.id);
    const sessionId =
      step.target.kind === "group"
        ? runner.team.sessionId
        : step.target.kind === "coordinator"
          ? runner.team.coordinatorDirectId
          : (runner.botDirects[step.target.bot] ?? null);
    if (!sessionId) {
      runner.skipped.add(step.id);
      opts.log(`[${label}] script step ${step.id} skipped: no session for target ${JSON.stringify(step.target)} under this setup`);
      continue;
    }
    const posted = await api<{ id: string }>("POST", `/v1/sessions/${sessionId}/messages`, { body: step.body });
    runner.posted.push({ step, messageId: posted.id });
    opts.log(`[${label}] script step ${step.id} posted at +${Math.round(elapsedMs / 1000)}s`);
  }
}

async function waitSettled(
  handle: RuntimeHandle,
  api: Api,
  state: Pump & { fingerprint: string; stableSince: number },
  deadlineMs: number,
  timing: SettleTiming,
  opts: RunOptions,
  label: string,
  runner: ScriptRunner | null,
): Promise<Waited> {
  let lastProgress = Date.now();
  for (;;) {
    if (opts.aborted()) return { outcome: "aborted", detail: "interrupted", endedAtMs: Date.now() };
    await pump(handle.store, api, state, opts, label);
    if (runner) await fireDueScriptSteps(api, runner, Date.now(), opts, label);
    const snap = await snapshot(handle.store, api, state, deadlineMs);
    const verdict = settleVerdict(snap, timing);
    // A run must not settle out from under a script that still has something due: without this, a
    // task that goes quiet early (repeat-note settling around 50s, say) would return before its
    // +90s/+150s lines ever got a chance to fire, silently truncating the script.
    const pendingStep = runner ? scriptDueBeforeDeadline(runner.task.script, runner.fired, runner.team.taskPostedAtMs, deadlineMs) : null;
    if (verdict.state === "settled" && !pendingStep) return { outcome: "settled", detail: null, endedAtMs: snap.lastActivityMs };
    if (verdict.state === "blocked") return { outcome: "blocked_on_user", detail: verdict.waitingOn.join("; "), endedAtMs: snap.lastActivityMs };
    if (snap.nowMs >= deadlineMs) return { outcome: "timeout", detail: `still ${verdict.waitingOn.join("; ")}`, endedAtMs: deadlineMs };
    if (snap.nowMs - lastProgress >= PROGRESS_MS) {
      lastProgress = snap.nowMs;
      const turns = scalar<number>(handle.store, `SELECT COUNT(*) AS v FROM turns`) ?? 0;
      const waitingOn = verdict.state === "settled" && pendingStep ? [`script step ${pendingStep.id} still due`] : verdict.waitingOn;
      opts.log(`[${label}] ${Math.round((snap.nowMs - (deadlineMs - opts.timeoutMs)) / 1000)}s: ${turns} turn(s) so far; waiting on ${waitingOn.join("; ")}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

type Collected = {
  plan: RunResult["plan"];
  planId: string | null;
  endedStalled: boolean;
  team: RunResult["team"];
  interventions: Interventions;
  stats: RunStats;
  cited: string[];
  finalMessages: Array<{ author: string; body: string }>;
  pendingCheckBacks: number;
};

/**
 * Which Bots ended up on this scripted line, by name — informational (see `attribution.ts`'s doc
 * comment for why this is not what G scores), read from both a turn this line triggered and a
 * `judgements` row that joined it into an already-running turn (which opens no new turn row, so
 * `trigger_message_id` alone misses it).
 */
function triggeredBots(store: Store, messageId: string): string[] {
  const triggered = store.db.query<{ bot_id: string }, [string]>(`SELECT DISTINCT bot_id FROM turns WHERE trigger_message_id = ?`).all(messageId);
  const joined = store.db
    .query<{ bot_id: string }, [string]>(`SELECT DISTINCT bot_id FROM judgements WHERE message_id = ? AND decision = 'join'`)
    .all(messageId);
  const ids = [...new Set([...triggered, ...joined].map((row) => row.bot_id))];
  return ids.map((id) => nameOf(store, id)).filter((name): name is string => name !== null);
}

/** The plan a posted line's message ended up filed under, once the run ends — null when it never got one (see `attribution.ts`'s doc comment). */
function messageTaskId(store: Store, messageId: string): string | null {
  try {
    return store.getMessage(messageId).task_id ?? null;
  } catch {
    return null;
  }
}

function nameOf(store: Store, id: string | null): string | null {
  if (!id) return null;
  try {
    return store.getBot(id).name;
  } catch {
    return id;
  }
}

/**
 * The plan the task message was filed under: the message's own `task_id` (the organizer's filing,
 * or else the first turn that opened on it; see `attribution.ts`), and failing that the first turn
 * it triggered that carries a `task_id`.
 */
function planIdFor(store: Store, taskMessageId: string | null): string | null {
  if (!taskMessageId) return null;
  try {
    const direct = store.getMessage(taskMessageId).task_id ?? null;
    if (direct) return direct;
  } catch {
    // stale message id: fall through to the turns fallback below
  }
  return scalar<string>(
    store,
    `SELECT task_id AS v FROM turns WHERE trigger_message_id = ? AND task_id IS NOT NULL ORDER BY created_at LIMIT 1`,
    taskMessageId,
  );
}

function collect(store: Store, sessionId: string | null, taskMessageId: string | null, workspace: string): Collected {
  const planId = planIdFor(store, taskMessageId);
  let plan: RunResult["plan"] = null;
  let stalled = false;
  let cited: string[] = [];
  if (planId) {
    const task = store.getTask(planId);
    plan = {
      id: task.id,
      title: task.title,
      dir: task.dir,
      status: task.status,
      tickets: store.listTickets(planId).map((ticket) => ({ seq: ticket.seq, title: ticket.title, status: ticket.status, worker: nameOf(store, ticket.worker) })),
    };
    const stalls = store.db
      .query<{ created_at: string }, [string, string]>(
        `SELECT n.created_at FROM notifications n JOIN messages m ON m.id = n.message_id
         WHERE n.kind = 'failure' AND n.fail_kind = ? AND m.task_id = ?`,
      )
      .all(STALLED_PLAN, planId)
      .map((row) => row.created_at);
    stalled = endedStalled(stalls, scalar<string>(store, `SELECT MAX(updated_at) AS v FROM turns WHERE task_id = ?`, planId));
    cited = store.taskArtifacts(planId, (path) => existsSync(join(workspace, path))).map((row) => row.path);
  } else if (sessionId) {
    cited = store.db
      .query<{ path: string }, [string]>(
        `SELECT DISTINCT a.workspace_relpath AS path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.session_id = ?`,
      )
      .all(sessionId)
      .map((row) => row.path);
  }
  const session = sessionId
    ? store.db.query<{ name: string | null; kind: string }, [string]>(`SELECT name, kind FROM sessions WHERE id = ?`).get(sessionId)
    : null;
  const speakers = sessionId
    ? Object.fromEntries(
        store.db
          .query<{ author: string; n: number }, [string]>(
            `SELECT author, COUNT(*) AS n FROM messages WHERE session_id = ? AND kind = 'bot' GROUP BY author ORDER BY n DESC`,
          )
          .all(sessionId)
          .map((row) => [nameOf(store, row.author) ?? row.author, row.n]),
      )
    : {};
  const interventions = countInterventions({
    approvals: store.db.query<{ status: string; kind_key: string | null }, []>(`SELECT status, kind_key FROM approvals`).all(),
    asks: store.db.query<{ id: string }, []>(`SELECT id FROM messages WHERE kind = 'ask'`).all(),
    notifications: store.db.query<{ kind: string; fail_kind: string | null }, []>(`SELECT kind, fail_kind FROM notifications`).all(),
    checkBacks: store.db.query<{ kind: string | null }, []>(`SELECT kind FROM check_backs`).all(),
    routes: store.db.query<{ outcome: string | null }, []>(`SELECT outcome FROM turn_route_decisions`).all(),
    turns: store.db.query<{ status: string }, []>(`SELECT status FROM turns`).all(),
  });
  const work = store.db
    .query<{ hops: number | null; tool_calls: number | null; tool_errors: number | null }, []>(
      `SELECT SUM(hops) AS hops, SUM(tool_calls) AS tool_calls, SUM(tool_errors) AS tool_errors FROM turn_route_decisions`,
    )
    .get();
  const spend = store.db
    .query<{ n: number; input: number | null; output: number | null; reported: number | null; estimated: number | null }, []>(
      `SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cost_usd_ticks) AS reported, SUM(estimated_cost_usd_ticks) AS estimated FROM spend`,
    )
    .get();
  const ticks = spend && (spend.reported !== null || spend.estimated !== null) ? (spend.reported ?? 0) + (spend.estimated ?? 0) : null;
  const spendByKindRows = store.db
    .query<
      { kind: string; thinking_level: string | null; purpose: string | null; n: number; input: number | null; output: number | null; reported: number | null; estimated: number | null },
      []
    >(
      `SELECT kind, thinking_level, purpose, COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cost_usd_ticks) AS reported, SUM(estimated_cost_usd_ticks) AS estimated
       FROM spend GROUP BY kind, thinking_level, purpose`,
    )
    .all();
  const spendByKind: Record<string, SpendBucketStats> = {};
  for (const row of spendByKindRows) {
    const bucket = spendBucket(row.kind, row.thinking_level, row.purpose);
    const acc = spendByKind[bucket] ?? { rows: 0, input_tokens: 0, output_tokens: 0, cost_usd: null };
    acc.rows += row.n;
    acc.input_tokens += row.input ?? 0;
    acc.output_tokens += row.output ?? 0;
    const rowTicks = row.reported !== null || row.estimated !== null ? (row.reported ?? 0) + (row.estimated ?? 0) : null;
    if (rowTicks !== null) acc.cost_usd = (acc.cost_usd ?? 0) + rowTicks / 1e10;
    spendByKind[bucket] = acc;
  }
  let thinkingLevels: Record<string, number> = {};
  try {
    thinkingLevels = Object.fromEntries(
      store.db
        .query<{ thinking_level: string | null; n: number }, []>(`SELECT thinking_level, COUNT(*) AS n FROM turn_route_decisions GROUP BY thinking_level`)
        .all()
        .map((row) => [row.thinking_level ?? "null", row.n]),
    );
  } catch {
    thinkingLevels = {};
  }
  // The plan's acceptance checks (可执行验收) as they stand at the end of the run: each one's last
  // finished outcome, and where it came from.
  let productChecks: ProductCheckStats | undefined;
  if (planId) {
    const checks = store.listChecks(planId);
    productChecks = { total: checks.length, pass: 0, fail: 0, blocked: 0, error: 0, organizer: 0, user: 0 };
    for (const check of checks) {
      if (check.source === "organizer") productChecks.organizer += 1;
      else productChecks.user += 1;
      const outcome = check.last_run?.outcome;
      if (outcome === "pass") productChecks.pass += 1;
      else if (outcome === "fail") productChecks.fail += 1;
      else if (outcome === "blocked") productChecks.blocked += 1;
      else if (outcome === "error") productChecks.error += 1;
    }
  }
  return {
    plan,
    planId,
    endedStalled: stalled,
    team: {
      group_id: sessionId,
      group_name: session?.name ?? null,
      bots: store.listBots().map((bot) => bot.name),
      speakers,
      session_kind: (session?.kind as "group" | "direct" | undefined) ?? null,
    },
    interventions,
    stats: {
      turns: scalar<number>(store, `SELECT COUNT(*) AS v FROM turns`) ?? 0,
      hops: work?.hops ?? 0,
      tool_calls: work?.tool_calls ?? 0,
      tool_errors: work?.tool_errors ?? 0,
      messages: scalar<number>(store, `SELECT COUNT(*) AS v FROM messages WHERE kind IN ('user', 'bot', 'ask')`) ?? 0,
      spend_rows: spend?.n ?? 0,
      input_tokens: spend?.input ?? 0,
      output_tokens: spend?.output ?? 0,
      cost_usd: ticks === null ? null : ticks / 1e10,
      judge_input_tokens: null,
      judge_output_tokens: null,
      spend_by_kind: spendByKind,
      thinking_levels: thinkingLevels,
      product_checks: productChecks,
    },
    cited,
    finalMessages: planId ? lastBotWords(store, { taskId: planId }) : sessionId ? lastBotWords(store, { sessionId }) : [],
    pendingCheckBacks: scalar<number>(store, `SELECT COUNT(*) AS v FROM check_backs WHERE fired_at IS NULL AND voided_at IS NULL`) ?? 0,
  };
}

function excerptForJudge(workspace: string, rel: string): string | null {
  if (/\.html?$/i.test(rel)) {
    try {
      const raw = readFileSync(join(workspace, rel));
      return htmlForJudge(raw.subarray(0, HTML_READ_BYTES).toString("utf8"));
    } catch {
      return null;
    }
  }
  // One past the judge's limit, so the payload marks a long file as cut.
  return deliveryExcerpt(workspace, rel, COVERAGE_EXCERPT_LIMIT + 1).excerpt;
}

function judgePayload(loaded: LoadedTaskSet, task: GoldenTask, workspace: string, collected: Collected): CoveragePayload {
  const brief = readFileSync(join(seedDir(loaded, task), task.brief), "utf8");
  const files = judgedFiles({
    deliverables: task.deliverables,
    cited: collected.cited,
    exists: (path) => existsSync(join(workspace, path)) && statSync(join(workspace, path)).isFile(),
    limit: MAX_JUDGED_FILES,
  });
  return goalCoveragePayload({
    brief: `${task.message}\n\n——以下是 ${task.brief} 的原文——\n${brief}`,
    plan: { goal: task.goal, acceptance: task.acceptance, rules: task.rules },
    deliveries: files.map((path) => ({ path, excerpt: excerptForJudge(workspace, path) })),
    finalMessages: collected.finalMessages,
  });
}

/** The kept database points at the kept copy of the workspace, not the temporary one. */
function relocateWorkspace(dataDir: string, workspace: string): void {
  const db = new Database(stateDbPath(dataDir));
  try {
    db.run(`UPDATE settings SET value = ? WHERE key = 'workspace_path'`, [workspace]);
  } finally {
    db.close();
  }
}

const EMPTY_INTERVENTIONS: Interventions = {
  total: 0,
  approvals: 0,
  approval_kinds: {},
  asks: 0,
  stalls: 0,
  plan_nudges: 0,
  turn_failures: 0,
  interrupted: 0,
};

const EMPTY_STATS: RunStats = {
  turns: 0,
  hops: 0,
  tool_calls: 0,
  tool_errors: 0,
  messages: 0,
  spend_rows: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: null,
  judge_input_tokens: null,
  judge_output_tokens: null,
  spend_by_kind: {},
  thinking_levels: {},
};

export async function runOnce(input: {
  loaded: LoadedTaskSet;
  task: GoldenTask;
  setup: Setup;
  ablation: Ablation;
  index: number;
  outDir: string;
  opts: RunOptions;
}): Promise<RunResult> {
  const { loaded, task, setup, ablation, index, outDir, opts } = input;
  // Existing layout when nothing is ablated (`runs/<task>--<setup>--<n>`); ablated runs get the
  // label folded in before the run number (`runs/<task>--<setup>--<label>--<n>`).
  const ablationSuffix = ablationLabel(ablation) === "none" ? "" : `--${ablationLabel(ablation)}`;
  const label = `${task.id}/${setup}${ablationSuffix}#${index}`;
  const runDir = join(outDir, "runs", `${task.id}--${setup}${ablationSuffix}--${index}`);
  const dataDir = join(runDir, "data");
  mkdirSync(dataDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "deskfolk-golden-path-"));
  const workspace = join(scratch, "workspace");
  cpSync(seedDir(loaded, task), workspace, { recursive: true });
  const seeded = new Set(listFiles(workspace));

  let outcome: RunOutcome = "error";
  let detail: string | null = null;
  let startedAtMs = Date.now();
  let endedAtMs = startedAtMs;
  let teamMs: number | null = null;
  let collected: Collected | null = null;
  let attribution: AttributionResult | null = null;
  let runner: ScriptRunner | null = null;
  let handle: RuntimeHandle | null = null;
  // `organize-settle` off: a plan counts as settled once its timer and grace pass, without
  // waiting on an `organize` row or the organizer's own timeout (settle.ts's `settleFiles`).
  const timing: SettleTiming = { ...TIMING, settleFiles: !ablation.has("organize-settle") };
  try {
    // Scheduler on: it is what fires the check-backs Bots book, and seeing a job through relies on them.
    handle = await startRuntime({ dataDir, bind: "127.0.0.1:0", endpointKey: memoryKeyStore(), schedule: true, supervisor: "none", ablation });
    const api = apiFor(handle);
    await configure(api, workspace, opts);
    await registerMcp(api, task, opts);
    const state = { handled: new Set<string>(), blockedTurns: new Set<string>(), fingerprint: "", stableSince: Date.now() };
    const team = await formTeam(handle, api, state, task, setup, timing, opts, label);
    startedAtMs = team.startedAtMs;
    let sessionId: string | null = null;
    let taskMessageId: string | null = null;
    if (!team.ok) {
      ({ outcome, detail, endedAtMs } = team.waited);
    } else {
      sessionId = team.sessionId;
      taskMessageId = team.taskMessageId;
      teamMs = team.teamMs;
      if (task.script.length > 0) {
        // Looked up by name once the team has formed, so a `bot_direct` step resolves under any
        // setup, whoever created the Bot (see `resolveBotDirects`).
        const botDirects = resolveBotDirects(handle.store, task.setups.manual.bots.map((bot) => bot.name));
        runner = { task, team, workspace, seeded, fired: new Set(), skipped: new Set(), posted: [], botDirects };
      }
      ({ outcome, detail, endedAtMs } = await waitSettled(handle, api, state, startedAtMs + opts.timeoutMs, timing, opts, label, runner));
      const labelled = (runner?.posted ?? []).filter(
        (row): row is { step: ScriptStep & { expect_plan: "kickoff" | "new" }; messageId: string } => row.step.expect_plan !== null,
      );
      if (labelled.length > 0) {
        const store = handle.store;
        const kickoffTaskId = planIdFor(store, taskMessageId);
        attribution = scoreAttribution(
          labelled.map(({ step, messageId }) => ({
            step_id: step.id,
            expect_plan: step.expect_plan,
            actual_task_id: messageTaskId(store, messageId),
            kickoff_task_id: kickoffTaskId,
            actual_bots: triggeredBots(store, messageId),
          })),
        );
      }
    }
    collected = collect(handle.store, sessionId, taskMessageId, workspace);
    if (outcome === "settled" && collected.endedStalled) {
      outcome = "blocked_on_user";
      detail = "the app told you the plan stopped with tickets open, and nothing moved after";
    }
  } catch (error) {
    outcome = "error";
    detail = errorText(error);
    endedAtMs = Date.now();
    opts.log(`[${label}] error: ${detail}`);
  } finally {
    if (handle) {
      try {
        // A run that hit its deadline mid-tool-call (a foreground `python3 -m http.server`, say)
        // leaves a live turn `stop()`'s own drainLives() would otherwise wait out — it only aborts
        // once nothing new is submitted, not on command. `/v1/runtime/quit` is the app's own route
        // for a clean shutdown: it aborts every live turn immediately, the same way quitting the
        // real app does, before `stop()` closes the runtime around it.
        await apiFor(handle)("POST", "/v1/runtime/quit");
      } catch {
        // best-effort: nothing was live, or the runtime never got far enough to answer
      }
    }
    try {
      await handle?.stop();
    } catch (error) {
      opts.log(`[${label}] runtime did not stop cleanly: ${errorText(error)}`);
    }
  }

  const checks = runChecks(task, workspace);
  const payload = collected && outcome !== "setup_failed" && outcome !== "aborted" ? judgePayload(loaded, task, workspace, collected) : null;
  const written = listFiles(workspace).filter((path) => !seeded.has(path) && !isAppFile(path));
  const kept = join(runDir, "workspace");
  cpSync(workspace, kept, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  rmSync(scratch, { recursive: true, force: true });
  try {
    relocateWorkspace(dataDir, kept);
  } catch (error) {
    opts.log(`[${label}] could not point the kept database at the kept workspace: ${errorText(error)}`);
  }
  const keyLeak = fileContains(dataDir, opts.apiKey) || fileContains(kept, opts.apiKey);
  if (keyLeak) opts.log(`[${label}] WARNING: the endpoint key appears in ${runDir}; delete that folder`);

  let verdict: Awaited<ReturnType<typeof judgeCoverage>> | null = null;
  if (payload) {
    opts.log(`[${label}] judging with ${opts.judgeModel} (${payload.deliveries.length} file(s))`);
    verdict = await judgeCoverage({ client: opts.client, baseUrl: opts.baseUrl, apiKey: opts.apiKey, model: opts.judgeModel, timeoutMs: opts.judgeTimeoutMs, payload });
  }
  const stats: RunStats = {
    ...(collected?.stats ?? EMPTY_STATS),
    judge_input_tokens: verdict?.usage?.input_tokens ?? null,
    judge_output_tokens: verdict?.usage?.output_tokens ?? null,
  };
  const checksOk = checks.every((check) => check.ok);
  const score = verdict?.score ?? null;
  const ablated = ablationList(ablation);
  const result: RunResult = {
    task: task.id,
    title: task.title,
    setup,
    run: index,
    outcome,
    outcome_detail: detail,
    completed: false,
    wall_ms: Math.max(0, endedAtMs - startedAtMs),
    team_ms: teamMs,
    team: collected?.team ?? { group_id: null, group_name: null, bots: [], speakers: {}, session_kind: null },
    plan: collected?.plan ?? null,
    coverage: verdict?.coverage ?? null,
    score,
    judge_error: payload ? (verdict?.error ?? null) : outcome === "setup_failed" ? "no team, nothing to judge" : outcome === "aborted" ? "aborted" : "nothing collected",
    checks,
    checks_ok: checksOk,
    interventions: collected?.interventions ?? EMPTY_INTERVENTIONS,
    stats,
    files: { cited: collected?.cited ?? [], written: written.slice(0, MAX_LISTED_FILES) },
    pending_check_backs: collected?.pendingCheckBacks ?? 0,
    run_dir: relative(outDir, runDir),
    key_leak: keyLeak,
    ended_stalled: collected?.endedStalled ?? false,
    ablation: ablationLabel(ablation),
    ablated,
    ablation_leaks: ablationLeaks(ablated, stats.spend_by_kind),
    attribution,
    // A step that came due is in `fired` (posted) or `skipped` (no session for its target); every
    // other id is `unfired`: the team never formed, the deadline came first (see
    // `scriptDueBeforeDeadline`), or a `first_delivery` step's delivery never came. See `ScriptStats`.
    script: {
      fired: (runner?.posted ?? []).map((row) => row.step.id),
      skipped: [...(runner?.skipped ?? [])],
      unfired: task.script.map((step) => step.id).filter((id) => !(runner?.fired.has(id) ?? false)),
    },
    failure: null,
    failure_detail: null,
  };
  result.completed = isCompleted(result, opts.minPass);
  result.failure = classifyFailure(result, opts.minPass);
  result.failure_detail = failureDetail(result, result.failure);
  return result;
}
