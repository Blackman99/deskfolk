/**
 * A conversation shown to a focused window is read, as the messenger's is. NSH has no `document`,
 * so the reading gate cannot lean on the page: the window's own `lifecycle()` says whether it is
 * seen. Unread lines used to stay unread however long the conversation was open (a project session
 * kept its badge for days).
 */
import { expect, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

test("a conversation opened in a focused window is read once it has been on screen a moment", async () => {
  const app = await openApp({
    host: {
      handlers: {
        // What the shell answers the messenger's first questions (`notification_loop.rs`).
        "tauri.notification_permission_state": {
          permission: "default",
          nativeReadingV1: true,
          nativeDeliveryV1: false,
          operational: true,
          attentionCount: 0,
        },
        "tauri.take_notification_intent": null,
      },
    },
  });
  const writer = `id:session-${seeded.writerDirect}`;
  const editor = `id:session-${seeded.editorDirect}`;
  // The seeded reply is the Bot's, and nobody has read it.
  await app.waitFor(`${writer} >> id:unread-dot`, { timeout: 15_000 });
  await app.press(writer);
  await app.waitFor("text:帮我写个摘要", { timeout: 10_000 });
  // The shell's capabilities come at the first poll (every 5 s); the line is read a second later.
  await app.waitUntil(() => !app.shows(`${writer} >> id:unread-dot`), { timeout: 20_000 });
  // Gone for good, not hidden because the row is the open one.
  await app.press(editor);
  await app.wait(500);
  expect(app.shows(`${writer} >> id:unread-dot`)).toBe(false);
});

test("the shell hears which conversation you are looking at, and the beat keeps saying you are at its newest line", async () => {
  type Report = { sessionId: string | null; atLatest: boolean; visible: boolean; focused: boolean };
  const reports: Report[] = [];
  const app = await openApp({
    host: {
      handlers: {
        "tauri.notification_permission_state": {
          permission: "granted",
          nativeReadingV1: true,
          nativeDeliveryV1: true,
          operational: true,
          attentionCount: 0,
        },
        "tauri.take_notification_intent": null,
        // What the macOS shell does with it: tells the runtime, which holds back a banner for the
        // conversation in front of you (`notification_loop.rs` `report_view`).
        "tauri.report_notification_view": (args: unknown) => {
          reports.push((args as { report: Report }).report);
          return { visible: true, focused: true, minimized: false, effectiveFocused: true };
        },
      },
    },
  });
  const last = () => reports[reports.length - 1];
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitFor("text:帮我写个摘要", { timeout: 10_000 });
  await app.waitUntil(() => last()?.sessionId === seeded.writerDirect && last()?.atLatest === true, { timeout: 10_000 });
  expect(last()).toMatchObject({ visible: true, focused: true });
  // The five-second beat repeats it rather than taking it back.
  const before = reports.length;
  await app.waitUntil(() => reports.length > before, { timeout: 10_000 });
  expect(last()).toMatchObject({ sessionId: seeded.writerDirect, atLatest: true });
  // Another conversation picked: the report names it.
  await app.press(`id:session-${seeded.editorDirect}`);
  await app.waitUntil(() => last()?.sessionId === seeded.editorDirect, { timeout: 10_000 });
});
