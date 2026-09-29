/**
 * Pure helpers for acceptance checks (验收检查): the plan's own proof that one acceptance line
 * holds, run on this Mac, never on a Bot's say-so. Nothing here touches the DOM or the network —
 * it is the arithmetic and shaping `PlanSpecPanel.svelte`, `AcceptanceCheckRow.svelte` and
 * `AcceptanceCheckForm.svelte` lean on, kept testable on its own the way `plan-board.ts` is.
 */
import type { AcceptanceCheck, AcceptanceCheckKind, AcceptanceCheckInput, TaskDetail } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** How a check's pill reads: the outcome of its last finished run, or that it is running or has never run. */
export type CheckBadge = "pass" | "fail" | "running" | "blocked" | "error" | "none";

/** A check in flight outranks its last verdict; absent a last run, it simply has not run yet. */
export function badgeOf(check: AcceptanceCheck): CheckBadge {
  if (check.running) return "running";
  const outcome = check.last_run?.outcome;
  if (outcome === "pass" || outcome === "fail" || outcome === "blocked" || outcome === "error") return outcome;
  return "none";
}

/** The checks filed under one acceptance line, in the order they were created. */
export function checksForLine(checks: readonly AcceptanceCheck[], line: string): AcceptanceCheck[] {
  return checks.filter((check) => check.item === line);
}

/** Checks whose line no longer matches any of the plan's current acceptance lines — still run, still count. */
export function orphanChecks(checks: readonly AcceptanceCheck[], acceptanceLines: readonly string[]): AcceptanceCheck[] {
  const lines = new Set(acceptanceLines);
  return checks.filter((check) => !lines.has(check.item));
}

/** How many of the plan's active checks last passed, out of how many there are. */
export function checkSummary(checks: readonly AcceptanceCheck[]): { pass: number; total: number } {
  return { pass: checks.filter((check) => check.last_run?.outcome === "pass").length, total: checks.length };
}

/** A plain-language sentence for what a check proves, in the reader's own words. */
export function describeCheck(check: Pick<AcceptanceCheck, "kind" | "path" | "pattern" | "negate" | "command" | "cwd" | "expect_exit">, t: Copy): string {
  const c = t.plan.checks;
  if (check.kind === "exists") return c.describeExists(check.path ?? "");
  if (check.kind === "contains") return c.describeContains(check.path ?? "", check.pattern ?? "", check.negate);
  if (check.kind === "matches") return c.describeMatches(check.path ?? "", check.pattern ?? "", check.negate);
  if (check.kind === "continuity") return c.describeContinuity(check.path ?? "", check.command ?? "", check.cwd);
  return c.describeCommand(check.command ?? "", check.cwd, check.expect_exit ?? 0);
}

/** The form's editable state: strings throughout, so every input can bind directly without parsing on each keystroke. */
export type CheckDraft = {
  item: string;
  kind: AcceptanceCheckKind;
  path: string;
  pattern: string;
  negate: boolean;
  command: string;
  cwd: string;
  expectExit: string;
  expectStdout: string;
  timeoutSec: string;
};

/** A fresh draft for a new check: the item preselected, `exists` first among the four kinds. */
export function emptyDraft(detail: TaskDetail, item: string): CheckDraft {
  return {
    item: item || detail.spec?.acceptance[0] || "",
    kind: "exists",
    path: "",
    pattern: "",
    negate: false,
    command: "",
    cwd: "",
    expectExit: "0",
    expectStdout: "",
    timeoutSec: "",
  };
}

/** A draft prefilled from an existing check, for the "改" (edit) action. */
export function draftFromCheck(check: AcceptanceCheck): CheckDraft {
  return {
    item: check.item,
    kind: check.kind,
    path: check.path ?? "",
    pattern: check.pattern ?? "",
    negate: check.negate,
    command: check.command ?? "",
    cwd: check.cwd ?? "",
    expectExit: check.expect_exit === null ? "" : String(check.expect_exit),
    expectStdout: check.expect_stdout ?? "",
    timeoutSec: check.timeout_sec === null ? "" : String(check.timeout_sec),
  };
}

/** Which fields a draft is missing or has wrong, by name — the form maps each to its own copy line. */
export type CheckDraftErrors = {
  item?: true;
  path?: true;
  pattern?: true;
  command?: true;
  expectExit?: true;
  timeoutSec?: true;
  /** `continuity` only: neither a video path nor a command was given. */
  pathOrCommand?: true;
};

function parseOptionalInt(text: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^-?\d+$/.test(trimmed)) return { ok: false };
  return { ok: true, value: Number(trimmed) };
}

/**
 * Client-side sanity only — the server is the authority and re-validates everything, including
 * that a path or command stays inside the workspace. Returns the fields to send when the draft is
 * usable, or which fields to flag when it is not.
 */
export function draftToInput(draft: CheckDraft): { errors: CheckDraftErrors; input: AcceptanceCheckInput | null } {
  const errors: CheckDraftErrors = {};
  const item = draft.item.trim();
  if (!item) errors.item = true;

  const path = draft.path.trim();
  const pattern = draft.pattern.trim();
  const command = draft.command.trim();
  const needsPath = draft.kind === "exists" || draft.kind === "contains" || draft.kind === "matches";
  const needsPattern = draft.kind === "contains" || draft.kind === "matches";
  if (needsPath && !path) errors.path = true;
  if (needsPattern && !pattern) errors.pattern = true;
  if (draft.kind === "command" && !command) errors.command = true;
  if (draft.kind === "continuity" && !path && !command) errors.pathOrCommand = true;

  let expectExit: number | null = null;
  if (draft.kind === "command") {
    const parsed = parseOptionalInt(draft.expectExit);
    if (!parsed.ok) errors.expectExit = true;
    else expectExit = parsed.value;
  }

  let timeoutSec: number | null = null;
  const timeoutParsed = parseOptionalInt(draft.timeoutSec);
  if (!timeoutParsed.ok || (timeoutParsed.value !== null && (timeoutParsed.value < 1 || timeoutParsed.value > 600))) {
    errors.timeoutSec = true;
  } else {
    timeoutSec = timeoutParsed.value;
  }

  if (Object.keys(errors).length > 0) return { errors, input: null };

  const input: AcceptanceCheckInput = {
    item,
    kind: draft.kind,
    path: needsPath ? path : draft.kind === "continuity" ? path || null : null,
    pattern: needsPattern ? pattern : null,
    negate: needsPattern ? draft.negate : false,
    command: draft.kind === "command" || draft.kind === "continuity" ? command || null : null,
    cwd: (draft.kind === "command" || draft.kind === "continuity") && draft.cwd.trim() ? draft.cwd.trim() : null,
    expect_exit: draft.kind === "command" ? expectExit : null,
    expect_stdout: draft.kind === "command" && draft.expectStdout.trim() ? draft.expectStdout.trim() : null,
    timeout_sec: timeoutSec,
  };
  return { errors: {}, input };
}
