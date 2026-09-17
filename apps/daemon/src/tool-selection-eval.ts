import type { Locale } from "@real-bot/protocol";
import type { ChatMessage, CompletionResult, ToolCall } from "./completions";
import { TRIGGER_FLAG } from "./context";
import { mapMcpTools, mappedMcpChatTools, type MappedMcpTool } from "./mcp-names";
import {
  builtinTools,
  COLLAB_TOOL_NAMES,
  turnSystemPrompt,
  type ChatTool,
  type McpPromptGuide,
  type SkillPromptEntry,
} from "./prompts";

/**
 * Tool-selection evaluation: does a Bot, given the same system prompt a real turn gets (skill
 * catalog + MCP block) and one trigger line, read the right skill or pick the right tool first?
 *
 * The pure parts live here so they can be unit-tested; `scripts/tool-selection-eval.ts` drives
 * real endpoints. Nothing in this module talks to the network or the store.
 */

export const EVAL_CATEGORIES = ["skill", "mcp", "usage_note", "builtin", "reply"] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** Expectation token meaning "answered in chat": no tool call, or send_message / ask_user first. */
export const REPLY = "reply";
const REPLY_TOOLS = new Set(["send_message", "ask_user"]);
const READ_SKILL_PREFIX = "read_skill:";
const LOCALES: ReadonlySet<string> = new Set(["zh", "en"]);

export type EvalMcpTool = { name: string; description: string; inputSchema?: Record<string, unknown> };
export type EvalMcpServer = {
  name: string;
  instructions: string | null;
  usage_note: string | null;
  tools: EvalMcpTool[];
};
export type EvalSkill = { name: string; description: string; uses: string[] };
export type EvalProfile = { name: string; duties: string; boundaries: string };
export type EvalExpect = {
  /** Accepted first tool calls: `reply`, `read_skill:<skill name>`, or a tool name. Any match passes. */
  first: string[];
  /** Labels no call in the completion may match. A trailing `*` is a prefix match (`mcp_github_*`). */
  forbid: string[];
};
export type EvalCase = {
  id: string;
  category: EvalCategory;
  locale: Locale;
  profile: EvalProfile;
  skills: EvalSkill[];
  mcp: EvalMcpServer[];
  trigger: string;
  expect: EvalExpect;
  note?: string;
};

export type EvalTurn = {
  messages: ChatMessage[];
  tools: ChatTool[];
  toolNames: Set<string>;
  mapped: MappedMcpTool[];
};

export type EvalOutcome = {
  pass: boolean;
  /** Label of the first call (`read_skill:<name>`, a tool name, or `reply`), or `fail:<kind>`. */
  got: string;
  /** Labels of every call the completion made, in order. */
  calls: string[];
  /** Call names that were not in the tools array (the model invented them). */
  unknownTools: string[];
  reason: string | null;
};

export type EvalRow = {
  model: string;
  caseId: string;
  category: EvalCategory;
  locale: Locale;
  attempt: number;
  ms: number;
  outcome: EvalOutcome;
};

export type EvalTally = { passed: number; total: number };
export type EvalModelSummary = {
  model: string;
  overall: EvalTally;
  byCategory: Partial<Record<EvalCategory, EvalTally>>;
  byLocale: Partial<Record<Locale, EvalTally>>;
};

const DEFAULT_PROFILE: Record<Locale, EvalProfile> = {
  zh: { name: "助手", duties: "按用户要求完成日常工作。", boundaries: "只做被要求的事；拿不准就问。" },
  en: {
    name: "Assistant",
    duties: "Do the everyday work the user asks for.",
    boundaries: "Do only what is asked; ask when unsure.",
  },
};

type Library<T> = Record<string, T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse and check a cases file. Accepts a bare array of cases or
 * `{ servers?: {...}, skills?: {...}, cases: [...] }` where cases may reference the two libraries
 * by key. Every expectation must resolve against that case's own skills and tools, so a typo in
 * an expected name fails here instead of silently failing every model.
 */
