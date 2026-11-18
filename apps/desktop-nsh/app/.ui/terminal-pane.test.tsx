/**
 * A terminal tab on a real runtime and a real shell: its head and Stop, no 结束会话, closing the tab
 * ending the session, a shell that exits, and the tools reattaching to one no tab shows. Skipped
 * when the runtime has no pty helper to start one (`seeded.pty`).
 *
 * The runtime's list is read where the app shows it: an empty pane lists every session no tab
 * shows under 可接回, so "没有可接回的终端" there means the runtime has forgotten the ones closed.
 */
import { expect, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openApp>>;
const shellTest = seeded.pty ? test : test.skip;
/** A tab's ×, by its name (`pane.closeTab`). */
const CLOSE_TAB = "label:关闭标签页";

/** A new terminal tab from the tools, as you would open one. */
async function newTerminal(app?: App): Promise<App> {
  const opened = app ?? (await openApp());
  const before = opened.count("id:pane-tab-icon-terminal");
  await opened.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  await opened.press("id:tools-toggle");
  await opened.press("id:tools-terminal");
  // A second one opens as a tab beside the first, so it is the tabs that count up.
  await opened.waitUntil(() => opened.count("id:pane-tab-icon-terminal") === before + 1, { timeout: 10_000 });
  await opened.waitFor("id:terminal-head", { timeout: 10_000 });
  return opened;
}

/** The tab is gone, and so is the session: nothing is left to reattach. */
async function forgotten(app: App): Promise<void> {
  await app.waitFor("id:terminal-head", { state: "gone", timeout: 10_000 });
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 0);
  await app.waitFor("text:没有可接回的终端", { timeout: 10_000 });
  expect(app.texts().some((text) => text.startsWith("接回 · "))).toBe(false);
}

shellTest("a running shell's tab says where it is, with Stop and no 结束会话; closing the tab ends the session", async () => {
  const app = await newTerminal();
  expect(app.shows("id:terminal-cwd")).toBe(true);
  expect(app.shows("id:terminal-stop")).toBe(true);
  expect(app.shows("id:terminal-status")).toBe(false);
  expect(app.shows("id:terminal-end")).toBe(false);
  expect(app.texts()).not.toContain("结束会话");
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);
  expect(app.count(CLOSE_TAB)).toBe(1);
  // The tab's × is the end: no question, and nothing left running to reattach.
  await app.press(CLOSE_TAB);
  await forgotten(app);
});

shellTest("closing one of two terminal tabs ends that shell only", async () => {
  const app = await newTerminal(await newTerminal());
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 2);
  // The tab in front, the second: a tab behind shows its × only under the mouse.
  await app.press(`${CLOSE_TAB} >> nth=1`);
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 1, { timeout: 10_000 });
  // The other is still running: its tab keeps Stop, and nothing waits under 可接回.
  await app.waitFor("id:terminal-stop");
  expect(app.texts().some((text) => text.startsWith("接回 · "))).toBe(false);
  await app.press(CLOSE_TAB);
  await forgotten(app);
});

shellTest("a shell that exits keeps its tab and says how it ended; closing the tab then forgets it", async () => {
  const app = await newTerminal();
  await app.press("id:terminal");
  // NSH's `Terminal` takes typed text in its hidden input, labelled as the terminal, and Return
  // from the keymap, as a keyboard's.
  await app.type("label:Terminal", "exit 3");
  await app.keyboard.press("enter");
  await app.waitFor("text:已结束 · 退出码 3", { timeout: 15_000 });
  expect(app.shows("id:terminal-stop")).toBe(false);
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);
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
  await phone.press("id:terminal");
  await phone.type("label:Terminal", "echo phone-$((6*7))");
  await phone.keyboard.press("enter");
  await phone.waitFor("text:phone-42", { timeout: 10_000 });

  // The desktop's own tab is a second shell; only the phone's is offered.
  const app = await newTerminal();
  const offered = () => app.texts().filter((text) => text.startsWith("接回 · "));
  await app.press("id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu");
  await app.waitUntil(() => offered().length === 1, { timeout: 10_000 });
  await app.press(`id:sidebar-tools-menu >> text:${offered()[0]}`);
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
  // A tab of its own, with the phone's screen read back; no shell was started for it.
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 2, { timeout: 10_000 });
  await app.waitFor("text:phone-42", { timeout: 10_000 });

  // Both have tabs now, so the tools offer neither.
  await app.press("id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu");
  expect(app.shows(`id:tools-terminal >> text:新建终端`)).toBe(true);
  expect(offered()).toEqual([]);
  await app.keyboard.press("escape");
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });

  // Closing both tabs ends both shells, the phone's too.
  await app.press(`${CLOSE_TAB} >> nth=1`);
  await app.waitUntil(() => app.count("id:pane-tab-icon-terminal") === 1, { timeout: 10_000 });
  await app.press(CLOSE_TAB);
  await forgotten(app);
});

shellTest("on Windows Ctrl+W in a terminal deletes a word in the shell, and Ctrl+Shift+W closes the tab", async () => {
  const app = await newTerminal(await openApp({ platform: "windows" }));
  await app.press("id:terminal");
  await app.type("label:Terminal", "echo zz-$((1+1)) tail");
  // readline's delete a word back: the tab stays, and with it the shell.
  await app.keyboard.press("ctrl+w");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().includes("zz-2"), { timeout: 10_000 });
  expect(app.texts()).not.toContain("zz-2 tail");
  expect(app.count("id:pane-tab-icon-terminal")).toBe(1);
  await app.keyboard.press("ctrl+shift+w");
  await forgotten(app);
});

shellTest("a paste reaches the shell as the program asks for it, and Return runs it", async () => {
  const app = await newTerminal();
  await app.press("id:terminal");
  // Through the terminal's `onPaste`: wrapped as a bracketed paste when the shell asks for one.
  await app.paste("label:Terminal", { text: "exit 7" });
  await app.keyboard.press("enter");
  await app.waitFor("text:已结束 · 退出码 7", { timeout: 15_000 });
  await app.press(CLOSE_TAB);
  await forgotten(app);
});
