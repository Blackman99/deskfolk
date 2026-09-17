import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionResult, ToolCall } from "./completions";
import { TRIGGER_FLAG } from "./context";
import {
  buildEvalTurn,
  formatReport,
  labelCall,
  scoreCompletion,
  summarize,
  validateCases,
  type EvalCase,
  type EvalRow,
} from "./tool-selection-eval";

const CASES_PATH = join(import.meta.dir, "..", "eval", "tool-selection-cases.json");

function loadBundled(): EvalCase[] {
  return validateCases(JSON.parse(readFileSync(CASES_PATH, "utf8")), CASES_PATH);
}

function ok(calls: Array<Partial<ToolCall> & { name: string }>): CompletionResult {
  return {
    ok: true,
    content: "",
    toolCalls: calls.map((call, i) => ({ id: call.id ?? `c${i}`, name: call.name, arguments: call.arguments ?? "{}" })),
    finishReason: "tool_calls",
    hadChoices: true,
    usage: null,
    missingReason: null,
  };
}

const github = {
  name: "github",
  instructions: "GitHub issues and PRs.",
  tools: [
    { name: "get_issue", description: "Read one issue." },
    { name: "create_pull_request", description: "Open a PR." },
  ],
};

describe("tool-selection eval cases", () => {
  test("the bundled cases file validates and every case builds a turn", () => {
    const cases = loadBundled();
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(cases.length);
    for (const c of cases) {
      const turn = buildEvalTurn(c);
      expect(turn.messages[0]?.role).toBe("system");
      expect(String(turn.messages[1]?.content)).toContain(TRIGGER_FLAG);
      expect(String(turn.messages[1]?.content)).toContain(c.trigger);
      expect(turn.tools.length).toBeGreaterThan(0);
    }
    // Every category is exercised at least once so a regression in one lever shows up.
    for (const category of ["skill", "mcp", "usage_note", "builtin", "reply"]) {
      expect(cases.some((c) => c.category === category)).toBe(true);
    }
  });

  test("library references resolve and per-case overrides replace one field", () => {
    const cases = validateCases({
      servers: { github },
      skills: { release: { description: "when releasing", uses: ["github"] } },
      cases: [
        {
          id: "a",
          category: "usage_note",
          locale: "zh",
          skills: ["release"],
          mcp: [{ use: "github", usage_note: "只读" }],
          trigger: "查 issue",
          expect: { first: ["mcp_github_get_issue", "read_skill:release"], forbid: ["mcp_github_create_pull_request"] },
        },
      ],
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]?.mcp[0]?.usage_note).toBe("只读");
    expect(cases[0]?.mcp[0]?.instructions).toBe("GitHub issues and PRs.");
    expect(cases[0]?.skills[0]?.uses).toEqual(["github"]);
    expect(cases[0]?.profile.name).toBe("助手");
  });

  test("expectations that name a skill or tool the case does not have are rejected", () => {
    const base = { id: "x", category: "mcp", locale: "en", mcp: [github], trigger: "hi" };
    expect(() => validateCases([{ ...base, expect: { first: "mcp_github_get_issue" } }])).not.toThrow();
    expect(() => validateCases([{ ...base, expect: { first: "mcp_gitlab_get_issue" } }])).toThrow(
      /expected first "mcp_gitlab_get_issue" is not a skill or tool/,
    );
    expect(() => validateCases([{ ...base, expect: { first: "read_skill:release" } }])).toThrow(/not a skill or tool/);
    expect(() => validateCases([{ ...base, expect: { first: "reply", forbid: ["*"] } }])).toThrow(/forbid everything/);
    expect(() => validateCases([{ ...base, expect: { first: "reply", forbid: ["reply"] } }])).toThrow(/cannot list "reply"/);
    expect(() => validateCases([{ ...base, id: "", expect: { first: "reply" } }])).toThrow(/id is required/);
    expect(() => validateCases([{ ...base, category: "nope", expect: { first: "reply" } }])).toThrow(/category must be/);
    expect(() =>
      validateCases([
        { ...base, expect: { first: "reply" } },
        { ...base, expect: { first: "reply" } },
      ]),
    ).toThrow(/duplicate id/);
    expect(() => validateCases({ cases: "nope" })).toThrow(/expected an array/);
  });
});

describe("tool-selection eval turn", () => {
  test("the turn carries the skill catalog, the MCP block with usage note, and the mapped tools", () => {
    const [c] = validateCases([
      {
        id: "t",
        category: "skill",
        locale: "zh",
        skills: [{ name: "release", description: "when releasing", uses: ["github", "slack"] }],
        mcp: [{ ...github, usage_note: "只读，不要开 PR" }],
        trigger: "发版",
        expect: { first: "read_skill:release" },
      },
    ]);
    const turn = buildEvalTurn(c!);
    const system = String(turn.messages[0]?.content);
    expect(system).toContain("# 技能");
    expect(system).toContain("## release");
    expect(system).toContain("依赖 MCP：github、slack（本轮未连接）");
    expect(system).toContain("# 本轮 MCP");
    expect(system).toContain("用法备注：只读，不要开 PR");
    expect(system).toContain("- mcp_github_get_issue: Read one issue.");
    expect(turn.messages[1]?.content).toBe(`【user】\n${TRIGGER_FLAG}\n发版`);
    expect(turn.toolNames.has("read_skill")).toBe(true);
    expect(turn.toolNames.has("read_file")).toBe(true);
    expect(turn.toolNames.has("mcp_github_create_pull_request")).toBe(true);
    expect(turn.tools.length).toBe(turn.toolNames.size);
  });
});

