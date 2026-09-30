import type { ChatMessage, CompletionResult } from "./completions";
import type { ChatTool } from "./prompts/tool-schema";

/**
 * Protocol-compliance probe: the gate ADR 0040 sets for entering P4b (see its phase table note).
 * P4b/P4c introduce three verbs a hop may offer — `end_turn` (nothing more to say this turn),
 * `submit` (a finished deliverable, ready for review) and `work_on` (still going, call again) — and
 * a weak model is known to sometimes say it will call one and then just… not (grk-4.7-build-fast is
 * the case on record). This measures how often that happens on a fixed, offline case bank, and how
 * much a nudge-and-retry costs when it does. The pure parts (case validation, tool schemas,
 * scoring, the report) live here so they are unit-tested without a network;
 * `scripts/protocol-probe.ts` drives a real endpoint (or a scripted client under `--dry-run`)
 * through them.
 *
 * These three verbs do not exist in the engine yet (P4b/P4c land them); this probe defines its own
 * minimal versions to measure the raw model behavior a contract like this would meet, ahead of
 * building it — the same reasoning that gave P0 the model-selection numbers before P5 reads them.
 */

export const PROTOCOL_TOOLS = ["end_turn", "submit", "work_on"] as const;
export type ProtocolTool = (typeof PROTOCOL_TOOLS)[number];

function isProtocolTool(value: unknown): value is ProtocolTool {
  return typeof value === "string" && (PROTOCOL_TOOLS as readonly string[]).includes(value);
}

const TOOL_SCHEMA: Record<ProtocolTool, ChatTool> = {
  end_turn: {
    type: "function",
    function: { name: "end_turn", description: "Nothing more to do this turn; stop without submitting anything.", parameters: { type: "object", properties: {} } },
  },
  submit: {
    type: "function",
    function: {
      name: "submit",
      description: "Hand over a finished deliverable for review.",
      parameters: { type: "object", properties: { summary: { type: "string", description: "One line saying what is ready." } }, required: ["summary"] },
    },
  },
  work_on: {
    type: "function",
    function: {
      name: "work_on",
      description: "Still going; call this and keep working, you will be asked again.",
      parameters: { type: "object", properties: { next_step: { type: "string", description: "What you will do next." } }, required: ["next_step"] },
    },
  },
};

export type ProtocolCase = {
  id: string;
  /** What this hop is meant to be doing, read as the turn's situation (no engine involved: a plain user message). */
  situation: string;
  /** The subset of PROTOCOL_TOOLS offered this hop — a real hop would not always offer all three (e.g. no `submit` with nothing to hand over). */
  offered: ProtocolTool[];
  expect: ProtocolTool;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and checks a case bank; every `offered`/`expect` name must be one of `PROTOCOL_TOOLS`, and `expect` must be offered. */
export function validateCases(raw: unknown, source = "cases"): ProtocolCase[] {
  const problems: string[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.cases)) throw new Error(`${source}: expected { cases: [...] }`);
  const seen = new Set<string>();
  const out: ProtocolCase[] = [];
  raw.cases.forEach((item, index) => {
    const where = `cases[${index}]`;
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim().length === 0) {
      problems.push(`${where}: id is required`);
      return;
    }
    if (seen.has(item.id)) {
      problems.push(`${where}: duplicate id ${item.id}`);
      return;
    }
    seen.add(item.id);
    if (typeof item.situation !== "string" || item.situation.trim().length === 0) {
      problems.push(`${where}.situation: required`);
      return;
    }
    if (!Array.isArray(item.offered) || item.offered.length === 0 || !item.offered.every(isProtocolTool)) {
      problems.push(`${where}.offered: must be a non-empty array of ${PROTOCOL_TOOLS.join("/")}`);
      return;
    }
    if (!isProtocolTool(item.expect)) {
      problems.push(`${where}.expect: must be one of ${PROTOCOL_TOOLS.join("/")}`);
      return;
    }
    if (!item.offered.includes(item.expect)) {
      problems.push(`${where}: expect (${item.expect}) must be one of offered`);
      return;
    }
    out.push({ id: item.id, situation: item.situation, offered: [...new Set(item.offered as ProtocolTool[])], expect: item.expect });
  });
  if (problems.length > 0) throw new Error(`${source}: invalid cases\n- ${problems.join("\n- ")}`);
  return out;
}

