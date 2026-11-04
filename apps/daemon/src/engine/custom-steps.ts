/**
 * Steps of your own (ADR 0105): what runs at the moments an engine's own steps run at, judged your
 * way. A step looks at a call (its tool and files), a turn's end (its last reply and the files it
 * wrote), or a hand-over (its files); judges by a rule (matching alone is a no), a command of yours
 * (exit 0 is a yes) or a model reading your words; and says pass, fail, or that it could not judge.
 * What a fail does is the caller's: this only judges and keeps the record, one call record per
 * judgement, drawn on the flow with the step's name. A step that cannot judge lets things through.
 */
import { existsSync, statSync } from "node:fs";
import { CUSTOM_STEP_CALL_ATS, customStepTimeout, type CustomStep, type CustomStepAt, type CustomStepSample, type CustomStepTool, type CustomStepTry, type Message, type Turn } from "@real-bot/protocol";
import { checkEnv, normalizeOutput, spawnCommand } from "../acceptance-eval";
import type { ClaudeJudge } from "../claude-code/reading";
import type { CompletionsClient } from "../completions";
import { promptPage } from "../prompts/book";
import { customStepPayload, parseCustomStepAnswer } from "../prompts/custom-step";
import type { Store } from "../store";
import { classifyPath, classifyShell } from "../workspace-paths";
import { recordSideSpend, runOn, sideJudge, spentOf, type BuiltinTarget } from "./builtin-models";
import type { SpendTracker } from "./spend";

/** A call a step looks at: the app's name for it, which of the kinds a step names it is, its command, its files. */
export type StepCall = { tool: string; kind: CustomStepTool | null; command: string | null; paths: string[] };

/** What happened, as much as a step at its moment can see. */
export type StepScene = {
  sessionId: string;
  botId: string | null;
  turnId: string | null;
  taskId?: string | null;
  ticketId?: string | null;
  submissionId?: string | null;
  call?: StepCall;
  /** After a call: whether it went through and what it gave back. */
  result?: { ok: boolean; output: string };
  /** As a turn ends: its last word. */
  reply?: string | null;
  /** The files at stake, relative to the workspace: a call's, a turn's written ones, a hand-over's. */
  files: string[];
};

export type StepOutcome = "pass" | "fail" | "error" | "blocked";

export type StepVerdict = {
  step: CustomStep;
  outcome: StepOutcome;
  /** Why it did not pass, or why it could not judge; null on a pass. */
  reason: string | null;
  exitCode: number | null;
  /** A command's output, its tail; a model's answer. */
  output: string | null;
};

/** Code points of a command's output a verdict keeps, and of the part a reason quotes. */
const OUTPUT_KEEP = 2000;
const REASON_KEEP = 600;
/** How long a model step may take: around a call it holds the Bot's next step. */
const MODEL_CALL_MS = 30_000;
const MODEL_MS = 90_000;