export function validateCases(raw: unknown, source = "cases"): EvalCase[] {
  const problems: string[] = [];
  const root: Record<string, unknown> = isRecord(raw) && Array.isArray(raw.cases) ? raw : { cases: raw };
  if (!Array.isArray(root.cases)) {
    throw new Error(`${source}: expected an array of cases or { cases: [...] }`);
  }
  const serverLib = readServerLibrary(root.servers, problems);
  const skillLib = readSkillLibrary(root.skills, problems);
  const seen = new Set<string>();
  const out: EvalCase[] = [];
  root.cases.forEach((item, index) => {
    const parsed = readCase(item, index, serverLib, skillLib, problems);
    if (!parsed) return;
    if (seen.has(parsed.id)) problems.push(`${parsed.id}: duplicate id`);
    seen.add(parsed.id);
    out.push(parsed);
  });
  if (problems.length > 0) {
    throw new Error(`${source}: invalid cases\n- ${problems.join("\n- ")}`);
  }
  return out;
}

function readServerLibrary(raw: unknown, problems: string[]): Library<EvalMcpServer> {
  const lib: Library<EvalMcpServer> = {};
  if (raw === undefined) return lib;
  if (!isRecord(raw)) {
    problems.push("servers: expected an object keyed by server name");
    return lib;
  }
  for (const [key, value] of Object.entries(raw)) {
    const server = readServer(value, key, `servers.${key}`, problems);
    if (server) lib[key] = server;
  }
  return lib;
}

function readSkillLibrary(raw: unknown, problems: string[]): Library<EvalSkill> {
  const lib: Library<EvalSkill> = {};
  if (raw === undefined) return lib;
  if (!isRecord(raw)) {
    problems.push("skills: expected an object keyed by skill name");
    return lib;
  }
  for (const [key, value] of Object.entries(raw)) {
    const skill = readSkill(value, key, `skills.${key}`, problems);
    if (skill) lib[key] = skill;
  }
  return lib;
}

function readServer(
  value: unknown,
  defaultName: string | null,
  label: string,
  problems: string[],
): EvalMcpServer | null {
  if (!isRecord(value)) {
    problems.push(`${label}: expected a server object`);
    return null;
  }
  const name = typeof value.name === "string" ? value.name : defaultName;
  if (!nonEmptyString(name)) {
    problems.push(`${label}: server name is required`);
    return null;
  }
  if (!Array.isArray(value.tools) || value.tools.length === 0) {
    problems.push(`${label}: tools must be a non-empty array`);
    return null;
  }
  const tools: EvalMcpTool[] = [];
  for (const [i, tool] of value.tools.entries()) {
    if (!isRecord(tool) || !nonEmptyString(tool.name)) {
      problems.push(`${label}.tools[${i}]: tool name is required`);
      continue;
    }
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
    });
  }
  return {
    name,
    instructions: typeof value.instructions === "string" && value.instructions.trim() ? value.instructions : null,
    usage_note: typeof value.usage_note === "string" && value.usage_note.trim() ? value.usage_note : null,
    tools,
  };
}

function readSkill(value: unknown, defaultName: string | null, label: string, problems: string[]): EvalSkill | null {
  if (!isRecord(value)) {
    problems.push(`${label}: expected a skill object`);
    return null;
  }
  const name = typeof value.name === "string" ? value.name : defaultName;
  if (!nonEmptyString(name)) {
    problems.push(`${label}: skill name is required`);
    return null;
  }
  if (!nonEmptyString(value.description)) {
    problems.push(`${label}: skill description is required`);
    return null;
  }
  if (value.uses !== undefined && !isStringArray(value.uses)) {
    problems.push(`${label}: uses must be an array of server names`);
    return null;
  }
  return { name, description: value.description, uses: value.uses ?? [] };
}