const SYSTEM = "You are partway through a piece of work with a teammate. Each turn, call exactly one of the tools offered — never answer in plain text, never call more than one.";

export function buildProbeTurn(c: ProtocolCase): { messages: ChatMessage[]; tools: ChatTool[] } {
  return { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: c.situation }], tools: c.offered.map((name) => TOOL_SCHEMA[name]) };
}

/**
 * Worded by what actually happened, not always "you did not call a tool" — that line is false when
 * the model called something, just not the one tool this situation wanted, and false again when
 * the last attempt failed in transport and never got a chance to call anything.
 */
export function nudge(offered: readonly ProtocolTool[], reason: AttemptFailKind = "no_call"): string {
  const ask = `Call exactly one of: ${offered.join(", ")}.`;
  if (reason === "wrong_call") return `That call did not land: not one of the tools offered, more than one at once, or not the one this situation calls for. ${ask}`;
  if (reason === "transport") return `The last attempt failed before it could answer — nothing you said or didn't say. ${ask}`;
  return `You did not call a tool. ${ask}`;
}

/**
 * Why an attempt was not compliant, when it wasn't: `transport` is a failed completion (5xx,
 * timeout, truncation) — the endpoint never really answered, which is not the model choosing to
 * ignore the contract; `no_call` said something and called nothing; `wrong_call` called something,
 * just not the one tool `expect` names (an unoffered name, more than one call, or a lone call to a
 * different offered tool). Null means this attempt complied — `readAttempt` checks against `expect`
 * itself, so a caller never has to.
 */
export type AttemptFailKind = "transport" | "no_call" | "wrong_call";

/** What one attempt (an initial hop or a retry after a nudge) came back with. */
export type AttemptResult = { toolCalled: ProtocolTool | null; unrecognizedCall: boolean; usage: CompletionResult["usage"]; failKind: AttemptFailKind | null };

/**
 * `result.ok` and exactly one recognized tool call, and that call is `expect` — anything else (a
 * failed completion, no call, more than one call, an unoffered name, or a lone call to an offered
 * tool that just isn't the one this situation wanted) is "not compliant". `failKind` names why, so a
 * caller never has to re-derive it: null exactly when this attempt complied.
 */
export function readAttempt(result: CompletionResult, offered: readonly ProtocolTool[], expect: ProtocolTool): AttemptResult {
  if (!result.ok) return { toolCalled: null, unrecognizedCall: false, usage: result.usage, failKind: "transport" };
  const offeredSet = new Set(offered);
  const recognized = result.toolCalls.filter((call) => offeredSet.has(call.name as ProtocolTool));
  const unrecognized = result.toolCalls.some((call) => !offeredSet.has(call.name as ProtocolTool));
  const toolCalled = recognized.length === 1 && result.toolCalls.length === 1 ? (recognized[0]!.name as ProtocolTool) : null;
  const failKind: AttemptFailKind | null = toolCalled === expect ? null : result.toolCalls.length === 0 ? "no_call" : "wrong_call";
  return { toolCalled, unrecognizedCall: unrecognized, usage: result.usage, failKind };
}

export type ProtocolCaseResult = {
  case_id: string;
  expect: ProtocolTool;
  offered: ProtocolTool[];
  attempts: AttemptResult[];
  /** The tool the case ended on, once compliant, or null if it never became compliant within the retry budget. */
  final_tool: ProtocolTool | null;
  /** Compliant on the very first attempt: no nudge needed. */
  compliant_first_try: boolean;
  /** Retries ran out and it still never complied — the retry budget failed to recover this case, not just that one nudge was needed. Reported for visibility (`needs_attention` below); not what the bounce rate counts. */
  never_compliant: boolean;
  /** How many of this case's attempts failed in transport (5xx, timeout) rather than the model choosing not to comply. */
  transport_failures: number;
  /** Tokens spent on retries beyond the first attempt (0 when compliant first try). */
  extra_input_tokens: number;
  extra_output_tokens: number;
};