export type CustomStepsDeps = {
  store: Store;
  completions: CompletionsClient;
  claudeJudge?: ClaudeJudge | null;
  spend: SpendTracker;
  /** The model a step that reads your words runs on: its own when chosen, else the checks'. */
  target: () => Promise<BuiltinTarget | null>;
  publishMessage: (message: Message) => void;
  /** The lane command checks run in one at a time, which a hand-in's steps share. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
};

/** A call as a runner sees it: its files as named (relative to the workspace or absolute), its command, whether it is an MCP tool's. */
export type EffectCall = { command?: string | null; paths?: readonly string[]; mcp?: boolean };

export type CustomSteps = {
  /** The steps here at a moment that look at this scene, judged in order; `stop` ends the run at a fail it says to stop at. */
  run: (at: CustomStepAt, scene: StepScene, opts?: RunOptions) => Promise<StepVerdict[]>;
  /**
   * Before a call with an effect: a refusal the Bot hears instead of the call, or the notes it hears
   * beside it. Only the calls a step can name are looked at (files, a shell, an MCP tool's).
   */
  beforeCall: (turn: Turn, tool: string, call: EffectCall, signal?: AbortSignal) => Promise<{ refusal: string | null; notes: string[] }>;
  /** After one: the notes the Bot hears beside its result. */
  afterCall: (turn: Turn, tool: string, call: EffectCall, result: { ok: boolean; output: string }, signal?: AbortSignal) => Promise<string[]>;
  /**
   * As a turn ends having done its work: a send-back the Bot hears instead of ending (null when none,
   * or none left — the end contract's two per segment), and the lines that go to you.
   */
  atTurnEnd: (turn: Turn, input: { reply: string | null; files: readonly string[] }, signal?: AbortSignal) => Promise<{ bounce: string | null; tell: string[] }>;
  /** A hand-in's steps, judged and kept for its settle to read beside its checks. */
  onHandedIn: (submission: { id: string; task_id: string; ticket_id: string; bot_id: string; turn_id: string | null; artifacts: ReadonlyArray<{ path: string }> }) => Promise<void>;
  /** Approvals and your send-backs since the last look, each run past the steps after it; from the scheduler's tick. */
  sweep: () => Promise<void>;
  /** One step judged on a sample, carried out nowhere and kept nowhere: the panel's try. */
  tryStep: (step: CustomStep, sample: CustomStepSample) => Promise<CustomStepTry>;
};

export type RunOptions = {
  signal?: AbortSignal;
  /** Whether a fail of this step is carried out, for its record (a send-back with none left is not). */
  applies?: (step: CustomStep) => boolean;
  /** Stop judging after a fail of this step: the call it refuses will not run, so the rest need not look. */
  stopAt?: (step: CustomStep) => boolean;
};

function tail(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-(limit - 1)).join("")}` : text;
}

function clip(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
}

function globMatches(glob: string, path: string): boolean {
  try {
    return new Bun.Glob(glob).match(path);
  } catch {
    return false;
  }
}

/** What made a step look, or null when it does not look at this scene: the tool or the first file it names. */
export function stepHit(step: CustomStep, scene: StepScene): { tool: string | null; file: string | null } | null {
  const match = step.match;
  let tool: string | null = null;
  if (match?.tools?.length) {
    const kind = scene.call?.kind ?? null;
    if (!kind || !match.tools.includes(kind)) return null;
    tool = kind;
  }
  let file: string | null = null;
  if (match?.paths?.length) {
    file = scene.files.find((path) => match.paths!.some((glob) => globMatches(glob, path))) ?? null;
    if (!file) return null;
  }
  return { tool, file };
}

/** The kind of call a step can name, by the app's tool name; null for any other call. */
export function stepToolKind(tool: string, isMcp: boolean): CustomStepTool | null {
  if (tool === "write_file" || tool === "delete_file" || tool === "shell") return tool;
  return isMcp ? "mcp" : null;
}

/** A path a call names, relative to the workspace when it is inside it; as given otherwise. */
export function workspaceRelative(root: string | null, path: string): string {
  if (!root) return path;
  try {
    const classified = classifyPath(root, path);
    return classified.zone === "inside" && classified.rel ? classified.rel : path;
  } catch {
    return path;
  }
}

/** What a command reads on stdin and a model is shown: the moment and what happened, nothing of the daemon's own. */
function happened(step: CustomStep, scene: StepScene): Record<string, unknown> {
  return {
    step: step.name,
    ...(scene.call ? { call: { tool: scene.call.tool, ...(scene.call.command ? { command: scene.call.command } : {}), paths: scene.call.paths } } : {}),
    ...(scene.result ? { result: { ok: scene.result.ok, output: tail(scene.result.output, OUTPUT_KEEP) } } : {}),
    ...(scene.reply !== undefined && scene.reply !== null ? { reply: clip(scene.reply, 8000) } : {}),
    files: scene.files,
    session_id: scene.sessionId,
    ...(scene.botId ? { bot_id: scene.botId } : {}),
    ...(scene.turnId ? { turn_id: scene.turnId } : {}),
    ...(scene.taskId ? { task_id: scene.taskId } : {}),
    ...(scene.submissionId ? { submission_id: scene.submissionId } : {}),
  };
}

export function createCustomSteps(deps: CustomStepsDeps): CustomSteps {
  const { store } = deps;
  const en = () => store.settingsCached().locale === "en";
  const say = (zh: string, english: string) => (en() ? english : zh);

  type Judged = StepVerdict & { record: { model?: { prompt: { id: string; revision_id: string | null; locale: string }; target: BuiltinTarget; spendId: string | null; failKind: string | null; unreadable: boolean } }; ms: number };

  function rule(step: CustomStep, scene: StepScene): Judged {
    const hit = stepHit(step, scene);
    const what = hit?.file ?? hit?.tool ?? "";
    return { step, outcome: "fail", reason: say(`碰到了「${step.name}」管的 ${what}`, `it touches ${what}, which "${step.name}" holds`), exitCode: null, output: null, record: {}, ms: 0 };
  }

  async function command(step: CustomStep, run: Extract<CustomStep["run"], { kind: "command" }>, scene: StepScene, signal?: AbortSignal): Promise<Judged> {
    const started = Date.now();
    const done = (outcome: StepOutcome, reason: string | null, exitCode: number | null = null, output: string | null = null): Judged =>
      ({ step, outcome, reason, exitCode, output, record: {}, ms: Date.now() - started });
    const root = store.workspacePath();
    if (!root) return done("blocked", say("还没有工作区", "no workspace is set"));
    let classified: ReturnType<typeof classifyShell>;
    try {
      classified = classifyShell(root, run.command, run.cwd ?? ".");
    } catch {
      return done("blocked", say("命令在工作区外", "the command reaches outside the workspace"));
    }
    if (classified.kind === "unconstrained") return done("blocked", say("命令在工作区外", "the command reaches outside the workspace"));
    if (!existsSync(classified.cwdAbs) || !statSync(classified.cwdAbs).isDirectory()) return done("error", say(`运行目录 ${run.cwd ?? "."} 不在`, `the folder ${run.cwd ?? "."} is not there`));
    const env = {
      ...checkEnv(process.env),
      DESKFOLK_EVENT: step.at,
      DESKFOLK_STEP: step.name,
      DESKFOLK_WORKSPACE: root,
      DESKFOLK_PATHS: scene.files.join("\n"),
      ...(scene.call?.command ? { DESKFOLK_COMMAND: scene.call.command } : {}),
    };
    const seconds = run.timeout_s ?? customStepTimeout(step.at).default;
    const result = await spawnCommand(run.command, classified.cwdAbs, env, seconds * 1000, signal, undefined, JSON.stringify(happened(step, scene)));
    const combined = normalizeOutput(`${result.stdout}${result.stderr ? (result.stdout ? "\n" : "") + result.stderr : ""}`);
    const output = combined ? tail(combined, OUTPUT_KEEP) : null;
    if (result.spawnError) return done("error", say("命令没能跑起来", "the command would not start"), null, output);
    if (result.aborted) return done("error", say("跑到一半被打断", "cut off midway"), null, output);
    if (result.timedOut) return done("error", say(`${seconds} 秒还没跑完`, `still running after ${seconds}s`), null, output);
    if (result.exitCode === 0) return done("pass", null, 0, output);
    const reason = combined ? tail(combined, REASON_KEEP) : say(`退出码 ${result.exitCode ?? "无"}`, `exit ${result.exitCode ?? "none"}`);
    return done("fail", reason, result.exitCode, output);
  }

  async function model(step: CustomStep, run: Extract<CustomStep["run"], { kind: "model" }>, scene: StepScene, signal?: AbortSignal): Promise<Judged> {
    const started = Date.now();
    const target = await deps.target().catch(() => null);
    if (!target) {
      return { step, outcome: "error", reason: say("没有可用的模型", "no model to judge with"), exitCode: null, output: null, record: {}, ms: Date.now() - started };
    }
    const locale = en() ? "en" : "zh";
    const prompt = promptPage(store, locale).resolve("call.custom_step");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let result: Awaited<ReturnType<typeof sideJudge>>;
    try {
      result = await sideJudge(deps, target, {
        prompt: prompt.ref,
        messages: [
          { role: "system", content: prompt.text },
          { role: "user", content: customStepPayload({ rule: run.prompt, moment: step.at, happened: happened(step, scene) }) },
        ],
        signal: controller.signal,
        timeoutMs: CUSTOM_STEP_CALL_ATS.includes(step.at) ? MODEL_CALL_MS : MODEL_MS,
        maxTokens: 400,
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    // Billed even when only tried from the panel: every model call the app makes is on the ledger.
    let spendId: string | null = null;
    try {
      spendId = recordSideSpend(deps.spend, { kind: "organize", purpose: "step", owner: deps.spend.spendOwner(scene.sessionId, scene.botId),
        turnId: scene.turnId, target, ...spentOf(result) })?.id ?? null;
    } catch {
      // the ledger is best effort
    }
    const answered = !result.failKind || result.failKind === "incomplete";
    const read = answered ? parseCustomStepAnswer(result.content ?? "") : null;
    const record = { model: { prompt: prompt.ref, target, spendId, failKind: answered ? null : result.failKind ?? "call_error", unreadable: answered && !read } };
    const ms = Date.now() - started;
    if (!read) {
      if (answered && !result.truncated) {
        store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: "unreadable",
          taskId: scene.taskId ?? null, botId: scene.botId });
      }
      return { step, outcome: "error", reason: answered ? say("模型的回答读不出", "the model's answer could not be read") : say("模型没有回答", "the model did not answer"),
        exitCode: null, output: result.content ?? null, record, ms };
    }
    return { step, outcome: read.pass ? "pass" : "fail", reason: read.pass ? null : read.reason || say("模型说不过", "the model said it does not pass"),
      exitCode: null, output: result.content ?? null, record, ms };
  }

  async function judge(step: CustomStep, scene: StepScene, signal?: AbortSignal): Promise<Judged> {
    try {
      if (step.run.kind === "rule") return rule(step, scene);
      if (step.run.kind === "command") return await command(step, step.run, scene, signal);
      return await model(step, step.run, scene, signal);
    } catch (error) {
      return { step, outcome: "error", reason: error instanceof Error ? error.message : String(error), exitCode: null, output: null, record: {}, ms: 0 };
    }
  }

  function record(judged: Judged, scene: StepScene, applied: boolean): void {
    const model = judged.record.model;
    try {
      store.recordCallRun({
        role: "custom_step",
        prompt: model?.prompt ?? null,
        sessionId: scene.sessionId,
        turnId: scene.turnId,
        taskId: scene.taskId ?? null,
        ticketId: scene.ticketId ?? null,
        botId: scene.botId,
        ...(model ? runOn(model.target) : {}),
        outcome: model?.unreadable ? "unreadable" : judged.outcome === "error" || judged.outcome === "blocked" ? "failed" : "ok",
        failKind: model?.unreadable ? "unreadable" : model?.failKind ?? (judged.outcome === "blocked" ? "blocked" : judged.outcome === "error" ? "step_error" : null),
        verdict: { kind: "custom_step", run: judged.step.run.kind, outcome: judged.outcome, then: judged.step.then, applied, reason: judged.reason,
          ...(judged.exitCode !== null ? { exit_code: judged.exitCode } : {}) },
        raw: judged.output,
        spendId: model?.spendId ?? null,
        ms: judged.ms,
        customStep: { id: judged.step.id, name: judged.step.name, at: judged.step.at },
        submissionId: scene.submissionId ?? null,
      });
    } catch {
      // the call record is a record
    }
  }

  async function run(at: CustomStepAt, scene: StepScene, opts: RunOptions = {}): Promise<StepVerdict[]> {
    const steps = store.customStepsAt({ sessionId: scene.sessionId, taskId: scene.taskId ?? null, turnId: scene.turnId }, at);
    const out: StepVerdict[] = [];
    for (const step of steps) {
      if (!stepHit(step, scene)) continue;
      if (opts.signal?.aborted) break;
      const judged = await judge(step, scene, opts.signal);
      const applied = judged.outcome === "fail" && (opts.applies?.(step) ?? true);
      record(judged, scene, applied);
      const { record: _record, ms: _ms, ...verdict } = judged;
      out.push(verdict);
      if (judged.outcome === "fail" && opts.stopAt?.(step)) break;
    }
    return out;
  }

  /** A call's scene: its kind, command and files, relative to the workspace. */
  function callScene(turn: Turn, tool: string, call: EffectCall): StepScene | null {
    const kind = stepToolKind(tool, call.mcp === true);
    if (!kind) return null;
    const root = store.workspacePath();
    const paths = [...new Set((call.paths ?? []).filter((path) => path.trim()).map((path) => workspaceRelative(root, path)))];
    return { sessionId: turn.session_id, botId: turn.bot_id, turnId: turn.id, taskId: turn.task_id, ticketId: turn.ticket_id,
      call: { tool, kind, command: call.command ?? null, paths }, files: paths };
  }

  const said = (verdict: StepVerdict) => verdict.reason ? say(`：${verdict.reason}`, `: ${verdict.reason}`) : "";
  const noteOf = (verdict: StepVerdict) => say(`（应用）你的引擎里「${verdict.step.name}」这一步看了这次调用，没过${said(verdict)}`,
    `(app) The step "${verdict.step.name}" of this conversation's engine looked at this call and it did not pass${said(verdict)}`);

  /** Posts a line to you in a conversation, hidden from Bots, after what it is about. */
  function tellYou(sessionId: string, botId: string, body: string): void {
    try {
      deps.publishMessage(store.insertMessage({ sessionId, kind: "system", author: botId, body, hiddenFromBots: true }));
    } catch {
      // a conversation gone since: nothing to tell it in
    }
  }

  async function settledStep(at: "accepted" | "overturned", submissionId: string): Promise<void> {
    let submission;
    try {
      submission = store.getSubmission(submissionId);
    } catch {
      return;
    }
    const sessionId = store.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(submission.task_id)?.session_id ?? null;
    if (!sessionId) return;
    const files = submission.artifacts.map((artifact) => artifact.path);
    const verdicts = await run(at, { sessionId, botId: submission.bot_id, turnId: null, taskId: submission.task_id, ticketId: submission.ticket_id,
      submissionId: submission.id, files });
    for (const verdict of verdicts) {
      const body = verdict.outcome === "pass"
        ? say(`「${verdict.step.name}」跑过了，没问题。`, `"${verdict.step.name}" ran and passed.`)
        : verdict.outcome === "fail"
          ? say(`「${verdict.step.name}」没过${said(verdict)}`, `"${verdict.step.name}" did not pass${said(verdict)}`)
          : say(`「${verdict.step.name}」没判断成${said(verdict)}`, `"${verdict.step.name}" could not judge${said(verdict)}`);
      tellYou(sessionId, submission.bot_id, body);
    }
  }

  let sweeping = false;

  return {
    run,
    async beforeCall(turn, tool, call, signal) {
      const scene = callScene(turn, tool, call);
      if (!scene) return { refusal: null, notes: [] };
      const verdicts = await run("before_effect", scene, { ...(signal ? { signal } : {}), stopAt: (step) => step.then === "refuse" });
      const refused = verdicts.find((verdict) => verdict.outcome === "fail" && verdict.step.then === "refuse");
      if (refused) {
        return {
          refusal: say(`你的引擎里「${refused.step.name}」这一步拒掉了这次调用${said(refused)}。换一个不碰它的做法，做不了就在回复里说明。`,
            `The step "${refused.step.name}" of this conversation's engine refused this call${said(refused)}. Do it another way that keeps to it, or say in your reply what you could not do.`),
          notes: [],
        };
      }
      return { refusal: null, notes: verdicts.filter((verdict) => verdict.outcome === "fail" && verdict.step.then === "note").map(noteOf) };
    },
    async afterCall(turn, tool, call, result, signal) {
      const scene = callScene(turn, tool, call);
      if (!scene) return [];
      const verdicts = await run("after_effect", { ...scene, result }, signal ? { signal } : {});
      return verdicts.filter((verdict) => verdict.outcome === "fail" && verdict.step.then === "note").map(noteOf);
    },
    async atTurnEnd(turn, input, signal) {
      if (turn.mode === "readonly") return { bounce: null, tell: [] };
      const root = store.workspacePath();
      const files = [...new Set(input.files.map((path) => workspaceRelative(root, path)))];
      const left = store.endBounceLeft(turn.id);
      const verdicts = await run("turn_end", { sessionId: turn.session_id, botId: turn.bot_id, turnId: turn.id, taskId: turn.task_id, ticketId: turn.ticket_id,
        reply: input.reply, files }, { ...(signal ? { signal } : {}), applies: (step) => step.then !== "send_back" || left });
      const back = verdicts.filter((verdict) => verdict.outcome === "fail" && verdict.step.then === "send_back");
      const tell = verdicts.filter((verdict) => verdict.outcome === "fail" && verdict.step.then === "tell")
        .map((verdict) => say(`「${verdict.step.name}」没过${said(verdict)}`, `"${verdict.step.name}" did not pass${said(verdict)}`));
      if (back.length === 0) return { bounce: null, tell };
      if (left && store.bounceForSteps(turn.id, back.map((verdict) => verdict.step.id))) {
        const lines = back.map((verdict) => say(`「${verdict.step.name}」${said(verdict) || "：没过"}`, `"${verdict.step.name}"${said(verdict) || ": did not pass"}`));
        return {
          bounce: say(`（应用）你的引擎里有一步在这一轮收尾前没过，先别收尾，接着改：${lines.join("；")}。改好了再收尾；改不了就说明卡在哪。`,
            `(app) A step of this conversation's engine did not pass as this turn was ending, so it goes on: ${lines.join("; ")}. Fix it, then end; if you cannot, say what blocks you.`),
          tell,
        };
      }
      // None left: the turn ends as it would, and you hear what did not pass.
      return {
        bounce: null,
        tell: [...tell, ...back.map((verdict) => say(`「${verdict.step.name}」还是没过${said(verdict)}。这一段能退回的次数用完了，照常收尾。`,
          `"${verdict.step.name}" still did not pass${said(verdict)}. This segment has no send-backs left, so it ended as it would.`))],
      };
    },
    async onHandedIn(submission) {
      const sessionId = store.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(submission.task_id)?.session_id ?? null;
      if (!sessionId || store.customStepsAt({ sessionId, taskId: submission.task_id }, "handed_in").length === 0) return;
      const scene: StepScene = { sessionId, botId: submission.bot_id, turnId: submission.turn_id, taskId: submission.task_id, ticketId: submission.ticket_id,
        submissionId: submission.id, files: submission.artifacts.map((artifact) => artifact.path) };
      await (deps.exclusive ? deps.exclusive(() => run("handed_in", scene)) : run("handed_in", scene));
    },
    async sweep() {
      if (sweeping) return;
      sweeping = true;
      try {
        const seen = store.customStepsSeen();
        const events = store.db.query<{ seq: number; kind: string; payload: string }, [number]>(`SELECT seq, kind, payload FROM work_events
          WHERE seq > ? AND kind IN ('submission.approved', 'review.recorded') ORDER BY seq LIMIT 50`).all(seen);
        for (const event of events) {
          let payload: { submission_id?: string; outcome?: string; by?: string } = {};
          try {
            payload = JSON.parse(event.payload) as typeof payload;
          } catch {
            // nothing to run it for
          }
          const at = event.kind === "submission.approved" || payload.outcome === "approve" ? "accepted"
            : payload.outcome === "reject" && payload.by === "user" ? "overturned" : null;
          if (at && payload.submission_id) await settledStep(at, payload.submission_id);
          store.markCustomStepsSeen(event.seq);
        }
      } finally {
        sweeping = false;
      }
    },
    async tryStep(step, sample) {
      const used: CustomStepSample = { ...sample };
      if (CUSTOM_STEP_CALL_ATS.includes(step.at)) {
        used.tool ??= step.match?.tools?.[0] ?? (step.match?.paths?.length ? "write_file" : "shell");
        if (used.tool === "shell" && used.command === undefined) {
          used.command = store.db.query<{ command: string }, []>("SELECT command FROM turn_runs WHERE tool = 'shell' ORDER BY rowid DESC LIMIT 1").get()?.command ?? "";
        }
        used.paths ??= [];
      } else if (step.at === "turn_end") {
        used.reply ??= store.db.query<{ body: string }, []>("SELECT body FROM messages WHERE kind = 'bot' AND body <> '' ORDER BY created_at DESC LIMIT 1").get()?.body ?? "";
        used.paths ??= [];
      } else {
        used.paths ??= (() => {
          const row = store.db.query<{ artifacts: string }, []>("SELECT artifacts FROM submissions ORDER BY created_at DESC LIMIT 1").get();
          try {
            return row ? (JSON.parse(row.artifacts) as Array<{ path: string }>).map((artifact) => artifact.path) : [];
          } catch {
            return [];
          }
        })();
      }
      const root = store.workspacePath();
      const paths = (used.paths ?? []).map((path) => workspaceRelative(root, path));
      const kind = used.tool ?? null;
      const scene: StepScene = { sessionId: "", botId: null, turnId: null, files: paths,
        ...(kind ? { call: { tool: kind, kind, command: used.command ?? null, paths } } : {}),
        ...(step.at === "turn_end" ? { reply: used.reply ?? "" } : {}) };
      const judged = stepHit(step, scene) || step.run.kind !== "rule"
        ? await judge(step, scene)
        : { step, outcome: "pass" as const, reason: say("这个样例碰不到这一步看的调用或文件", "the sample does not touch what this step looks at"), exitCode: null, output: null, record: {}, ms: 0 };
      return { outcome: judged.outcome, reason: judged.reason, exit_code: judged.exitCode, output: judged.output, sample: used };
    },
  };
}
