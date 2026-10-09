/**
 * Pure helpers for acceptance checks (验收检查): the plan's own proof that one acceptance line
 * holds, run on this Mac, never on a Bot's say-so. Nothing here touches the DOM or the network —
 * it is the arithmetic and shaping `PlanSpecPanel.svelte`, `AcceptanceCheckRow.svelte` and
 * `AcceptanceCheckForm.svelte` lean on, kept testable on its own the way `plan-board.ts` is.
 */
import type { AcceptanceCheck, AcceptanceCheckInput, CheckMeasure, DerivedCheckState, TaskDetail } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** The kinds a check can be made or edited as here; a `measure` only comes from your words. */
export type EditableCheckKind = AcceptanceCheckInput["kind"];

/**
 * How a check's pill reads: the outcome of its last finished run, or that it is running or has
 * never run — or, for a check from your words, that it is only offered to you (`proposed`: measured
 * all the same, its result shown beside it, never a block), or has found no delivered file yet.
 */
export type CheckBadge = "pass" | "fail" | "running" | "blocked" | "error" | "none" | "unbound" | "proposed";

/** Read from your words (ADR 0040 P3): it changes when you say a new number, not in the editor. */
export function isDerived(check: Pick<AcceptanceCheck, "origin">): boolean {
  return check.origin === "derived";
}

/** A check from your words with no delivered file bound yet: it never runs and holds nothing back. */
export function isUnbound(check: Pick<AcceptanceCheck, "origin" | "bind_kind">): boolean {
  return isDerived(check) && !check.bind_kind;
}

/**
 * Where a check from your words stands: offered, or in force because you confirmed it (ADR 0040
 * P3); null for every other check. A daemon from before offers read as in force.
 */
export function derivedStateOf(check: Pick<AcceptanceCheck, "origin" | "derived_state">): DerivedCheckState | null {
  return isDerived(check) ? (check.derived_state ?? "active") : null;
}

/** A check that counts: every one you or the organizer made, and one from your words only in force and bound. */
export function isGate(check: Pick<AcceptanceCheck, "origin" | "bind_kind" | "derived_state">): boolean {
  return !isDerived(check) || (derivedStateOf(check) === "active" && !isUnbound(check));
}

/** A check in flight outranks its last verdict; absent a last run, it simply has not run yet. */
export function badgeOf(check: AcceptanceCheck): CheckBadge {
  if (check.running) return "running";
  if (derivedStateOf(check) === "proposed") return "proposed";
  if (isUnbound(check)) return "unbound";
  const outcome = check.last_run?.outcome;
  if (outcome === "pass" || outcome === "fail" || outcome === "blocked" || outcome === "error") return outcome;
  return "none";
}

/** The checks filed under one acceptance line, in the order they were created; those from your words are listed apart. */
export function checksForLine(checks: readonly AcceptanceCheck[], line: string): AcceptanceCheck[] {
  return checks.filter((check) => check.item === line && !isDerived(check));
}

/** Held to the approved sample (照样片, ADR 0060): one per ticket, under the sample's standard rather than an acceptance line. */
export function isSample(check: Pick<AcceptanceCheck, "origin">): boolean {
  return check.origin === "sample";
}

/**
 * Checks whose line no longer matches any of the plan's current acceptance lines — still run, still
 * count. Checks from your words and checks held to the sample are listed on their own
 * (`derivedChecks`, `sampleChecks`), whatever their line.
 */
export function orphanChecks(checks: readonly AcceptanceCheck[], acceptanceLines: readonly string[]): AcceptanceCheck[] {
  const lines = new Set(acceptanceLines);
  return checks.filter((check) => !lines.has(check.item) && !isDerived(check) && !isSample(check));
}

/** The checks held to an approved sample, each filed under the ticket it judges. */
export function sampleChecks(checks: readonly AcceptanceCheck[]): AcceptanceCheck[] {
  return checks.filter(isSample);
}

/** Checks that share a line, under it, in the order the lines first appear. */
export function checksByItem(checks: readonly AcceptanceCheck[]): Array<{ item: string; checks: AcceptanceCheck[] }> {
  const groups = new Map<string, AcceptanceCheck[]>();
  for (const check of checks) {
    const group = groups.get(check.item);
    if (group) group.push(check);
    else groups.set(check.item, [check]);
  }
  return [...groups].map(([item, group]) => ({ item, checks: group }));
}

/** What a pill's state asks of you, most first: a failure, then what is still going, then what has not run, then a pass. */
const SEVERITY: Record<CheckBadge, number> = { fail: 0, error: 1, blocked: 2, running: 3, proposed: 4, none: 5, unbound: 6, pass: 7 };

