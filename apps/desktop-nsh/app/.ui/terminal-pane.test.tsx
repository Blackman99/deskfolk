/**
 * A terminal tab on a real runtime and a real shell: its head with Stop and 结束会话; closing the
 * tab or its pane only putting the shell away, to be reattached with its screen; 结束会话 asking
 * once more while the shell runs; a shell that exits; and the tools reattaching to one no tab
 * shows. Skipped when the runtime has no pty helper to start one (`seeded.pty`).
 *
 * The runtime's list is read where the app shows it: an empty pane lists every session no tab
 * shows under 可接回, so "没有可接回的终端" there means the runtime has forgotten the ones ended.
 * The runtime outlives each test, so each one ends the shells it made before it finishes.
 */
import { expect, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openApp>>;
const shellTest = seeded.pty ? test : test.skip;
/** A tab's ×, by its name (`pane.closeTab`). */
const CLOSE_TAB = "label:关闭标签页";

/** A new terminal tab from the tools (工具 › 终端 › 新建终端), as you would open one. */
async function newTerminal(app?: App): Promise<App> {
  const opened = app ?? (await openApp());
  const before = opened.count("id:pane-tab-icon-terminal");
  await opened.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  await opened.press("id:tools-toggle");
  await opened.press("id:tools-terminal");
  await opened.press("id:tools-terminal-new");
  // A second one opens as a tab beside the first, so it is the tabs that count up.
  await opened.waitUntil(() => opened.count("id:pane-tab-icon-terminal") === before + 1, { timeout: 10_000 });
  await opened.waitFor("id:terminal-head", { timeout: 10_000 });
  return opened;
}

/** Runs `line` in the shell in front: typed into the terminal, Return from the keymap. */
async function run(app: App, line: string): Promise<void> {
  await app.press("id:terminal");
  // NSH's `Terminal` takes typed text in its hidden input, labelled as the terminal, and Return
  // from the keymap, as a keyboard's.
  await app.type("label:Terminal", line);
  await app.keyboard.press("enter");
}

/**
 * The empty pane's rows under 可接回, one per shell no tab shows, by the folder each row shows under
 * its name (a path ending in the fixture's `workspace`; the names have no slash). A `text:` that
 * starts with a slash is a regular expression.
 */
const REATTACH_ROW = "id:wb-new-pane-menu >> text:/\\/workspace$/";
const reattachCount = (app: App): number => app.count(REATTACH_ROW);

/** Reattaches to the first shell the empty pane offers, in a tab there. */
async function reattachFirst(app: App): Promise<void> {
  await app.press(`${REATTACH_ROW} >> nth=0`);
}

/** 结束会话 in the head of the tab in front, confirmed when the shell still runs; its tab goes. */
async function endShell(app: App): Promise<void> {
  const before = app.count("id:pane-tab-icon-terminal");
  const running = app.shows("id:terminal-stop");
  await app.press("id:terminal-end");
  if (running) {
    await app.waitFor("id:terminal-end-confirm");
    await app.press("id:terminal-end-confirm");
  }
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === before - 1, { timeout: 10_000 });
}

/** The tab is gone, and so is the session: nothing is left to reattach. */
async function forgotten(app: App): Promise<void> {
  await app.waitFor("id:terminal-head", { state: "gone", timeout: 10_000 });
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 0);
  await app.waitFor("text:没有可接回的终端", { timeout: 10_000 });
  expect(reattachCount(app)).toBe(0);
}

shellTest("closing a running shell's tab only puts it away: the tools reattach to it, screen and all", async () => {
  const app = await newTerminal();
  expect(app.shows("id:terminal-cwd")).toBe(true);
  expect(app.shows("id:terminal-stop")).toBe(true);
  expect(app.shows("id:terminal-end")).toBe(true);
  expect(app.shows("id:terminal-status")).toBe(false);
  await run(app, "echo kept-$((40+2))");
  await app.waitFor("text:kept-42", { timeout: 10_000 });

  // The tab's × asks nothing and ends nothing: the shell waits under 接回.
  await app.press(CLOSE_TAB);
  await app.waitFor("id:terminal-head", { state: "gone", timeout: 10_000 });
  expect(app.count("id:pane-tab-icon-terminal")).toBe(0);
  await app.waitUntil(() => reattachCount(app) === 1, { timeout: 10_000 });

  await app.press("id:tools-toggle");
  await app.press("id:tools-terminal");
  await app.waitUntil(() => app.count("id:tools-reattach") === 1, { timeout: 10_000 });
  await app.press("id:tools-reattach");
  await app.waitFor("id:terminal-head", { timeout: 10_000 });
  // The same shell, still running, with what it printed before.
  await app.waitFor("text:kept-42", { timeout: 10_000 });
  expect(app.shows("id:terminal-stop")).toBe(true);
  await endShell(app);
  await forgotten(app);
});

