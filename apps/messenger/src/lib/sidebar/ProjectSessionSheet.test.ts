import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { settle } from "../test-async.ts";
import { click, fieldErrors, fill } from "../test-render.ts";
import { render } from "../test-render.ts";
import ProjectSessionSheet from "./ProjectSessionSheet.svelte";

const t = copyFor("zh");
const listing = (session_id: string, cwd: string) => ({ session_id, config_dir: "/Users/a/.claude", title: `title ${session_id}`, cwd, git_branch: null, modified_at: new Date().toISOString(), size: 1 });

function open(stubs: Record<string, unknown> = {}) {
  const runtime = fakeRuntime({}, stubs);
  (runtime as unknown as { client: unknown }).client = {
    claudeCodeSessions: async () => [listing("s1", "/Users/a/proj"), listing("s2", "/Users/a/other"), listing("s3", "/Users/a/proj")],
  };
  const view = render(ProjectSessionSheet, { runtime, t, onClose: () => {} });
  return { ...view, runtime };
}

test("recent directories are offered as chips and fill the field", async () => {
  const { host, close } = open();
  await settle();
  const chips = [...host.querySelectorAll("[data-project-recent] .recent-chip")];
  expect(chips.map((c) => c.textContent)).toEqual(["~/proj", "~/other"]);
  click(chips[1]);
  expect((host.querySelector("#project-dir") as HTMLInputElement).value).toBe("/Users/a/other");
  close();
});

test("Start sends the directory; a relative path is refused before it goes", async () => {
  const { host, runtime, close } = open();
  await settle();
  const start = [...host.querySelectorAll("[data-project-new] button")].find((b) => b.textContent?.trim() === t.project.start);
  fill(host.querySelector("#project-dir"), "proj");
  click(start);
  expect(fieldErrors(host)).toEqual([t.project.dirInvalid]);
  expect(runtime.calls.filter((c) => c.name === "createProjectSession")).toHaveLength(0);
  fill(host.querySelector("#project-dir"), "/Users/a/proj");
  click(start);
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "claude_code", dir: "/Users/a/proj" }]);
  close();
});

test("a 422 from the daemon reads as an unusable directory", async () => {
  const failure = Object.assign(new Error("bad"), { status: 422 });
  const { host, close } = open({ createProjectSession: () => Promise.resolve(failure) });
  await settle();
  fill(host.querySelector("#project-dir"), "/nope");
  click([...host.querySelectorAll("[data-project-new] button")].find((b) => b.textContent?.trim() === t.project.start));
  await settle();
  expect(fieldErrors(host)).toEqual([t.project.dirInvalid]);
  close();
});

test("picking a terminal session and pressing 接着聊 carries it on", async () => {
  const { host, runtime, close } = open();
  await settle();
  click(host.querySelector('[data-claude-session="s2"]'));
  click([...host.querySelectorAll("[data-import-form] button")].find((b) => b.textContent?.trim() === t.sidebar.importClaudeSubmit));
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([
    { agent: "claude_code", import: { session_id: "s2", config_dir: "/Users/a/.claude" } },
  ]);
  close();
});
