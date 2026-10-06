import { describe, expect, test } from "bun:test";
import type { Locale } from "@real-bot/protocol";
import type { ToolShellKind } from "../platform";
import { seamsJudgePrompt, seamsRulesText } from "../seams-check";
import { standardJudgePrompt } from "../standard-check";
import { AGENT_PREFACE } from "./agent-system";
import { editedToolDescription, promptPage, turnPromptTexts, type PromptOverrideRow } from "./book";
import { builtinTools, toolDescription } from "./builtin-tools";
import { COMPOSER_SUGGEST_SYSTEM } from "./composer-suggestions";
import { fill, placeholderCounts, PLACEHOLDERS } from "./fill";
import { JUDGEMENT_SYSTEM } from "./judgement";
import { ORGANIZER_SYSTEM, ORGANIZER_SYSTEM_UNDER_HOLDS } from "./organizer";
import { READ_BOT_LINE_SYSTEM, READ_FILING_SYSTEM, READ_SCALE_SYSTEM, READ_USER_LINE_SYSTEM } from "./reader";
import { reflectionSystem } from "./reflection";
import { renderDefault, SLOTS, slotDef } from "./registry";
import { retrospectiveSystem } from "./retrospective";
import { SCRIBE_SYSTEM } from "./scribe";
import { MCP_INTRO, MEMORY_INTRO, SKILLS_INTRO, systemText } from "./system";
import { deleteFileTool, listDirTool, readFileTool, shellTool, writeFileTool } from "./tools/files";
import { updateProfileTool } from "./tools/profile";

const LOCALES: Locale[] = ["zh", "en"];
const LEVELS = [0, 1, 3, 5, 8];
const SHELLS: ToolShellKind[] = ["sh", "bash", "powershell"];

