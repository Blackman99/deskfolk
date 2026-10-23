import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aProjectSession, fakeRuntime } from "../test-fixtures.ts";
import { settle } from "../test-async.ts";
import { click, fieldErrors, fill } from "../test-render.ts";
import { render } from "../test-render.ts";
import ProjectSessionSheet from "./ProjectSessionSheet.svelte";

const t = copyFor("zh");
const listing = (session_id: string, cwd: string, minutesAgo: number, config_dir = "/Users/a/.claude") => ({
  session_id, config_dir, title: `title ${session_id}`, cwd, git_branch: null, modified_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), size: 1,
});

function open(stubs: Record<string, unknown> = {}, items = [listing("s1", "/Users/a/proj", 1), listing("s2", "/Users/a/other", 2), listing("s3", "/Users/a/proj", 3)], mode: "new" | "import" = "new") {
  // A directory you have only used in the app.
  const runtime = fakeRuntime({ sessions: [aProjectSession({ id: "p1", project_dir: "/Users/a/app-only", updated_at: "2020-01-01T00:00:00.000Z" })] }, stubs);
  (runtime as unknown as { client: unknown }).client = { claudeCodeSessions: async () => items };
  const view = render(ProjectSessionSheet, { runtime, t, mode, onClose: () => {} });
  return { ...view, runtime };
}

const dirNames = (host: Element) => [...host.querySelectorAll("[data-picker-dir] .picker-name")].map((n) => n.textContent);
const buttonIn = (root: Element | null | undefined, label: string) =>
  [...(root?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === label);
const head = (host: Element, dir: string) => host.querySelector(`[data-picker-dir="${dir}"] .picker-head`);

test("to start one: the agent first, then each directory once, newest first, one press away", async () => {
  const { host, runtime, close } = open();
  await settle();
  expect(host.querySelector("h2")?.textContent).toBe(t.project.newTitle);
  const agents = [...host.querySelectorAll("[data-project-agent]")];
  expect(agents.map((a) => a.getAttribute("data-project-agent"))).toEqual(["claude_code", "codex"]);
  expect(agents.map((a) => a.textContent?.trim())).toEqual(["Claude Code", "Codex"]);
  expect(agents[0]?.getAttribute("aria-checked")).toBe("true");
  expect(agents[0]?.querySelector("[data-agent-logo]")).not.toBeNull();
  expect(dirNames(host)).toEqual(["proj", "other", "app-only"]);
  // Nothing to carry on here: that is the other errand.
  expect(host.querySelectorAll("[data-claude-session]")).toHaveLength(0);
  click(host.querySelector('[data-picker-dir="/Users/a/other"] [data-picker-start]'));
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "claude_code", dir: "/Users/a/other" }]);
  close();
});

test("Codex starts in the same folders, with no terminal session to carry on", async () => {
  const { host, runtime, close } = open();
  await settle();
  click(host.querySelector('[data-project-agent="codex"]'));
  await settle();
  expect(host.querySelector('[data-project-agent="codex"]')?.getAttribute("aria-checked")).toBe("true");
  expect(dirNames(host)).toEqual(["proj", "other", "app-only"]);
  expect(host.querySelector(".picker-count")).toBeNull();
  click(host.querySelector('[data-picker-dir="/Users/a/proj"] [data-picker-start]'));
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "codex", dir: "/Users/a/proj" }]);
  close();
});

