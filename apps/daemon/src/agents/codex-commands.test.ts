import { expect, test } from "bun:test";
import { join } from "node:path";
import { CODEX_BUILTIN_COMMANDS, CODEX_COMMANDS_MAX_AGE_MS, codexBuiltinOf, createCodexCommandList, readSkills, type CodexSkill } from "./codex-commands";
import type { ResolvedAgent } from "./runtime";

const FAKE = join(import.meta.dir, "..", "fixtures", "agents", "fake-codex.ts");
const codex: ResolvedAgent = { ok: true, executable: "/usr/local/bin/codex", source: "known", args: ["app-server"], env: {}, proxy: null };

test("Codex's own commands the app carries out go by their name or another", () => {
  expect(CODEX_BUILTIN_COMMANDS.map((command) => command.name)).toEqual(["compact", "review", "new"]);
  expect(codexBuiltinOf("compact")).toBe("compact");
  expect(codexBuiltinOf("clear")).toBe("new");
  expect(codexBuiltinOf("status")).toBeNull();
});

test("the skills that are on, each name once, by the short line Codex's pickers show", () => {
  const skills = readSkills({
    data: [
      { skills: [
        { name: "pdf:pdf", description: "Read, create, inspect and verify PDF files where layout matters", interface: { shortDescription: "Read, create, render, and verify PDF files" }, path: "/p/pdf/SKILL.md", enabled: true },
        { name: "imagegen", description: "Generate or edit images", path: "/s/imagegen/SKILL.md", enabled: true },
        { name: "off", description: "turned off", path: "/s/off/SKILL.md", enabled: false },
        { name: "compact", description: "a skill named as a command", path: "/s/compact/SKILL.md" },
        { name: "two words", description: "no slash name", path: "/s/x/SKILL.md" },
        { name: "nopath", description: "no file" },
      ] },
      { skills: [{ name: "imagegen", description: "a second one", path: "/elsewhere/SKILL.md" }, { name: "hello", shortDescription: "Say hello", description: "Say hello like a pirate", path: "/r/hello/SKILL.md" }] },
    ],
  });
  expect(skills).toEqual([
    { name: "hello", description: "Say hello", path: "/r/hello/SKILL.md" },
    { name: "imagegen", description: "Generate or edit images", path: "/s/imagegen/SKILL.md" },
    { name: "pdf:pdf", description: "Read, create, render, and verify PDF files", path: "/p/pdf/SKILL.md" },
  ]);
  expect(readSkills(null)).toEqual([]);
  expect(readSkills({ data: [{ skills: "nope" as never }] })).toEqual([]);
});

test("a directory's list is Codex's commands, then its skills, kept a while; asked again once old", async () => {
  let clock = 1_000;
  const asked: string[] = [];
  const list = createCodexCommandList({
    resolve: async () => codex,
    ask: async (_codex, dir) => {
      asked.push(dir);
      return [{ name: "hello", description: "Say hello", path: "/r/hello/SKILL.md" }] satisfies CodexSkill[];
    },
    now: () => clock,
  });
  const first = await list.list("/p");
  expect(first.error).toBeNull();
  expect(first.commands.map((command) => command.name)).toEqual(["compact", "review", "new", "hello"]);
  expect(first.commands.at(-1)).toEqual({ name: "hello", description: "Say hello", argument_hint: "", aliases: [] });
  await Promise.all([list.list("/p"), list.list("/p")]);
  expect(asked).toEqual(["/p"]);
  await list.list("/q");
  clock += CODEX_COMMANDS_MAX_AGE_MS + 1;
  await list.list("/p");
  expect(asked).toEqual(["/p", "/q", "/p"]);
});

test("without the skills Codex's own commands are still listed, with what went wrong; a list had before still serves", async () => {
  const missing = createCodexCommandList({ resolve: async () => ({ ok: false, error: "not found" }), ask: async () => [] });
  expect(await missing.list("/p")).toMatchObject({ commands: CODEX_BUILTIN_COMMANDS, error: "codex_not_found" });

  let clock = 0;
  let fails = false;
  const flaky = createCodexCommandList({
    resolve: async () => codex,
    ask: async () => {
      if (fails) throw new Error("Codex exited before it listed its skills");
      return [{ name: "hello", description: "", path: "/r/hello/SKILL.md" }];
    },
    now: () => clock,
  });
  expect((await flaky.list("/new")).commands).toHaveLength(4);
  fails = true;
  expect(await flaky.list("/other")).toMatchObject({ commands: CODEX_BUILTIN_COMMANDS, error: "Codex exited before it listed its skills" });
  clock += CODEX_COMMANDS_MAX_AGE_MS + 1;
  const old = await flaky.list("/new");
  expect(old.commands.map((command) => command.name)).toContain("hello");
  expect(old.error).toBe("Codex exited before it listed its skills");
});

test("the real ask starts Codex's app-server in the directory and asks it for the skills there", async () => {
  const list = createCodexCommandList({
    resolve: async () => ({
      ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
      env: { ...(process.env as Record<string, string>), FAKE_CODEX_SCRIPT: JSON.stringify({ skills: [{ name: "hello", description: "Say hello", path: "/r/hello/SKILL.md" }], turns: [] }) },
    }),
  });
  const listed = await list.list(import.meta.dir);
  expect(listed.error).toBeNull();
  expect(listed.commands.map((command) => command.name)).toEqual(["compact", "review", "new", "hello"]);
});
