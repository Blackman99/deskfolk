/**
 * The terminal page of a phone (here a window 390 points wide, which takes the same page) on a real
 * runtime and real shells: it reattaches to a shell already there, the desktop's included; it
 * starts one only when none runs; it comes back to the one it showed; leaving it ends nothing; the
 * list switches and ends sessions; the key bar's keys reach the shell. Skipped without a pty
 * helper (`seeded.pty`).
 *
 * The runtime outlives each test, so each one ends the shells it made before it finishes.
 */
import { expect, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openApp>>;
const shellTest = seeded.pty ? test : test.skip;
const PHONE = { width: 390, height: 844 };

/** Runs `line` in the shell on screen: typed into the terminal, Return from the keymap. */
async function run(app: App, line: string): Promise<void> {
  await app.press("id:terminal");
  await app.type("label:Terminal", line);
  await app.keyboard.press("enter");
}

/** The phone's terminal page, from the tools beside the search. */
async function openPage(app: App): Promise<void> {
  await app.press("id:tools-toggle");
  await app.press("id:tools-terminal");
  await app.waitFor("id:terminal-page", { timeout: 10_000 });
  await app.waitFor("id:terminal", { timeout: 15_000 });
}

async function phone(): Promise<App> {
  const app = await openApp(PHONE);
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  return app;
}

/** Ends every session from the page's list, the running ones after a second press. */
async function endAll(app: App): Promise<void> {
  await app.press("id:terminal-title");
  await app.waitFor("id:terminal-sessions");
  while (app.count("id:terminal-sessions >> text:结束会话") > 0) {
    const before = app.count("id:terminal-sessions >> text:结束会话");
    await app.press("id:terminal-sessions >> text:结束会话 >> nth=0");
    if (app.shows("id:terminal-end-note")) await app.press("id:terminal-sessions >> text:结束会话 >> nth=0");
    await app.waitUntil(() => app.count("id:terminal-sessions >> text:结束会话") < before, { timeout: 10_000 });
  }
}

shellTest("the page reattaches to the shell the desktop has open, and leaving it leaves that shell running", async () => {
  const desk = await openApp();
  await desk.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  await desk.press("id:tools-toggle");
  await desk.press("id:tools-terminal");
  await desk.waitFor("id:terminal-head", { timeout: 10_000 });
  await run(desk, "echo desk-$((40+2))");
  await desk.waitFor("text:desk-42", { timeout: 10_000 });

  const app = await phone();
  await openPage(app);
  // The desktop's shell, its screen read back: no second shell was started beside it.
  await app.waitFor("text:desk-42", { timeout: 10_000 });
  expect(app.shows("id:terminal-count")).toBe(false);
  expect(app.shows("id:terminal-keys")).toBe(true);
  await app.press("id:terminal-back");
  await app.waitFor("id:terminal-page", { state: "gone" });

  // Still running: the desktop's tab keeps Stop. Its × is what ends it.
  await desk.waitFor("id:terminal-stop");
  await desk.press("label:关闭标签页");
  await desk.waitFor("text:没有可接回的终端", { timeout: 10_000 });
});

shellTest("with nothing running the page starts one shell, and coming back reattaches to it", async () => {
  const app = await phone();
  await openPage(app);
  await run(app, "echo phone-$((1+1))");
  await app.waitFor("text:phone-2", { timeout: 10_000 });
  await app.press("id:terminal-back");
  await app.waitFor("id:terminal-page", { state: "gone" });
  await openPage(app);
  await app.waitFor("text:phone-2", { timeout: 10_000 });
  expect(app.shows("id:terminal-count")).toBe(false);
  await endAll(app);
  // Ended from the page, the last one leaves it empty, offering a new one rather than starting it.
  await app.waitFor("id:terminal-empty", { timeout: 10_000 });
});

shellTest("+ starts another; the page comes back to the one it showed last, and the list switches", async () => {
  const app = await phone();
  await openPage(app);
  await run(app, "echo first-$((3+4))");
  await app.waitFor("text:first-7", { timeout: 10_000 });
  await app.press("id:terminal-new");
  await app.waitFor("id:terminal-count", { timeout: 10_000 });
  await app.waitUntil(() => !app.texts().includes("first-7"), { timeout: 10_000 });
  await app.press("id:terminal-back");
  await openPage(app);
  // The second, which was on screen when the page closed.
  expect(app.texts()).not.toContain("first-7");
  await app.press("id:terminal-title");
  await app.waitFor("id:terminal-sessions");
  await app.press("id:terminal-sessions >> label:workspace");
  await app.waitFor("text:first-7", { timeout: 10_000 });
  await endAll(app);
  await app.waitFor("id:terminal-empty", { timeout: 10_000 });
});

shellTest("the key bar's keys reach the shell, Ctrl latched for the next key typed", async () => {
  const app = await phone();
  await openPage(app);
  await run(app, "cat -v");
  // Esc then Return from the bar: `cat -v` writes the escape back as ^[.
  await app.press("id:terminal-key-esc");
  await app.press("id:terminal-key-enter");
  await app.waitUntil(() => app.texts().some((line) => line.startsWith("^[")), { timeout: 10_000 });
  // Ctrl, then c on the keyboard: ^C ends `cat`, and the shell takes the next line.
  await app.press("id:terminal-key-ctrl");
  await app.press("id:terminal");
  await app.type("label:Terminal", "c");
  await run(app, "echo after-$((2*3))");
  await app.waitFor("text:after-6", { timeout: 10_000 });
  await endAll(app);
});