test("the sheet opens on the agent whose new session you chose", async () => {
  const runtime = fakeRuntime({ sessions: [] });
  (runtime as unknown as { client: unknown }).client = { claudeCodeSessions: async () => [] };
  const { host, close } = render(ProjectSessionSheet, { runtime, t, mode: "new", agent: "codex", onClose: () => {} });
  await settle();
  expect(host.querySelector('[data-project-agent="codex"]')?.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain(t.project.dirHints.codex);
  close();
  // Importing has only Claude Code to carry on, whatever was chosen before.
  const again = render(ProjectSessionSheet, { runtime, t, mode: "import", agent: "codex", onClose: () => {} });
  await settle();
  expect(again.host.querySelector('[data-project-agent="claude_code"]')?.getAttribute("aria-checked")).toBe("true");
  again.close();
});

test("to carry one on: only directories with terminal sessions, each opening to its own, one at a time", async () => {
  const { host, close } = open({}, undefined, "import");
  await settle();
  expect(host.querySelector("h2")?.textContent).toBe(t.project.importTitle);
  // Only Claude Code's terminal sessions can be carried on so far.
  expect([...host.querySelectorAll("[data-project-agent]")].map((a) => a.getAttribute("data-project-agent"))).toEqual(["claude_code"]);
  // The app-only directory has nothing to carry on; there is no directory of your own to type.
  expect(dirNames(host)).toEqual(["proj", "other"]);
  expect(host.querySelector("[data-picker-other]")).toBeNull();
  expect(host.querySelector("[data-picker-start]")).toBeNull();
  expect(host.querySelector('[data-picker-dir="/Users/a/proj"] .picker-count')?.textContent).toBe("2");
  click(head(host, "/Users/a/proj"));
  expect([...host.querySelectorAll("[data-claude-session]")].map((r) => r.getAttribute("data-claude-session"))).toEqual(["s1", "s3"]);
  click(head(host, "/Users/a/other"));
  expect([...host.querySelectorAll("[data-claude-session]")].map((r) => r.getAttribute("data-claude-session"))).toEqual(["s2"]);
  close();
});

test("picking a terminal session and pressing 接着聊 carries it on", async () => {
  const { host, runtime, close } = open({}, undefined, "import");
  await settle();
  click(head(host, "/Users/a/other"));
  click(host.querySelector('[data-claude-session="s2"]'));
  click(buttonIn(host.querySelector("[data-import-form]"), t.sidebar.importClaudeSubmit));
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([
    { agent: "claude_code", import: { session_id: "s2", config_dir: "/Users/a/.claude" } },
  ]);
  close();
});

test("a directory with many sessions shows the newest first and the rest on asking", async () => {
  const many = Array.from({ length: 11 }, (_, i) => listing(`m${i}`, "/Users/a/big", i));
  const { host, close } = open({}, many, "import");
  await settle();
  click(head(host, "/Users/a/big"));
  expect([...host.querySelectorAll("[data-claude-session]")].map((r) => r.getAttribute("data-claude-session"))).toEqual(many.slice(0, 8).map((m) => m.session_id));
  click(buttonIn(host.querySelector('[data-picker-dir="/Users/a/big"]'), t.project.showMore(3)));
  expect(host.querySelectorAll("[data-claude-session]")).toHaveLength(11);
  close();
});

test("a row names its account only when the list holds more than one", async () => {
  const { host, close } = open({}, [listing("s1", "/Users/a/proj", 1), listing("s2", "/Users/a/proj", 2, "/Users/a/.claude-b")], "import");
  await settle();
  click(head(host, "/Users/a/proj"));
  const metas = [...host.querySelectorAll("[data-claude-session] .import-meta")].map((m) => m.textContent);
  expect(metas[0]?.startsWith("~/.claude ·")).toBe(true);
  expect(metas[1]?.startsWith("~/.claude-b ·")).toBe(true);
  close();
});

test("nothing in the terminal to carry on says so", async () => {
  const { host, close } = open({}, [], "import");
  await settle();
  expect(host.querySelectorAll("[data-picker-dir]")).toHaveLength(0);
  expect(host.textContent).toContain(t.sidebar.importClaudeEmpty);
  close();
});

test("another directory: a relative path is refused before it goes, an absolute one starts", async () => {
  const { host, runtime, close } = open();
  await settle();
  click(host.querySelector("[data-picker-other] .picker-head"));
  const other = host.querySelector("[data-picker-other]");
  fill(host.querySelector("#project-dir"), "proj");
  click(buttonIn(other, t.project.start));
  expect(fieldErrors(host)).toEqual([t.project.dirInvalid]);
  expect(runtime.calls.filter((c) => c.name === "createProjectSession")).toHaveLength(0);
  fill(host.querySelector("#project-dir"), "/Users/a/new");
  click(buttonIn(other, t.project.start));
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "claude_code", dir: "/Users/a/new" }]);
  close();
});