function readCase(
  item: unknown,
  index: number,
  serverLib: Library<EvalMcpServer>,
  skillLib: Library<EvalSkill>,
  problems: string[],
): EvalCase | null {
  const label = isRecord(item) && typeof item.id === "string" ? item.id : `#${index}`;
  if (!isRecord(item)) {
    problems.push(`${label}: expected a case object`);
    return null;
  }
  const before = problems.length;
  if (!nonEmptyString(item.id)) problems.push(`${label}: id is required`);
  if (!(EVAL_CATEGORIES as readonly string[]).includes(String(item.category))) {
    problems.push(`${label}: category must be one of ${EVAL_CATEGORIES.join(", ")}`);
  }
  if (!LOCALES.has(String(item.locale))) problems.push(`${label}: locale must be zh or en`);
  if (!nonEmptyString(item.trigger)) problems.push(`${label}: trigger is required`);

  const skills: EvalSkill[] = [];
  if (item.skills !== undefined) {
    if (!Array.isArray(item.skills)) problems.push(`${label}: skills must be an array`);
    else {
      for (const [i, entry] of item.skills.entries()) {
        if (typeof entry === "string") {
          const found = skillLib[entry];
          if (found) skills.push(found);
          else problems.push(`${label}.skills[${i}]: unknown skill "${entry}"`);
          continue;
        }
        const skill = readSkill(entry, null, `${label}.skills[${i}]`, problems);
        if (skill) skills.push(skill);
      }
    }
  }

  const mcp: EvalMcpServer[] = [];
  if (item.mcp !== undefined) {
    if (!Array.isArray(item.mcp)) problems.push(`${label}: mcp must be an array`);
    else {
      for (const [i, entry] of item.mcp.entries()) {
        const entryLabel = `${label}.mcp[${i}]`;
        if (typeof entry === "string") {
          const found = serverLib[entry];
          if (found) mcp.push(found);
          else problems.push(`${entryLabel}: unknown server "${entry}"`);
          continue;
        }
        if (isRecord(entry) && typeof entry.use === "string") {
          const base = serverLib[entry.use];
          if (!base) {
            problems.push(`${entryLabel}: unknown server "${entry.use}"`);
            continue;
          }
          mcp.push({
            ...base,
            ...(typeof entry.name === "string" ? { name: entry.name } : {}),
            ...(entry.instructions !== undefined
              ? { instructions: typeof entry.instructions === "string" && entry.instructions.trim() ? entry.instructions : null }
              : {}),
            ...(entry.usage_note !== undefined
              ? { usage_note: typeof entry.usage_note === "string" && entry.usage_note.trim() ? entry.usage_note : null }
              : {}),
          });
          continue;
        }
        const server = readServer(entry, null, entryLabel, problems);
        if (server) mcp.push(server);
      }
    }
  }
  const serverNames = new Set<string>();
  for (const server of mcp) {
    const key = server.name.toLowerCase();
    if (serverNames.has(key)) problems.push(`${label}: server "${server.name}" listed twice`);
    serverNames.add(key);
  }

  const locale = (LOCALES.has(String(item.locale)) ? item.locale : "zh") as Locale;
  const profileRaw = isRecord(item.profile) ? item.profile : {};
  const profile: EvalProfile = {
    name: typeof profileRaw.name === "string" ? profileRaw.name : DEFAULT_PROFILE[locale].name,
    duties: typeof profileRaw.duties === "string" ? profileRaw.duties : DEFAULT_PROFILE[locale].duties,
    boundaries:
      typeof profileRaw.boundaries === "string" ? profileRaw.boundaries : DEFAULT_PROFILE[locale].boundaries,
  };

  const expect = readExpect(item.expect, label, problems);
  if (problems.length > before || !expect) return null;

  const draft: EvalCase = {
    id: item.id as string,
    category: item.category as EvalCategory,
    locale,
    profile,
    skills,
    mcp,
    trigger: (item.trigger as string).trim(),
    expect,
    ...(typeof item.note === "string" ? { note: item.note } : {}),
  };
  const known = knownLabels(draft);
  for (const want of expect.first) {
    if (want === REPLY) continue;
    if (!known.has(normalizeLabel(want))) {
      problems.push(`${label}: expected first "${want}" is not a skill or tool in this case`);
    }
  }
  for (const pattern of expect.forbid) {
    if (pattern.endsWith("*")) {
      if (pattern.length < 2) problems.push(`${label}: forbid pattern "*" would forbid everything`);
      continue;
    }
    if (pattern === REPLY) problems.push(`${label}: forbid cannot list "reply"; expect a tool with first instead`);
    else if (!known.has(normalizeLabel(pattern))) {
      problems.push(`${label}: forbidden "${pattern}" is not a skill or tool in this case`);
    }
  }
  return problems.length > before ? null : draft;
}