/** Scores a case from its recorded attempts (pure); `run.ts`/`scripts/protocol-probe.ts` collects the attempts, retrying up to `maxRetries` times past the first when an attempt is not compliant. */
export function scoreCase(c: ProtocolCase, attempts: readonly AttemptResult[]): ProtocolCaseResult {
  const compliantIndex = attempts.findIndex((attempt) => attempt.toolCalled === c.expect);
  const finalTool = compliantIndex >= 0 ? c.expect : null;
  const extra = attempts.slice(1);
  return {
    case_id: c.id,
    expect: c.expect,
    offered: c.offered,
    attempts: [...attempts],
    final_tool: finalTool,
    compliant_first_try: attempts[0]?.toolCalled === c.expect,
    never_compliant: finalTool === null,
    transport_failures: attempts.filter((attempt) => attempt.failKind === "transport").length,
    extra_input_tokens: extra.reduce((sum, attempt) => sum + (attempt.usage?.input_tokens ?? 0), 0),
    extra_output_tokens: extra.reduce((sum, attempt) => sum + (attempt.usage?.output_tokens ?? 0), 0),
  };
}

export type ProtocolSummary = {
  total: number;
  compliant_first_try: number;
  /** Compliant at all, first try or after a nudge. */
  compliant: number;
  /**
   * Share of cases that broke the contract at least once — did not call the expected tool on the
   * first attempt, whether or not a later retry recovered it: `1 - compliant_first_try / total`.
   * This is what the P4b gate reads: a case that needed a nudge on every hop and then complied still
   * counts against it, the same as one that never complied at all — only `needs_attention` below
   * tells those two apart.
   */
  bounce_rate: number;
  /** Cases that never became compliant within the retry budget — the budget itself ran out, a
   *  different (rarer, worse) thing than needing one nudge. Reported for visibility; not gated. */
  needs_attention: number;
  needs_attention_rate: number;
  /** Attempts that failed in transport rather than from the model's own non-compliance — folded
   *  into `bounce_rate` today (a transport failure still is not a compliant attempt), surfaced here
   *  so a reader can tell an endpoint outage from real non-compliance. */
  transport_failures: number;
  extra_input_tokens: number;
  extra_output_tokens: number;
};

export function summarize(rows: readonly ProtocolCaseResult[]): ProtocolSummary {
  const total = rows.length;
  const compliantFirstTry = rows.filter((row) => row.compliant_first_try).length;
  const neverCompliant = rows.filter((row) => row.never_compliant).length;
  return {
    total,
    compliant_first_try: compliantFirstTry,
    compliant: total - neverCompliant,
    bounce_rate: total ? (total - compliantFirstTry) / total : 0,
    needs_attention: neverCompliant,
    needs_attention_rate: total ? neverCompliant / total : 0,
    transport_failures: rows.reduce((sum, row) => sum + row.transport_failures, 0),
    extra_input_tokens: rows.reduce((sum, row) => sum + row.extra_input_tokens, 0),
    extra_output_tokens: rows.reduce((sum, row) => sum + row.extra_output_tokens, 0),
  };
}

/** The gate ADR 0040 sets for entering P4b: bounce rate below 10%. */
export const BOUNCE_GATE = 0.1;

export function formatReport(model: string, summary: ProtocolSummary, rows: readonly ProtocolCaseResult[]): string {
  const lines = [
    `# protocol-probe — ${model}`,
    "",
    `bounce rate: ${(summary.bounce_rate * 100).toFixed(1)}% (gate for P4b: < ${(BOUNCE_GATE * 100).toFixed(0)}%) — ${summary.bounce_rate < BOUNCE_GATE ? "PASS" : "FAIL"}`,
    `compliant first try: ${summary.compliant_first_try} / ${summary.total}; compliant after a nudge: ${summary.compliant - summary.compliant_first_try}; never compliant (retry budget exhausted): ${summary.needs_attention} (${(summary.needs_attention_rate * 100).toFixed(1)}%)`,
    `extra spend on retries: ${summary.extra_input_tokens} in / ${summary.extra_output_tokens} out tokens${summary.transport_failures ? `; ${summary.transport_failures} attempt(s) failed in transport, not model non-compliance` : ""}`,
    "",
    "| case | expect | offered | attempts | result |",
    "|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const result = row.never_compliant ? "NEVER COMPLIANT" : row.compliant_first_try ? "ok (1st)" : `ok (${row.attempts.length})`;
    lines.push(`| ${row.case_id} | ${row.expect} | ${row.offered.join("/")} | ${row.attempts.map((a) => a.toolCalled ?? "—").join(" → ")} | ${result} |`);
  }
  return lines.join("\n");
}