describe("the slots", () => {
  test("each has a unique id, a group, its languages and a title and summary in both", () => {
    expect(new Set(SLOTS.map((slot) => slot.id)).size).toBe(SLOTS.length);
    for (const slot of SLOTS) {
      expect(slot.id).toMatch(/^(turn|agent|tool|call)\.[a-z][a-z0-9_]*$/);
      expect(slot.id.startsWith(`${slot.group}.`)).toBe(true);
      expect(slot.locales.length).toBeGreaterThan(0);
      for (const l of LOCALES) {
        expect(slot.title[l].length).toBeGreaterThan(0);
        expect(slot.summary[l].length).toBeGreaterThan(0);
      }
      // Only the app's own calls have an answer the code parses, and so a fixed format.
      expect(slot.format !== undefined).toBe(slot.group === "call");
      expect(slot.placeholders.includes("format")).toBe(slot.group === "call");
    }
  });

  test("a default carries its placeholders as declared, and no other", () => {
    for (const slot of SLOTS) {
      for (const l of slot.locales) {
        for (const level of LEVELS) {
          for (const shell of SHELLS) {
            const text = renderDefault(slot, l, { level, shell });
            expect(text.trim().length).toBeGreaterThan(0);
            const counts = placeholderCounts(text);
            for (const name of PLACEHOLDERS) {
              const n = counts.get(name) ?? 0;
              if (!slot.placeholders.includes(name)) expect(n).toBe(0);
              else if (name === "format") expect(n).toBe(1);
              else expect(n).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  test("the calls whose answer is read from the first brace hold none, once filled (ADR 0012)", () => {
    for (const id of ["call.judgement", "call.composer"]) {
      expect(slotDef(id)!.noBrace).toBe(true);
      expect(promptPage(null, "zh", { level: 8 }).resolve(id).text).not.toContain("{");
    }
  });
});

describe("the defaults are the texts the app has always sent", () => {
  test("every turn: the System section for each level and shell, and the section notes", () => {
    for (const l of LOCALES) {
      for (const level of LEVELS) {
        for (const shell of SHELLS) {
          expect(promptPage(null, l, { level, shell }).resolve("turn.system").text).toBe(systemText(l, shell, level));
        }
      }
      const page = promptPage(null, l, { level: 8 });
      expect(page.resolve("turn.skills").text).toBe(SKILLS_INTRO[l]);
      expect(page.resolve("turn.memory").text).toBe(MEMORY_INTRO[l]);
      expect(page.resolve("turn.mcp").text).toBe(MCP_INTRO[l]);
      expect(page.resolve("agent.preface", { workspace: "/w", cwd: "/w/x" }).text).toBe(fill(AGENT_PREFACE[l], { workspace: "/w", cwd: "/w/x" }));
    }
  });

  test("tool descriptions, by level, and by shell where a tool is written for one", () => {
    for (const l of LOCALES) {
      for (const level of LEVELS) {
        const page = promptPage(null, l, { level });
        for (const tool of builtinTools(l, level)) {
          expect(page.resolve(`tool.${tool.function.name}`).text).toBe(tool.function.description);
        }
      }
      for (const shell of SHELLS) {
        for (const def of [readFileTool(shell), writeFileTool(shell), deleteFileTool(shell), listDirTool(shell), shellTool(shell), updateProfileTool(shell)]) {
          expect(toolDescription(def.name, l, { level: 8, shell })).toBe(def.description[l]);
        }
      }
    }
  });

  test("the app's own calls, format filled in where it always was", () => {
    const zh = (level: number) => promptPage(null, "zh", { level });
    expect(zh(0).resolve("call.organizer").text).toBe(ORGANIZER_SYSTEM);
    for (const level of [1, 8]) expect(zh(level).resolve("call.organizer").text).toBe(ORGANIZER_SYSTEM_UNDER_HOLDS);
    expect(zh(8).resolve("call.read_user_line").text).toBe(READ_USER_LINE_SYSTEM);
    expect(zh(8).resolve("call.read_bot_line").text).toBe(READ_BOT_LINE_SYSTEM);
    expect(zh(8).resolve("call.read_filing").text).toBe(READ_FILING_SYSTEM);
    expect(zh(8).resolve("call.read_scale").text).toBe(READ_SCALE_SYSTEM);
    expect(zh(8).resolve("call.scribe").text).toBe(SCRIBE_SYSTEM);
    expect(zh(8).resolve("call.judgement").text).toBe(JUDGEMENT_SYSTEM);
    expect(zh(8).resolve("call.composer").text).toBe(COMPOSER_SUGGEST_SYSTEM);
    for (const l of LOCALES) {
      const page = promptPage(null, l, { level: 8 });
      expect(page.resolve("call.reflection").text).toBe(reflectionSystem(l));
      expect(page.resolve("call.retrospective").text).toBe(retrospectiveSystem(l));
      // A rule that happens to say a placeholder stays words: values are filled in one pass.
      for (const rules of [[], ["左手持剑 {format}", "no $& here {item}"]]) {
        const values = { item: "片子衔接 {rules}", rules: seamsRulesText(rules, l) };
        for (const mode of ["image", "text", "digest"] as const) {
          expect(page.resolve(`call.seams_${mode}`, values).text).toBe(seamsJudgePrompt(values.item, rules, l, mode));
        }
        expect(page.resolve("call.standard", values).text).toBe(standardJudgePrompt(values.item, rules, l));
      }
    }
  });

  test("a call in one language is that language whatever the app's", () => {
    expect(promptPage(null, "en", { level: 8 }).resolve("call.scribe")).toEqual({
      text: SCRIBE_SYSTEM,
      ref: { id: "call.scribe", locale: "zh", revision_id: null },
    });
  });
});

describe("a page with your edits", () => {
  const source = (rows: PromptOverrideRow[]) => ({ promptOverrides: () => rows, capabilities: () => ({ engine_level: 8 }) });

  test("your text replaces the rendered default whole and keeps the fixed format", () => {
    const page = promptPage(source([
      { prompt_id: "turn.system", locale: "en", text: "Be brief.", revision_id: "r1" },
      { prompt_id: "call.scribe", locale: "zh", text: "只记用户的话。\n\n{format}", revision_id: "r2" },
    ]), "en");
    expect(page.resolve("turn.system")).toEqual({ text: "Be brief.", ref: { id: "turn.system", locale: "en", revision_id: "r1" } });
    expect(page.edited("turn.system")).toBe("Be brief.");
    expect(page.edited("turn.memory")).toBeUndefined();
    const scribe = page.resolve("call.scribe");
    expect(scribe.text.startsWith("只记用户的话。\n\n只输出一个 JSON 对象")).toBe(true);
    expect(scribe.ref).toEqual({ id: "call.scribe", locale: "zh", revision_id: "r2" });
    // The other language's edit is not this page's.
    expect(promptPage(source([{ prompt_id: "turn.system", locale: "zh", text: "简短。", revision_id: "r3" }]), "en").edited("turn.system")).toBeUndefined();
  });

  test("the turn texts and tool descriptions it hands on are only the edited ones", () => {
    const page = promptPage(source([
      { prompt_id: "turn.memory", locale: "zh", text: "记忆。", revision_id: "r1" },
      { prompt_id: "tool.remember", locale: "zh", text: "记一条。", revision_id: "r2" },
    ]), "zh");
    expect(turnPromptTexts(page)).toEqual({ system: undefined, skills: undefined, memory: "记忆。", mcp: undefined, preface: undefined });
    const tools = builtinTools("zh", 8, editedToolDescription(page));
    expect(tools.find((tool) => tool.function.name === "remember")!.function.description).toBe("记一条。");
    expect(tools.find((tool) => tool.function.name === "forget")!.function.description).toBe(builtinTools("zh", 8).find((tool) => tool.function.name === "forget")!.function.description);
  });
});

test("fill replaces each placeholder in one pass and leaves the rest", () => {
  expect(fill("{item} / {rules} / {format}", { item: "a {rules} $&", rules: "b" })).toBe("a {rules} $& / b / {format}");
  expect(fill('{"id": 1} {unknown}', { item: "x" })).toBe('{"id": 1} {unknown}');
});
