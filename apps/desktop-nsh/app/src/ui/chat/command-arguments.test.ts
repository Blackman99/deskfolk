import { expect, test } from "nsh/test";
import type { ClaudeCodeCommand } from "@real-bot/protocol";
import { argumentOptions, argumentQuery, matchArguments, takesChoices, withArgument } from "./command-arguments";

const command = (name: string, argument_hint: string, aliases: string[] = []): ClaudeCodeCommand => ({ name, description: "", argument_hint, aliases });

test("the choices are the alternatives of a hint's first group, as Claude Code writes them", () => {
  // Hints as a Claude Code session listed them (2026-11-12).
  expect(argumentOptions("[fable|opus|sonnet|off]")).toEqual(["fable", "opus", "sonnet", "off"]);
  expect(argumentOptions("[on|off]")).toEqual(["on", "off"]);
  expect(argumentOptions("[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(argumentOptions("[reconnect|enable|disable [<server>|all]]")).toEqual(["reconnect", "enable", "disable"]);
  expect(argumentOptions("consent | revoke")).toEqual(["consent", "revoke"]);
  // A placeholder among them is left to you.
  expect(argumentOptions("[auto|<tokens>]")).toEqual(["auto"]);
});

test("a hint with no alternatives names no choices", () => {
  for (const hint of [
    "",
    "[name]",
    "[style]",
    "<file>",
    "key=value",
    "<instruction>",
    "[issue description]",
    "[interval] [prompt]",
    "[<target>]",
    '[<project hint, e.g. "Acme DS">]',
    "[--request-id <uuid>] (--wizard posture=… scope=… depth=… --propose | --expect-sha256 <64-hex> --apply-file <path>)",
    "<optional custom summarization instructions>",
    // Codex's (ADR 0099).
    "[instructions]",
  ]) {
    expect(argumentOptions(hint)).toEqual([]);
  }
  expect(argumentOptions("[on|off")).toEqual([]);
});

const COMMANDS = [command("advisor", "[fable|opus|sonnet|off]"), command("fast", "[on|off]", ["speed"]), command("review", "<pr>")];

test("the argument is the word after a known command's name, with the caret in it", () => {
  const found = argumentQuery("/advisor op", 11, COMMANDS)!;
  expect(found.command.name).toBe("advisor");
  expect([found.query, found.from, found.to]).toEqual(["op", 9, 11]);
  expect(argumentQuery("/advisor ", 9, COMMANDS)!.query).toBe("");
  // By another name it goes by, in any case.
  expect(argumentQuery("/Speed o", 8, COMMANDS)!.command.name).toBe("fast");
  // The caret still in the name, past the first argument, or no space yet: not now.
  expect(argumentQuery("/advisor op", 4, COMMANDS)).toBe(null);
  expect(argumentQuery("/advisor opus now", 17, COMMANDS)).toBe(null);
  expect(argumentQuery("/advisor", 8, COMMANDS)).toBe(null);
  // A command with no choices, one not in the list, or not a command at all.
  expect(argumentQuery("/review 12", 10, COMMANDS)).toBe(null);
  expect(argumentQuery("/nope a", 7, COMMANDS)).toBe(null);
  expect(argumentQuery("advisor op", 10, COMMANDS)).toBe(null);
});

test("the choices fit by their start; a typed word that is already the one fit offers nothing", () => {
  const at = (text: string) => matchArguments(argumentQuery(text, text.length, COMMANDS)!);
  expect(at("/advisor ")).toEqual(["fable", "opus", "sonnet", "off"]);
  expect(at("/advisor o")).toEqual(["opus", "off"]);
  expect(at("/advisor OP")).toEqual(["opus"]);
  expect(at("/advisor opus")).toEqual([]);
  // Not by what is inside them: what no choice starts with goes as typed.
  expect(at("/advisor pus")).toEqual([]);
  expect(at("/fast 1")).toEqual([]);
});

test("a picked choice takes the typed word's place", () => {
  const found = argumentQuery("/advisor o and more", 10, COMMANDS)!;
  expect(withArgument("/advisor o and more", found, "opus")).toEqual({ text: "/advisor opus and more", caret: 13 });
  expect(takesChoices(COMMANDS[0]!)).toBe(true);
  expect(takesChoices(COMMANDS[2]!)).toBe(false);
});