/** Skill names match case-insensitively (like read_skill itself); tool names are exact. */
function normalizeLabel(label: string): string {
  return label.startsWith(READ_SKILL_PREFIX) ? label.toLowerCase() : label;
}

function readExpect(raw: unknown, label: string, problems: string[]): EvalExpect | null {
  if (!isRecord(raw)) {
    problems.push(`${label}: expect is required`);
    return null;
  }
  const first = typeof raw.first === "string" ? [raw.first] : raw.first;
  if (!isStringArray(first) || first.length === 0 || first.some((item) => !nonEmptyString(item))) {
    problems.push(`${label}: expect.first must be a name or a non-empty list of names`);
    return null;
  }
  const forbid = raw.forbid === undefined ? [] : raw.forbid;
  if (!isStringArray(forbid) || forbid.some((item) => !nonEmptyString(item))) {
    problems.push(`${label}: expect.forbid must be a list of names or prefix patterns`);
    return null;
  }
  return { first: first.map((item) => item.trim()), forbid: forbid.map((item) => item.trim()) };
}

/** Every label a call in this case could legitimately produce: built-ins, mapped MCP names, and `read_skill:<name>`. */
function knownLabels(c: EvalCase): Set<string> {
  const labels = new Set<string>(COLLAB_TOOL_NAMES);
  for (const name of ["read_file", "write_file", "delete_file", "list_dir", "shell"]) labels.add(name);
  for (const tool of mapCase(c)) labels.add(tool.modelName);
  for (const skill of c.skills) labels.add(`${READ_SKILL_PREFIX}${skill.name.toLowerCase()}`);
  return labels;
}

function mapCase(c: EvalCase): MappedMcpTool[] {
  return mapMcpTools(
    c.mcp.map((server, i) => ({
      id: `srv${i}`,
      name: server.name,
      tools: server.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })),
    new Set(COLLAB_TOOL_NAMES),
  );
}

/** The exact messages and tools array a direct-session turn would send for this case. */
export function buildEvalTurn(c: EvalCase): EvalTurn {
  const mapped = mapCase(c);
  const guides: McpPromptGuide[] = c.mcp
    .map((server, i) => ({
      name: server.name,
      instructions: server.instructions,
      usageNote: server.usage_note,
      tools: mapped
        .filter((tool) => tool.serverId === `srv${i}`)
        .map((tool) => ({ modelName: tool.modelName, description: tool.description })),
    }))
    .filter((guide) => guide.tools.length > 0);
  const connected = new Set(guides.map((guide) => guide.name.toLowerCase()));
  const skills: SkillPromptEntry[] = c.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    uses: skill.uses,
    unavailable: skill.uses.filter((name) => !connected.has(name.toLowerCase())),
  }));
  const system = turnSystemPrompt({
    locale: c.locale,
    name: c.profile.name,
    duties: c.profile.duties,
    boundaries: c.profile.boundaries,
    interrupt: false,
    skills,
    mcpGuides: guides,
  });
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `【user】\n${TRIGGER_FLAG}\n${c.trigger}` },
  ];
  const tools = [...builtinTools(c.locale), ...mappedMcpChatTools(mapped)];
  return { messages, tools, toolNames: new Set(tools.map((tool) => tool.function.name)), mapped };
}

function skillArg(call: ToolCall): string | null {
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}");
    if (!isRecord(parsed)) return null;
    if (typeof parsed.name === "string" && parsed.name.trim()) return parsed.name.trim();
    if (typeof parsed.id === "string" && parsed.id.trim()) return parsed.id.trim();
    return null;
  } catch {
    return null;
  }
}

/** `read_skill:<name>` for read_skill calls, the tool name otherwise. */
export function labelCall(call: ToolCall): string {
  if (call.name === "read_skill") return `${READ_SKILL_PREFIX}${skillArg(call) ?? "?"}`;
  return call.name;
}