/**
 * The checks in the order they need you: failures first, passes last. Ties keep `tieBreak`'s order
 * (a ticket's number, say), or the order they came in.
 */
export function bySeverity(checks: readonly AcceptanceCheck[], tieBreak?: (check: AcceptanceCheck) => number): AcceptanceCheck[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => SEVERITY[badgeOf(a.check)] - SEVERITY[badgeOf(b.check)] || (tieBreak ? tieBreak(a.check) - tieBreak(b.check) : 0) || a.index - b.index)
    .map(({ check }) => check);
}

/** A run's first reason, for one line: what it said up to its first break (「整段没有声音，样片有声音。」). */
export function firstReason(detail: string | null | undefined): string {
  return (detail ?? "").split(/[；;\n]/u).map((part) => part.trim()).find(Boolean) ?? "";
}

/** The checks that count and last came out failed, blocked or broken: what the plan's head calls out. */
export function failingChecks(checks: readonly AcceptanceCheck[]): AcceptanceCheck[] {
  return checks.filter((check) => {
    if (!isGate(check) || check.running) return false;
    const outcome = check.last_run?.outcome;
    return outcome === "fail" || outcome === "blocked" || outcome === "error";
  });
}

/** The checks the app read from your words, each under the words it took ("时长约 2 分钟"). */
export function derivedChecks(checks: readonly AcceptanceCheck[]): AcceptanceCheck[] {
  return checks.filter(isDerived);
}

/** How many of the plan's checks last passed, out of how many count: an offer or an unbound one does not yet. */
export function checkSummary(checks: readonly AcceptanceCheck[]): { pass: number; total: number } {
  const counted = checks.filter(isGate);
  return { pass: counted.filter((check) => check.last_run?.outcome === "pass").length, total: counted.length };
}

/**
 * An offer's result, as information: 「未确认的检查：107.00 秒，你说的是时长约 2 分钟（待你确认）」.
 * Null until it has been measured to a pass or a fail.
 */
export function unconfirmedResult(check: Pick<AcceptanceCheck, "item" | "last_run">, t: Copy): string | null {
  const outcome = check.last_run?.outcome;
  if (outcome !== "pass" && outcome !== "fail") return null;
  return t.plan.checks.unconfirmed(check.last_run!.detail.replace(/，要.*$|; needs .*$/, ""), check.item);
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** What a measure asks, in the reader's words: 「时长 108–132 秒」, "Short side at least 1080 px". */
export function describeMeasure(measure: CheckMeasure, t: Copy): string {
  const m = t.plan.checks.measure;
  if (measure.dimension === "aspect") {
    if (measure.ratio === "portrait") return m.portrait;
    if (measure.ratio === "landscape") return m.landscape;
    return m.aspect(measure.ratio);
  }
  const { min, max } = measure;
  const range =
    min !== null && max !== null
      ? min === max
        ? formatNumber(min)
        : `${formatNumber(min)}–${formatNumber(max)}`
      : min !== null
        ? m.atLeast(formatNumber(min))
        : m.atMost(formatNumber(max ?? 0));
  return measure.dimension === "duration" ? m.duration(range) : measure.dimension === "resolution" ? m.resolution(range) : m.fps(range);
}

/** A plain-language sentence for what a check proves, in the reader's own words. */
export function describeCheck(
  check: Pick<AcceptanceCheck, "kind" | "path" | "pattern" | "negate" | "command" | "cwd" | "expect_exit" | "measure">,
  t: Copy,
): string {
  const c = t.plan.checks;
  if (check.kind === "measure") return c.describeMeasure(check.measure ? describeMeasure(check.measure, t) : "", check.path);
  if (check.kind === "exists") return c.describeExists(check.path ?? "");
  if (check.kind === "contains") return c.describeContains(check.path ?? "", check.pattern ?? "", check.negate);
  if (check.kind === "matches") return c.describeMatches(check.path ?? "", check.pattern ?? "", check.negate);
  if (check.kind === "continuity") return c.describeContinuity(check.path ?? "", check.command ?? "", check.cwd);
  return c.describeCommand(check.command ?? "", check.cwd, check.expect_exit ?? 0);
}

/** The form's editable state: strings throughout, so every input can bind directly without parsing on each keystroke. */
export type CheckDraft = {
  item: string;
  kind: EditableCheckKind;
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

/** A draft prefilled from an existing check, for the "改" (edit) action; never offered on a `measure`. */
export function draftFromCheck(check: AcceptanceCheck): CheckDraft {
  return {
    item: check.item,
    kind: check.kind === "measure" ? "exists" : check.kind,
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
