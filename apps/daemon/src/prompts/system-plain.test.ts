import { describe, expect, test } from "bun:test";
import type { BotRunner, Locale } from "@real-bot/protocol";
import { AGENT_PREFACE, agentSystemPrompt, LOCAL_AGENT_PREFACE, PLAIN_PREFACE_EDITS, REPLY_ONLY_AGENT_PREFACE } from "./agent-system";
import { builtinTools } from "./builtin-tools";
import { systemText } from "./system";
import { NO_WAIT_EDITS, PLAIN_SYSTEM_EDITS, plainSystemText } from "./system-plain";

/** What only holds in a job: a tool of the job kernel, its folders and files, its checks and its ledger. */
const JOB_WORDS = /work_on|\bsubmit\b|plan_items|\bdelegate\b|任务目录|规划目录|map\.md|ticket\.md|ticket dir|plan dir|收尾检查|closing check|需求台账|requirements ledger/i;
const LOCALES: Locale[] = ["zh", "en"];

describe.each(LOCALES)("%s", (locale) => {
  const full = systemText(locale, "sh", 0);

  test("every edit still finds the words it edits", () => {
    const { paragraphs, clauses } = PLAIN_SYSTEM_EDITS[locale];
    for (const [start] of paragraphs) expect(full.split("\n\n").filter((paragraph) => paragraph.startsWith(start))).toHaveLength(1);
    for (const [from] of clauses) expect(full.split(from).length).toBe(2);
    const prefaces = [AGENT_PREFACE[locale], LOCAL_AGENT_PREFACE[locale], REPLY_ONLY_AGENT_PREFACE[locale]];
    for (const [from] of PLAIN_PREFACE_EDITS[locale]) expect(prefaces.some((preface) => preface.includes(from))).toBe(true);
  });

  test("what it says of waiting on the user's word still finds its words", () => {
    expect(systemText(locale, "sh", 8).split(NO_WAIT_EDITS[locale][0]).length).toBe(2);
  });

  test("the System section names nothing that only holds in a job", () => {
    expect(plainSystemText(locale, "sh")).not.toMatch(JOB_WORDS);
    expect(plainSystemText(locale, "powershell")).not.toMatch(JOB_WORDS);
  });

  test("what the two share stays one text", () => {
    const plain = plainSystemText(locale, "sh").split("\n\n");
    const kept = full.split("\n\n").filter((paragraph) => plain.includes(paragraph));
    // Everything but the four paragraphs said anew and the five clauses edited inside theirs.
    expect(kept.length).toBeGreaterThan(full.split("\n\n").length - 10);
  });

  test("no tool it is offered says otherwise", () => {
    const tools = builtinTools(locale, 8, undefined, false);
    for (const name of ["work_on", "delegate", "submit", "review", "plan_items"]) expect(tools.map((tool) => tool.function.name)).not.toContain(name);
    for (const tool of tools) expect(`${tool.function.name}: ${JSON.stringify(tool.function)}`).not.toMatch(JOB_WORDS);
    const end = tools.find((tool) => tool.function.name === "end_turn")!;
    expect(end.function.parameters.properties.inbox).toBeUndefined();
    expect(end.function.parameters.required ?? []).not.toContain("reason");
  });

  test("your edits of a tool's description hold, but not of the two that assume an end contract", () => {
    const edited = (name: string) => `edited ${name}`;
    const tools = builtinTools(locale, 8, edited, false);
    const of = (name: string) => tools.find((tool) => tool.function.name === name)!.function.description;
    expect(of("read_file")).toBe("edited read_file");
    expect(of("end_turn")).not.toContain("edited");
    expect(of("send_message")).not.toContain("edited");
  });

  test("a job-working engine's tools are what they were", () => {
    expect(builtinTools(locale, 8, undefined, true)).toEqual(builtinTools(locale, 8));
  });

  const agents: Array<{ label: string; runner: BotRunner; appTools: boolean } | undefined> = [
    undefined,
    { label: "Codex", runner: "codex", appTools: true },
    { label: "Antigravity", runner: "antigravity", appTools: false },
  ];
  test.each(agents)("an agent's turn is told the same, whichever runs it: %j", (agent) => {
    const prompt = (jobs: boolean) => agentSystemPrompt({
      locale, name: "B", duties: "d", boundaries: "b", workspace: "/w", cwd: "/w", engineLevel: 8, jobs,
      texts: jobs ? {} : { system: plainSystemText(locale, "sh") }, ...(agent ? { agent } : {}),
    });
    expect(prompt(false)).not.toMatch(JOB_WORDS);
    expect(prompt(true)).toMatch(JOB_WORDS);
  });
});
