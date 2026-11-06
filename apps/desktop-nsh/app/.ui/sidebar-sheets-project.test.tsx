import { expect, open, test } from "nsh/test";
import { openStory, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

async function story(picked?: string | null) {
  const endpoint = { origin: seeded.origin, token: seeded.token };
  const asked: unknown[] = [];
  const app = await open("../Story.tsx", {
    platform: "macos",
    width: 1100,
    height: 900,
    locale: "zh-CN",
    network: "live",
    host: {
      params: { ...endpoint, windowId: 1, material: "none", story: "sidebar-sheets" },
      handlers: {
        "tauri.local_api_endpoint": endpoint,
        "tauri.app_version": "0.0.0",
        "tauri.window_material": "none",
        "tauri.pick_workspace_folder": (args: unknown) => (asked.push(args), picked ?? null),
      },
    },
  });
  await app.waitFor("id:story-read", { timeout: 15_000 });
  return { app, asked };
}

const projects = async (app: App) => {
  await app.press("id:story-read");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith('{"bots"')));
  return (JSON.parse(app.texts().find((t) => t.startsWith('{"bots"'))!) as { projects: { dir: string; agent: string }[] }).projects;
};

/** The typed directory's panel: open already when there is nothing else to list, else one press. */
async function openOther(app: App) {
  await app.waitFor("id:picker-other-head", { timeout: 10_000 });
  if (!app.shows("id:project-dir")) await app.press("id:picker-other-head");
  await app.waitFor("id:project-dir");
}

test("the project sheet offers both agents, Claude Code first and chosen", async () => {
  const { app } = await story();
  await app.press("id:story-open-project");
  await app.waitFor("id:project-session-sheet");
  expect(app.texts()).toContain("新开项目会话");
  await app.waitFor("id:project-agent-claude_code");
  expect(app.shows("id:project-agent-codex")).toBe(true);
  await app.waitFor("id:project-dirs");
  // The typed directory can always be started from.
  await openOther(app);
  expect(app.enabled("id:project-start")).toBe(false);
});

test("it opens on the agent whose new session was chosen", async () => {
  const { app } = await story();
  await app.press("id:story-open-codex");
  await app.waitFor("id:project-agent-codex");
  await app.waitFor("id:project-dirs");
  await openOther(app);
  // Codex's hint, not Claude Code's.
  await app.press("id:project-agent-claude_code");
  await app.waitFor("id:project-dirs");
});

test("a typed directory starts a session there; a relative one is refused on the spot", async () => {
  const { app } = await story();
  await app.press("id:story-open-project");
  await openOther(app);
  await app.type("id:project-dir", "not/absolute");
  await app.press("id:project-start");
  await app.waitFor("id:project-error");
  expect(app.texts()).toContain("这个目录用不了：填电脑上已有目录的完整路径（以 / 开头）。");
  // Typing clears the error.
  await app.type("id:project-dir", "x");
  await app.waitFor("id:project-error", { state: "gone" });
  await app.clear("id:project-dir");
  await app.type("id:project-dir", seeded.workspace);
  await app.press("id:project-start");
  await app.waitFor("id:project-session-sheet", { state: "gone" });
  expect((await projects(app)).some((p) => p.dir === seeded.workspace && p.agent === "claude_code")).toBe(true);
});

test("the folder dialog's answer lands in the field", async () => {
  const { app, asked } = await story(seeded.workspace);
  await app.press("id:story-open-project");
  await openOther(app);
  await app.waitFor("id:project-pick");
  await app.press("id:project-pick");
  await app.waitUntil(() => asked.length === 1);
  expect(JSON.stringify(asked[0])).toContain("选择");
  await app.waitUntil(() => app.value("id:project-dir") === seeded.workspace);
  expect(app.enabled("id:project-start")).toBe(true);
});

test("carrying a terminal session on: Claude Code only, directories that have sessions", async () => {
  const { app } = await story();
  await app.press("id:story-open-import");
  await app.waitFor("id:project-session-sheet");
  expect(app.texts()).toContain("导入终端会话");
  await app.waitFor("id:project-agent-claude_code");
  // Codex cannot carry a terminal session on.
  expect(app.shows("id:project-agent-codex")).toBe(false);
  await app.waitFor("id:project-dirs");
  // No typed directory in this errand.
  expect(app.shows("id:picker-other")).toBe(false);
  expect(app.shows("id:project-new")).toBe(false);
  // Whatever the terminal holds, the sheet lists directories or says there is nothing.
  await app.waitUntil(() => app.texts().includes("没找到可以接着聊的 Claude Code 会话。") || app.texts().some(() => false) || app.count("id:project-dirs") > 0);
});