shellTest("closing the pane a running shell is in leaves it running, and the empty pane reattaches to it", async () => {
  const app = await newTerminal();
  await run(app, "echo pane-$((30+3))");
  await app.waitFor("text:pane-33", { timeout: 10_000 });
  // The terminal opened beside the empty pane the window starts with, so its own pane can close.
  expect(app.count("id:wb-empty")).toBe(1);
  await app.rightClick("id:pane-tab-icon-terminal");
  await app.waitFor("id:wb-context-menu");
  await app.press("id:wb-close-pane");
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 0, { timeout: 10_000 });
  expect(app.count("id:wb-empty")).toBe(1);

  await app.waitUntil(() => reattachCount(app) === 1, { timeout: 10_000 });
  await reattachFirst(app);
  await app.waitFor("id:terminal-head", { timeout: 10_000 });
  await app.waitFor("text:pane-33", { timeout: 10_000 });
  expect(app.shows("id:terminal-stop")).toBe(true);
  await endShell(app);
  await forgotten(app);
});

shellTest("结束会话 on a running shell asks once more: Cancel keeps it, confirming ends it and its tab", async () => {
  const app = await newTerminal();
  await app.press("id:terminal-end");
  await app.waitFor("id:terminal-end-confirm");
  expect(app.texts()).toContain("结束后里面跑着的进程会一起停。");
  await app.press("id:terminal-end-cancel");
  await app.waitFor("id:terminal-end-confirm", { state: "gone" });
  expect(app.shows("id:terminal-stop")).toBe(true);
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);

  await app.press("id:terminal-end");
  await app.press("id:terminal-end-confirm");
  await forgotten(app);
});

shellTest("a shell that exits keeps its tab and says how it ended; closing the tab then forgets it", async () => {
  const app = await newTerminal();
  await run(app, "exit 3");
  await app.waitFor("text:已结束 · 退出码 3", { timeout: 15_000 });
  expect(app.shows("id:terminal-stop")).toBe(false);
  expect(app.shows("id:terminal-end")).toBe(true);
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);
  // Nothing runs any more, so nothing waits under 接回 once its tab is closed.
  await app.press(CLOSE_TAB);
  await forgotten(app);
});

shellTest("the tools offer a shell no tab shows, never a tab's own, and reattach to it in a tab", async () => {
  // A shell the phone's terminal page started: no desktop tab shows it.
  const phone = await openApp({ width: 390, height: 844 });
  await phone.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  await phone.press("id:tools-toggle");
  await phone.press("id:tools-terminal");
  await phone.waitFor("id:terminal", { timeout: 15_000 });
  await run(phone, "echo phone-$((6*7))");
  await phone.waitFor("text:phone-42", { timeout: 10_000 });

  // The desktop's own tab is a second shell; only the phone's is offered, under 终端.
  const app = await newTerminal();
  await app.press("id:tools-toggle");
  await app.press("id:tools-terminal");
  await app.waitFor("id:tools-terminal-menu");
  await app.waitUntil(() => app.count("id:tools-reattach") === 1, { timeout: 10_000 });
  await app.press("id:tools-reattach");
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
  // A tab of its own, with the phone's screen read back; no shell was started for it.
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 2, { timeout: 10_000 });
  await app.waitFor("text:phone-42", { timeout: 10_000 });

  // Both have tabs now, so the tools offer neither.
  await app.press("id:tools-toggle");
  await app.press("id:tools-terminal");
  await app.waitFor("id:tools-terminal-none");
  expect(app.count("id:tools-reattach")).toBe(0);
  await app.keyboard.press("escape");
  await app.waitFor("id:tools-terminal-menu", { state: "gone" });
  await app.keyboard.press("escape");
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });

  // Each ended from its own head: the phone's in front, then the desktop's.
  await endShell(app);
  await app.waitFor("id:terminal-head", { timeout: 10_000 });
  await endShell(app);
  await forgotten(app);
});

shellTest("on Windows Ctrl+W in a terminal deletes a word in the shell, and Ctrl+Shift+W puts the tab away", async () => {
  const app = await newTerminal(await openApp({ platform: "windows" }));
  await app.press("id:terminal");
  await app.type("label:Terminal", "echo zz-$((1+1)) tail");
  // readline's delete a word back: the tab stays, and with it the shell.
  await app.keyboard.press("ctrl+w");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().includes("zz-2"), { timeout: 10_000 });
  expect(app.texts()).not.toContain("zz-2 tail");
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);
  // Ctrl+Shift+W closes the tab; the shell runs on under 接回.
  await app.keyboard.press("ctrl+shift+w");
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 0, { timeout: 10_000 });
  await app.waitUntil(() => reattachCount(app) === 1, { timeout: 10_000 });
  await reattachFirst(app);
  await app.waitFor("text:zz-2", { timeout: 10_000 });
  await endShell(app);
  await forgotten(app);
});

shellTest("a paste reaches the shell as the program asks for it, and 结束会话 forgets a finished shell at once", async () => {
  const app = await newTerminal();
  await app.press("id:terminal");
  // Through the terminal's `onPaste`: wrapped as a bracketed paste when the shell asks for one.
  await app.paste("label:Terminal", { text: "exit 7" });
  await app.keyboard.press("enter");
  await app.waitFor("text:已结束 · 退出码 7", { timeout: 15_000 });
  // Nothing runs, so one press ends it: no question.
  await app.press("id:terminal-end");
  expect(app.shows("id:terminal-end-confirm")).toBe(false);
  await forgotten(app);
});
