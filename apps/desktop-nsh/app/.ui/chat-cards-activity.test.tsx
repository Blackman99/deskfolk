import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");

async function open(section: "activity" | "plan") {
  const app = await openStory("chat-cards");
  await app.waitFor(`id:show-${section}`, { timeout: 10_000 });
  await app.press(`id:show-${section}`);
  return app;
}

test("finished commands fold to one line, count the failures, and open one output at a time", async () => {
  const app = await open("activity");
  await app.waitFor("id:card-commands");
  // The running one is not in the list; four are.
  expect(app.texts()).toContain(t.chat.commandCount(4));
  expect(app.texts()).toContain(`· ${t.chat.commandsFailed(1)}`);
  expect(app.texts()).toContain("Writer · 09:30");
  expect(app.shows("id:command-card")).toBe(false);
  await app.press("id:card-commands >> id:command-summary");
  await app.waitFor("id:command-card");
  expect(app.count("id:command-row")).toBe(4);
  expect(app.texts()).toContain("pnpm build");
  expect(app.texts()).toContain(t.chat.activity.exit(1));
  // A command that printed nothing is a plain line; the others open.
  expect(app.count("id:command-line")).toBe(3);
  expect(app.shows("id:command-output")).toBe(false);
  await app.press("id:card-commands >> text:pnpm build");
  await app.waitFor("id:command-output");
  expect(app.texts().some((text) => text.includes("128 modules transformed"))).toBe(true);
  // Colour codes are dropped from the output.
  expect(app.texts().some((text) => text.includes("\u001b"))).toBe(false);
  // Opening another closes the first.
  await app.press("id:card-commands >> text:pnpm test --filter chat");
  await app.waitUntil(() => app.texts().some((text) => text.includes("expected 2, got 3")));
  expect(app.count("id:command-output")).toBe(1);
  expect(app.texts().some((text) => text.includes("128 modules transformed"))).toBe(false);
  await app.press("id:card-commands >> id:command-summary");
  await app.waitFor("id:command-card", { state: "gone" });
});

test("a tool-call list names its rows in its own words", async () => {
  const app = await open("activity");
  await app.waitFor("id:card-commands-tools");
  expect(app.texts()).toContain("1 tool calls");
});

test("a working bubble's steps are listed whole with a running command's output; Escape closes them", async () => {
  const app = await open("activity");
  await app.waitFor("id:card-steps");
  expect(app.texts()).toContain("Writer 正在做 3 件事");
  expect(app.count("id:card-steps >> id:turn-step")).toBe(3);
  expect(app.texts()).toContain("读取 notes/weekly.md");
  expect(app.texts().some((text) => text.startsWith("building…"))).toBe(true);
  // Only a step with somewhere to go is a button.
  expect(app.count("id:card-steps >> id:turn-step-open")).toBe(1);
  expect(app.texts()).toContain("steps:open");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.texts().includes("steps:closed"));
  expect(app.shows("id:card-steps")).toBe(false);
});

test("a project session's step list shows its rows with no command output to read", async () => {
  const app = await open("activity");
  await app.keyboard.press("escape");
  await app.waitFor("id:card-task-steps");
  expect(app.texts()).toContain("后台命令");
  expect(app.shows("id:card-task-steps >> id:turn-step-output")).toBe(false);
});

test("delegation records say who asked whom, the reply and the wait", async () => {
  const app = await open("activity");
  await app.waitFor("id:delegation-records");
  expect(app.texts()).toContain(t.delegation.title);
  expect(app.texts()).toContain("Writer → Editor");
  // A Bot gone from the roster is named as deleted.
  expect(app.texts()).toContain(`Editor → ${t.top.deleted}`);
  expect(app.texts()).toContain(t.delegation.replied);
  expect(app.texts()).toContain(t.delegation.waiting(t.top.deleted));
  expect(app.texts()).toContain(`委派：补一张封面图（等结果）`);
  expect(app.shows("id:delegation-wait")).toBe(true);
  // The reply is Markdown; its file opens with the result message.
  await app.press("id:delegation-del-1 >> text:weekly.md");
  await app.waitUntil(() => app.texts().includes("open:notes/weekly.md:msg-result"));
});

test("the plan Claude Code asks you to approve is read, then approved or kept", async () => {
  const app = await open("plan");
  await app.waitFor("id:plan-card");
  expect(app.texts()).toContain(t.project.planHead);
  expect(app.texts()).toContain("迁移计划");
  expect(app.texts()).toContain(t.project.planHint);
  // An empty plan says so, and has no full-window toggle.
  expect(app.shows("id:plan-empty")).toBe(true);
  expect(app.count("id:plan-full-toggle")).toBe(1);
  // The file the plan names opens.
  await app.press("id:plan-body >> text:weekly.md");
  await app.waitUntil(() => app.texts().includes("path:notes/weekly.md"));
  await app.press("id:plan-approve");
  await app.waitUntil(() => app.texts().includes("plan:approved"));
  await app.waitFor("id:plan-body", { state: "gone" });
});

test("a long plan takes the whole window, its buttons under it, and leaves it to answer", async () => {
  const app = await open("plan");
  await app.waitFor("id:plan-card");
  await app.press("id:plan-full-toggle");
  await app.waitFor("id:plan-card-full");
  expect(app.shows("id:plan-held")).toBe(true);
  expect(app.texts()).toContain(t.project.planHintFull);
  await app.press("id:plan-full-toggle");
  await app.waitFor("id:plan-card-full", { state: "gone" });
  expect(app.texts()).toContain(t.project.planHint);
  await app.press("id:plan-full-toggle");
  await app.waitFor("id:plan-card-full");
  await app.press("id:plan-keep");
  await app.waitUntil(() => app.texts().includes("plan:kept"));
  await app.waitFor("id:plan-card-full", { state: "gone" });
});