function matchesFirst(want: string, call: ToolCall | undefined): boolean {
  if (want === REPLY) return !call || REPLY_TOOLS.has(call.name);
  if (want.startsWith(READ_SKILL_PREFIX)) {
    if (!call || call.name !== "read_skill") return false;
    return (skillArg(call) ?? "").toLowerCase() === want.slice(READ_SKILL_PREFIX.length).toLowerCase();
  }
  return call?.name === want;
}

function matchesPattern(pattern: string, label: string): boolean {
  if (pattern.endsWith("*")) return label.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith(READ_SKILL_PREFIX)) return label.toLowerCase() === pattern.toLowerCase();
  return label === pattern;
}

export function scoreCompletion(
  c: EvalCase,
  result: CompletionResult,
  toolNames: ReadonlySet<string>,
): EvalOutcome {
  if (!result.ok) {
    return {
      pass: false,
      got: `fail:${result.failKind}`,
      calls: [],
      unknownTools: [],
      reason: `completion failed: ${result.failKind}`,
    };
  }
  const calls = result.toolCalls;
  const labels = calls.map(labelCall);
  const got = labels[0] ?? REPLY;
  const unknownTools = [...new Set(calls.map((call) => call.name).filter((name) => !toolNames.has(name)))];
  const firstOk = c.expect.first.some((want) => matchesFirst(want, calls[0]));
  const forbidden = [...new Set(labels.filter((label) => c.expect.forbid.some((p) => matchesPattern(p, label))))];
  const reasons: string[] = [];
  if (!firstOk) reasons.push(`expected first ${c.expect.first.join(" | ")}, got ${got}`);
  if (forbidden.length > 0) reasons.push(`forbidden: ${forbidden.join(", ")}`);
  if (unknownTools.length > 0) reasons.push(`not in tools array: ${unknownTools.join(", ")}`);
  return {
    pass: reasons.length === 0,
    got,
    calls: labels,
    unknownTools,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}

function bump(tally: EvalTally | undefined, pass: boolean): EvalTally {
  const next = tally ?? { passed: 0, total: 0 };
  next.total += 1;
  if (pass) next.passed += 1;
  return next;
}

export function summarize(rows: EvalRow[]): EvalModelSummary[] {
  const byModel = new Map<string, EvalModelSummary>();
  for (const row of rows) {
    const summary =
      byModel.get(row.model) ?? { model: row.model, overall: { passed: 0, total: 0 }, byCategory: {}, byLocale: {} };
    summary.overall = bump(summary.overall, row.outcome.pass);
    summary.byCategory[row.category] = bump(summary.byCategory[row.category], row.outcome.pass);
    summary.byLocale[row.locale] = bump(summary.byLocale[row.locale], row.outcome.pass);
    byModel.set(row.model, summary);
  }
  return [...byModel.values()];
}

export function rate(tally: EvalTally): string {
  const pct = tally.total === 0 ? 0 : Math.round((tally.passed / tally.total) * 100);
  return `${tally.passed}/${tally.total} (${pct}%)`;
}

/** Markdown report: one section per model with the tallies, then every attempt as a table row. */
export function formatReport(summaries: EvalModelSummary[], rows: EvalRow[]): string {
  const out: string[] = [];
  for (const summary of summaries) {
    out.push(`## ${summary.model} — ${rate(summary.overall)}`, "");
    const cats = EVAL_CATEGORIES.filter((cat) => summary.byCategory[cat]).map(
      (cat) => `${cat} ${rate(summary.byCategory[cat]!)}`,
    );
    const locs = (["zh", "en"] as Locale[])
      .filter((loc) => summary.byLocale[loc])
      .map((loc) => `${loc} ${rate(summary.byLocale[loc]!)}`);
    if (cats.length > 0) out.push(`By category: ${cats.join(" · ")}`);
    if (locs.length > 0) out.push(`By locale: ${locs.join(" · ")}`);
    out.push("", "| case | attempt | got | result |", "|---|---|---|---|");
    for (const row of rows.filter((r) => r.model === summary.model)) {
      const result = row.outcome.pass ? "pass" : `FAIL — ${row.outcome.reason ?? ""}`;
      out.push(`| ${row.caseId} | ${row.attempt} | ${escapeCell(row.outcome.got)} | ${escapeCell(result)} |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
