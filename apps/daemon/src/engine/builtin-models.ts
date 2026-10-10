/**
 * The built-in calls' models (ADR 0077). Each call the app makes on its own — reading a line, the
 * organizer, the scribe, the picture checks, the composer's suggestions, and the four made as a Bot
 * (its judgement, reflection, retrospective and compaction summary) — runs on the model chosen for
 * it under Settings › Models › Built-in models when there is one, else as it did before: on the
 * default model, or for a Bot's call on the Bot's own. A chosen model is an endpoint's, or a Claude
 * model run through your own Claude Code (ADR 0061), and thinks as much as its call wants: as little
 * as it can where a line waits on it (reading, the composer, a judgement), a little for the scribe
 * and compaction, which run often, and `high` for the organizer, the judges, reflection and the
 * retrospective. A call that sends pictures runs on an endpoint's model only when its catalog says
 * it takes them; every Claude model does, and gets them as image blocks.
 */
import { AGENT_KINDS, isReaderAgentModel, type BuiltinModelRole, type ClaudeEffort, type Spend, type SpendKind, type SpendPurpose, type ThinkingLevel } from "@real-bot/protocol";
import type { ClaudeJudge, ClaudePromptBlock, ClaudeReadingUsage, LocalAgentTarget } from "../claude-code/reading";
import type { ChatMessage, CompletionsClient, JudgeRequest, JudgeResult, MappedUsage } from "../completions";
import type { Store } from "../store";
import type { SpendTracker } from "./spend";
import type { Creds, EndpointTarget, SpendOwner } from "./types";

/** Where a built-in call runs: an endpoint's model, or a model of one of your local agents (ADR 0061, ADR 0079). */
export type BuiltinTarget = EndpointTarget | LocalAgentTarget;

/** A local agent's target, Claude Code's or another's: not an endpoint. */
export function isClaudeTarget(target: BuiltinTarget): target is LocalAgentTarget {
  return "kind" in target && (target.kind === "claude_code" || target.kind === "agent");
}

/** How hard a call's chosen model thinks. */
type Effort = "least" | "little" | "high";

const EFFORT: Record<BuiltinModelRole, Effort> = {
  reader: "least",
  composer: "least",
  judgement: "least",
  scribe: "little",
  compaction: "little",
  organizer: "high",
  judge: "high",
  reflection: "high",
  retrospective: "high",
};

/** Claude Code's effort for each; the least leaves it to Claude Code, as a reading always has. */
const CLAUDE_EFFORT: Record<Effort, ClaudeEffort | null> = { least: null, little: "low", high: "high" };

function thinkingLevelFor(store: Store, effort: Effort, model: string, providerId: string): ThinkingLevel | null {
  if (effort === "least") return store.lightestThinkingLevelFor(model, providerId);
  if (effort === "little") return store.scribeThinkingLevelFor(model, providerId);
  return store.strongThinkingLevelFor(model, providerId);
}

export type BuiltinTargetDeps = {
  store: Store;
  credentials: () => Promise<Creds | null>;
};

/** `pictures`: the call is about to send frames, which needs a model that sees them. */
export type BuiltinTargetOf = (role: BuiltinModelRole, opts?: { pictures?: boolean }) => Promise<BuiltinTarget | null>;

/**
 * The model chosen for a call, ready to run; null when none is chosen or the chosen one cannot run
 * this call (its endpoint is gone or has no key, or pictures on a model not marked as seeing them),
 * which leaves the call on its own default.
 */
export function createBuiltinTargets(deps: BuiltinTargetDeps): BuiltinTargetOf {
  const { store } = deps;
  return async (role, opts = {}) => {
    const chosen = store.settingsCached().builtin_models?.[role] ?? null;
    if (!chosen) return null;
    const effort = EFFORT[role];
    if (isReaderAgentModel(chosen)) {
      const claudeEffort = CLAUDE_EFFORT[effort];
      if (chosen.runner !== "claude_code") {
        // The same three levels on another agent, where it takes them by these names.
        const asked = claudeEffort && AGENT_KINDS[chosen.runner].efforts.includes(claudeEffort) ? claudeEffort : null;
        const custom = chosen.runner === "custom" ? store.customAgent(chosen.custom_id ?? null) : null;
        return { kind: "agent", runner: chosen.runner, customId: chosen.custom_id ?? null, label: custom?.name ?? AGENT_KINDS[chosen.runner].label,
          model: chosen.model, configDir: chosen.config_dir, ...(asked ? { effort: asked } : {}) };
      }
      return { kind: "claude_code", model: chosen.model, configDir: chosen.config_dir, ...(claudeEffort ? { effort: claudeEffort } : {}) };
    }
    const creds = await deps.credentials().catch(() => null);
    const provider = creds?.providers.find((row) => row.id === chosen.provider_id);
    if (!provider) return null;
    // Only a model marked as taking pictures is sent them; unmarked is not known, and stays on the default.
    if (opts.pictures && store.catalogEntries().find((entry) => entry.providerId === provider.id && entry.name === chosen.model)?.input_image !== true) {
      return null;
    }
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat,
      workspaceId: provider.workspaceId,
      providerId: provider.id,
      providerName: provider.name,
      model: chosen.model,
      thinkingLevel: thinkingLevelFor(store, effort, chosen.model, provider.id),
    };
  };
}

