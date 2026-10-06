/**
 * Changing a line of yours in its own bubble (ADR 0063): offered on your plain lines only, from the
 * menu and the hover bar; the bubble turns into the editor and back; 「已编辑」 beside the time
 * opens what the line said before; and inside the editor the browser's own menu and selection work.
 */
import { expect, test } from "bun:test";
import type { Message, SessionSummary } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const t = copyFor("zh");

function stage(messages: Message[], opts: { messageEdits?: boolean; session?: SessionSummary; stubs?: Record<string, unknown> } = {}) {
  const session = opts.session ?? aDirect();
  const lines = messages.map((message) => ({ ...message, session_id: session.id }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: "bot-1" })], sessions: [session], messages: lines, turns: [], messageEdits: opts.messageEdits ?? true,
  }, { selectedId: session.id, ...opts.stubs }));
  const view = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  const segment = (id: string) => view.host.querySelector(`[data-message-id="${id}"]`)!;
  const menuFor = (id: string) => {
    segment(id).querySelector(".msg")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    flushSync();
    return [...view.host.querySelectorAll(".msg-context-menu-item")].map((item) => item.textContent?.trim());
  };
  return { ...view, runtime, session, segment, menuFor };
}

const yours = (over: Partial<Message> = {}) =>
  aMessage({ id: "line-1", kind: "user", author: "user", body: "片长 30 秒", created_at: "2026-10-06T02:00:00.000Z", ...over });

test("your plain line offers 编辑 in its menu and on its hover bar; a Bot's line, a line the app took, and an older daemon offer none", () => {
  const reply = aMessage({ id: "reply-1", kind: "bot", author: "bot-1", body: "好", created_at: "2026-10-06T02:00:01.000Z" });
  const stop = yours({ id: "stop-1", body: "停下", taken_as: "app", created_at: "2026-10-06T02:00:02.000Z" });
  const s = stage([yours(), reply, stop]);
  try {
    expect(s.menuFor("line-1")).toContain(t.chat.editMessage);
    expect(s.segment("line-1").querySelector(`.msg-toolbar-pill [title="${t.chat.editMessage}"]`)).not.toBeNull();
    expect(s.menuFor("reply-1")).not.toContain(t.chat.editMessage);
    expect(s.menuFor("stop-1")).not.toContain(t.chat.editMessage);
    expect(s.segment("stop-1").querySelector(`.msg-toolbar-pill [title="${t.chat.editMessage}"]`)).toBeNull();
  } finally {
    s.close();
  }
  const older = stage([yours()], { messageEdits: false });
  try {
    expect(older.menuFor("line-1")).not.toContain(t.chat.editMessage);
  } finally {
    older.close();
  }
});

test("编辑 turns the bubble into the editor on its words; Enter saves, Esc puts the line back", () => {
  const s = stage([yours()]);
  try {
    s.menuFor("line-1");
    click(buttonByText(s.host, t.chat.editMessage));
    const field = s.segment("line-1").querySelector<HTMLTextAreaElement>(".msg-editor textarea")!;
    expect(field.value).toBe("片长 30 秒");
    expect(s.segment("line-1").querySelector(".msg.is-editing")).not.toBeNull();
    fill(field, "片长 45 秒");
    expect(s.runtime.sessionView(s.session.id).editDraft).toBe("片长 45 秒");
    press(field, "Enter");
    press(field, "Escape");
    expect(s.segment("line-1").querySelector(".msg-editor")).toBeNull();
    expect(s.segment("line-1").textContent).toContain("片长 30 秒");
    // Read once, after everything: the fake's call list does not follow pushes after a first read.
    const calls = s.runtime.calls.map((call) => [call.name, ...call.args.filter((arg) => typeof arg === "string")]);
    expect(calls.filter(([name]) => name === "saveEdit" || name === "cancelEdit")).toEqual([["saveEdit", s.session.id], ["cancelEdit", s.session.id]]);
  } finally {
    s.close();
  }
});

test("inside the editor a right-click or long-press is the system's: no message menu, nothing prevented", () => {
  const s = stage([yours()]);
  try {
    s.runtime.startEdit(s.session.id, yours());
    flushSync();
    const field = s.segment("line-1").querySelector<HTMLTextAreaElement>(".msg-editor textarea")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
    field.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    field.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    field.dispatchEvent(menu);
    flushSync();
    expect(menu.defaultPrevented).toBe(false);
    expect(s.host.querySelector(".msg-context-menu")).toBeNull();
  } finally {
    s.close();
  }
});

test("a changed line says 已编辑 beside its time, which opens what it said before, newest first", async () => {
  const versions = [
    { body: "片长 30 秒", created_at: "2026-10-06T02:00:00.000Z" },
    { body: "片长 40 秒", created_at: "2026-10-06T02:01:00.000Z" },
  ];
  const s = stage([yours({ body: "片长 45 秒", edited_at: "2026-10-06T02:02:00.000Z" }), yours({ id: "line-2", body: "加字幕", created_at: "2026-10-06T02:03:00.000Z" })], {
    stubs: { messageVersions: async () => versions },
  });
  try {
    const marks = [...s.host.querySelectorAll<HTMLButtonElement>(".msg-edited")];
    expect(marks.map((mark) => mark.textContent)).toEqual([t.chat.edited]);
    click(marks[0]);
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    const shown = [...s.segment("line-1").parentElement!.querySelectorAll(".msg-version-body")].map((row) => row.textContent);
    expect(shown).toEqual(["片长 40 秒", "片长 30 秒"]);
    expect(marks[0]!.getAttribute("aria-expanded")).toBe("true");
    click(marks[0]);
    expect(s.host.querySelector(".msg-versions")).toBeNull();
  } finally {
    s.close();
  }
});
