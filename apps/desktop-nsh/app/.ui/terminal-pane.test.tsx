/**
 * A terminal tab on a real runtime and a real shell: its head, Stop, 结束会话 behind a second press,
 * and a shell that exits. Skipped when the runtime has no pty helper to start one (`seeded.pty`).
 *
 * The runtime's list is read where the app shows it: an empty pane lists every session no tab
 * shows under 可接回, so "没有可接回的终端" there means the runtime has forgotten the one ended.
 */
import { expect, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openApp>>;
const shellTest = seeded.pty ? test : test.skip;

/** A new terminal tab from the tools, as you would open one. */
async function newTerminal(): Promise<App> {
  const app = await openApp();
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  await app.press("id:tools-toggle");
  await app.press("id:tools-terminal");
  await app.waitFor("id:terminal-head", { timeout: 10_000 });
  return app;
}

/** The tab is gone, and so is the session: nothing is left to reattach. */
async function forgotten(app: App): Promise<void> {
  await app.waitFor("id:terminal-head", { state: "gone", timeout: 10_000 });
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 0);
  await app.waitFor("text:没有可接回的终端");
  expect(app.texts().some((text) => text.startsWith("接回 · "))).toBe(false);
}

shellTest("a running shell's tab says where it is; 结束会话 asks once more, then stops it and the tab goes", async () => {
  const app = await newTerminal();
  expect(app.shows("id:terminal-cwd")).toBe(true);
  expect(app.shows("id:terminal-stop")).toBe(true);
  expect(app.shows("id:terminal-status")).toBe(false);
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);
  // The first press only asks; Cancel takes it back and the shell runs on.
  await app.press("id:terminal-end");
  await app.waitFor("id:terminal-end-note");
  expect(app.texts()).toContain("结束后里面跑着的进程会一起停。");
  await app.press("id:terminal-end-cancel");
  await app.waitFor("id:terminal-end");
  expect(app.shows("id:terminal-end-note")).toBe(false);
  expect(app.shows("id:terminal-stop")).toBe(true);
  // The second press ends it: the runtime forgets it, and the workbench drops its tab.
  await app.press("id:terminal-end");
  await app.press("id:terminal-end-confirm");
  await forgotten(app);
});

shellTest("a shell that exits keeps its tab and says how it ended; 结束会话 then forgets it at once", async () => {
  const app = await newTerminal();
  await app.press("id:terminal");
  await app.type("id:terminal-keys", "exit 3\n");
  await app.waitFor("text:已结束 · 退出码 3", { timeout: 15_000 });
  expect(app.shows("id:terminal-stop")).toBe(false);
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);
  // Nothing is running, so there is nothing to ask about.
  await app.press("id:terminal-end");
  expect(app.shows("id:terminal-end-note")).toBe(false);
  await forgotten(app);
});