/** A built-in call as its caller asks it, with no endpoint or model: those come from the target. */
export type SideRequest = Omit<JudgeRequest, "baseUrl" | "apiKey" | "apiFormat" | "workspaceId" | "model" | "thinkingLevel">;

/** A call's answer, read as an endpoint's is; a Claude model's carries what it cost, as Claude Code reports it. */
export type SideAnswer = JudgeResult & { claudeUsage?: ClaudeReadingUsage | null };

export type SideCallDeps = {
  completions: CompletionsClient;
  /** Absent: a Claude target fails as Claude Code not being there. */
  claudeJudge?: ClaudeJudge | null;
};

/**
 * How long a Claude call may take on top of the caller's own limit, which for an endpoint bounds
 * the first byte only; Claude Code answers all at once, so its whole call gets that room as well.
 */
const CLAUDE_ANSWER_ROOM_MS = 180_000;
const CLAUDE_DEFAULT_LIMIT_MS = 120_000;

const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The system messages as one system prompt, and the rest as text, or as blocks when there are pictures. */
export function claudePromptOf(messages: readonly ChatMessage[]): { system: string; prompt: string | ClaudePromptBlock[] } {
  const system: string[] = [];
  const blocks: ClaudePromptBlock[] = [];
  for (const message of messages) {
    const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content ?? [];
    if (message.role === "system") {
      system.push(parts.map((part) => (part.type === "text" ? part.text : "")).join(""));
      continue;
    }
    for (const part of parts) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
        continue;
      }
      const data = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url);
      if (data && PICTURE_TYPES.has(data[1]!)) {
        blocks.push({ type: "image", source: { type: "base64", media_type: data[1] as "image/png", data: data[2]! } });
      } else {
        blocks.push({ type: "text", text: `[picture: ${part.image_url.url.slice(0, 200)}]` });
      }
    }
  }
  const pictures = blocks.some((block) => block.type === "image");
  return {
    system: system.join("\n\n"),
    prompt: pictures ? blocks : blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
  };
}

/** One built-in call on its target: an endpoint's model through `completions`, a Claude model through Claude Code. */
export async function sideJudge(deps: SideCallDeps, target: BuiltinTarget, request: SideRequest): Promise<SideAnswer> {
  if (!isClaudeTarget(target)) {
    return deps.completions.judge({
      ...request,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      apiFormat: target.apiFormat,
      workspaceId: target.workspaceId,
      model: target.model,
      ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
    });
  }
  const none = (failKind: JudgeResult["failKind"], claudeUsage: ClaudeReadingUsage | null = null): SideAnswer =>
    ({ content: null, toolCalls: [], hadToolCalls: false, usage: null, failKind, claudeUsage });
  if (!deps.claudeJudge) return none("agent_missing");
  const { system, prompt } = claudePromptOf(request.messages);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) controller.abort();
  let overtime = false;
  const timer = setTimeout(() => {
    overtime = true;
    controller.abort();
  }, (request.timeoutMs ?? CLAUDE_DEFAULT_LIMIT_MS) + CLAUDE_ANSWER_ROOM_MS);
  try {
    const answer = await deps.claudeJudge({ target, system, prompt, signal: controller.signal });
    if (answer.fail === null && answer.content !== null) {
      return { content: answer.content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null, claudeUsage: answer.usage };
    }
    // Not installed or not signed in; else it errored, said nothing, or ran out of time.
    return none(answer.fail === "claude_unavailable" ? "agent_missing" : overtime ? "overtime" : "agent_exited", answer.usage);
  } catch {
    return none(overtime ? "overtime" : "agent_exited");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}

/** What an answer bills: its usage, whether the model answered, and a Claude model's own account of it. */
export type Spent = { usage: MappedUsage | null; responded: boolean; claudeUsage?: ClaudeReadingUsage | null };

export function spentOf(answer: SideAnswer): Spent {
  return { usage: answer.usage, responded: answer.failKind === null || answer.failKind === "incomplete", claudeUsage: answer.claudeUsage ?? null };
}

/** Bills a built-in call: an endpoint's as a response, a Claude model's at Claude Code's estimate (ADR 0061). */
export function recordSideSpend(
  spend: Pick<SpendTracker, "callOf" | "recordResponseSpend" | "recordClaudeSpend">,
  input: Spent & {
    kind: SpendKind;
    purpose?: SpendPurpose | null;
    owner: SpendOwner;
    turnId?: string | null;
    judgementId?: string | null;
    target: BuiltinTarget;
  },
): Spend | null {
  const { kind, purpose = null, owner, turnId = null, judgementId = null, target } = input;
  if (isClaudeTarget(target)) {
    return input.claudeUsage ? spend.recordClaudeSpend({ kind, purpose, owner, turnId, judgementId, model: target.model, usage: input.claudeUsage,
      ...(target.kind === "agent" ? { providerName: target.label } : {}) }) : null;
  }
  return spend.recordResponseSpend({ kind, purpose, owner, turnId, judgementId, target: spend.callOf(target), usage: input.usage, responded: input.responded });
}