test("a 422 from the daemon reads as an unusable directory", async () => {
  const failure = Object.assign(new Error("bad"), { status: 422 });
  const { host, close } = open({ createProjectSession: () => Promise.resolve(failure) });
  await settle();
  click(host.querySelector('[data-picker-dir="/Users/a/proj"] [data-picker-start]'));
  await settle();
  expect(fieldErrors(host)).toEqual([t.project.dirInvalid]);
  close();
});

test("with nothing to list, the typed directory is open", async () => {
  const runtime = fakeRuntime({ sessions: [] });
  (runtime as unknown as { client: unknown }).client = { claudeCodeSessions: async () => [] };
  const { host, close } = render(ProjectSessionSheet, { runtime, t, onClose: () => {} });
  await settle();
  expect(host.querySelectorAll("[data-picker-dir]")).toHaveLength(0);
  expect(host.querySelector("#project-dir")).not.toBeNull();
  close();
});

test("while the listing is on the way only the hint shows, so nothing moves under the pointer", async () => {
  const runtime = fakeRuntime({ sessions: [aProjectSession({ project_dir: "/Users/a/app-only" })] });
  (runtime as unknown as { client: unknown }).client = { claudeCodeSessions: () => new Promise(() => {}) };
  const { host, close } = render(ProjectSessionSheet, { runtime, t, onClose: () => {} });
  await settle();
  expect(host.querySelectorAll("[data-picker-dir]")).toHaveLength(0);
  expect(host.textContent).toContain(t.sidebar.importClaudeLoading);
  close();
});

test("from a phone, another directory is browsed on the computer's disk and started there", async () => {
  const pages: Record<string, { path: string; parent: string | null; truncated: boolean; items: Array<{ name: string; path: string; kind: "file" | "dir" }> }> = {
    "": { path: "/Users/a", parent: "/Users", truncated: false, items: [{ name: "work", path: "/Users/a/work", kind: "dir" }, { name: "notes.md", path: "/Users/a/notes.md", kind: "file" }] },
    "/Users/a/work": { path: "/Users/a/work", parent: "/Users/a", truncated: false, items: [{ name: "app", path: "/Users/a/work/app", kind: "dir" }] },
  };
  const asked: string[] = [];
  const runtime = fakeRuntime({ sessions: [] });
  Object.assign(runtime as unknown as Record<string, unknown>, {
    remote: true,
    client: { claudeCodeSessions: async () => [], hostTree: async (path: string) => (asked.push(path), pages[path]) },
  });
  const { host, close } = render(ProjectSessionSheet, { runtime, t, onClose: () => {} });
  await settle();
  // No folder dialog on a phone, and no path to type: a browse of the computer's folders instead.
  expect(host.querySelector("input#project-dir")).toBeNull();
  const browse = host.querySelector("button#project-dir");
  expect(browse?.textContent).toContain(t.project.browseEmpty);
  click(browse);
  await settle();
  const dirs = () => [...host.querySelectorAll(".host-browse-item")].map((b) => b.textContent?.trim());
  expect(dirs()).toEqual(["work"]);
  click([...host.querySelectorAll(".host-browse-item")][0]);
  await settle();
  expect(asked).toEqual(["", "/Users/a/work"]);
  click(buttonIn(host.querySelector(".host-browse"), t.settings.workspaceUseFolder));
  await settle();
  // Home reads as ~, the whole path on hover.
  expect(host.querySelector("button#project-dir")?.textContent?.trim()).toBe("~/work");
  expect(host.querySelector("button#project-dir")?.getAttribute("title")).toBe("/Users/a/work");
  click(buttonIn(host.querySelector("[data-picker-other]"), t.project.start));
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "claude_code", dir: "/Users/a/work" }]);
  close();
});