describe("tool-selection eval scoring", () => {
  const [c] = validateCases([
    {
      id: "s",
      category: "usage_note",
      locale: "en",
      skills: [{ name: "Release", description: "when releasing" }],
      mcp: [github],
      trigger: "open a PR for #12",
      expect: { first: ["reply", "mcp_github_get_issue", "read_skill:release"], forbid: ["mcp_github_create_*"] },
    },
  ]);
  const toolNames = buildEvalTurn(c!).toolNames;

  test("first call is judged by label; read_skill matches the skill name case-insensitively", () => {
    expect(scoreCompletion(c!, ok([{ name: "mcp_github_get_issue" }]), toolNames).pass).toBe(true);
    const viaSkill = scoreCompletion(c!, ok([{ name: "read_skill", arguments: '{"name":"RELEASE"}' }]), toolNames);
    expect(viaSkill.pass).toBe(true);
    expect(viaSkill.got).toBe("read_skill:RELEASE");
    const byId = scoreCompletion(c!, ok([{ name: "read_skill", arguments: '{"id":"01ABC"}' }]), toolNames);
    expect(byId.pass).toBe(false);
    expect(byId.reason).toContain("got read_skill:01ABC");
  });

  test("reply means no tool call or send_message / ask_user first", () => {
    expect(scoreCompletion(c!, ok([]), toolNames)).toMatchObject({ pass: true, got: "reply" });
    expect(scoreCompletion(c!, ok([{ name: "ask_user" }]), toolNames).pass).toBe(true);
    expect(scoreCompletion(c!, ok([{ name: "send_message" }]), toolNames).pass).toBe(true);
    expect(scoreCompletion(c!, ok([{ name: "list_dir" }]), toolNames).pass).toBe(false);
  });

  test("a forbidden call anywhere in the completion fails, and so does an invented tool", () => {
    const forbidden = scoreCompletion(
      c!,
      ok([{ name: "mcp_github_get_issue" }, { name: "mcp_github_create_pull_request" }]),
      toolNames,
    );
    expect(forbidden.pass).toBe(false);
    expect(forbidden.reason).toBe("forbidden: mcp_github_create_pull_request");
    const invented = scoreCompletion(c!, ok([{ name: "ask_user" }, { name: "mcp_gitlab_open_mr" }]), toolNames);
    expect(invented.pass).toBe(false);
    expect(invented.unknownTools).toEqual(["mcp_gitlab_open_mr"]);
    expect(invented.reason).toBe("not in tools array: mcp_gitlab_open_mr");
  });

  test("a failed completion scores as a failure with its kind", () => {
    const failed: CompletionResult = {
      ok: false,
      failKind: "refused",
      hadChoices: false,
      usage: null,
      missingReason: null,
    };
    expect(scoreCompletion(c!, failed, toolNames)).toMatchObject({ pass: false, got: "fail:refused" });
  });

  test("labels, tallies and the report", () => {
    expect(labelCall({ id: "1", name: "read_skill", arguments: "not json" })).toBe("read_skill:?");
    expect(labelCall({ id: "1", name: "shell", arguments: "{}" })).toBe("shell");
    const rows: EvalRow[] = [
      { model: "m", caseId: "a", category: "skill", locale: "zh", attempt: 1, ms: 10, outcome: { pass: true, got: "read_skill:a", calls: [], unknownTools: [], reason: null } },
      { model: "m", caseId: "b", category: "mcp", locale: "en", attempt: 1, ms: 12, outcome: { pass: false, got: "reply", calls: [], unknownTools: [], reason: "expected first mcp_x_y, got reply" } },
      { model: "n", caseId: "a", category: "skill", locale: "zh", attempt: 1, ms: 9, outcome: { pass: true, got: "read_skill:a", calls: [], unknownTools: [], reason: null } },
    ];
    const summaries = summarize(rows);
    expect(summaries.map((s) => s.model)).toEqual(["m", "n"]);
    expect(summaries[0]?.overall).toEqual({ passed: 1, total: 2 });
    expect(summaries[0]?.byCategory.mcp).toEqual({ passed: 0, total: 1 });
    expect(summaries[0]?.byLocale.zh).toEqual({ passed: 1, total: 1 });
    const report = formatReport(summaries, rows);
    expect(report).toContain("## m — 1/2 (50%)");
    expect(report).toContain("By category: skill 1/1 (100%) · mcp 0/1 (0%)");
    expect(report).toContain("| b | 1 | reply | FAIL — expected first mcp_x_y, got reply |");
    expect(report).toContain("## n — 1/1 (100%)");
  });
});
