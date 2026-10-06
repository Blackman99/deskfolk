import { expect, test } from "bun:test";
import type { Message } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import MessageContextMenu from "./MessageContextMenu.svelte";

const t = copyFor("zh");

function createTestMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m-test-1",
    session_id: "s-1",
    turn_id: null,
    parent_id: null,
    kind: "bot",
    author: "bot-1",
    body: "Here is your report: [report](docs/report.md)",
    source_turn_id: null,
    created_at: new Date().toISOString(),
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

function openMessageMenu(
  message: Message,
  opts: {
    lockedComposer?: boolean;
    attribution?: boolean;
    selectText?: boolean;
    edit?: boolean;
  } = {},
) {
  const calls = {
    edit: 0,
    attribution: 0,
    selectText: 0,
    close: 0,
    reply: 0,
    copy: 0,
    openFileTree: [] as (string | null)[],
    showTrace: 0,
    copyId: 0,
    reaction: [] as string[],
  };

  const view = render(MessageContextMenu, {
    message,
    x: 100,
    y: 150,
    t,
    lockedComposer: opts.lockedComposer ?? false,
    onClose: () => {
      calls.close += 1;
    },
    onReply: () => {
      calls.reply += 1;
    },
    onCopy: () => {
      calls.copy += 1;
    },
    onOpenFileTree: (path: string | null) => {
      calls.openFileTree.push(path);
    },
    onShowTrace: () => {
      calls.showTrace += 1;
    },
    onCopyId: () => {
      calls.copyId += 1;
    },
    onReaction: (emoji: string) => {
      calls.reaction.push(emoji);
    },
    ...(opts.attribution ? { onAttribution: () => { calls.attribution += 1; } } : {}),
    ...(opts.selectText ? { onSelectText: () => { calls.selectText += 1; } } : {}),
    ...(opts.edit ? { onEdit: () => { calls.edit += 1; } } : {}),
  });

  return { ...view, calls };
}

test("clicking reply fires onReply and onClose", () => {
  const { host, calls, close } = openMessageMenu(createTestMessage());
  click(buttonByText(host, t.chat.replyMessage));
  expect(calls.reply).toBe(1);
  expect(calls.close).toBe(1);
  close();
});

test("clicking copy fires onCopy and onClose", () => {
  const { host, calls, close } = openMessageMenu(createTestMessage());
  click(buttonByText(host, t.chat.copyMessage));
  expect(calls.copy).toBe(1);
  expect(calls.close).toBe(1);
  close();
});

test("clicking open file tree fires onOpenFileTree with associated path and closes", () => {
  const msg = createTestMessage({
    body: "Please see `src/index.ts`",
  });
  const { host, calls, close } = openMessageMenu(msg);
  click(buttonByText(host, t.chat.openAssociatedFileTree));
  expect(calls.openFileTree).toEqual(["src/index.ts"]);
  expect(calls.close).toBe(1);
  close();
});

test("clicking copy message id fires onCopyId and closes", () => {
  const { host, calls, close } = openMessageMenu(createTestMessage());
  click(buttonByText(host, t.chat.copyMessageId));
  expect(calls.copyId).toBe(1);
  expect(calls.close).toBe(1);
  close();
});

test("clicking reaction emoji fires onReaction and closes", () => {
  const { host, calls, close } = openMessageMenu(createTestMessage());
  const thumbsUp = buttonByText(host, "👍");
  click(thumbsUp);
  expect(calls.reaction).toEqual(["👍"]);
  expect(calls.close).toBe(1);
  close();
});

test("reply is disabled when composer is locked", () => {
  const { host, close } = openMessageMenu(createTestMessage(), { lockedComposer: true });
  const replyBtn = buttonByText(host, t.chat.replyMessage) as HTMLButtonElement;
  expect(replyBtn.disabled).toBe(true);
  close();
});

test("open file tree is disabled when message has no associated files", () => {
  const { host, close } = openMessageMenu(createTestMessage({ body: "Plain text with no files" }));
  const fileTreeBtn = buttonByText(host, t.chat.openAssociatedFileTree) as HTMLButtonElement;
  expect(fileTreeBtn.disabled).toBe(true);
  close();
});

test("a line that can be filed offers 「改归属…」, which opens the attribution dialog and closes the menu; a line that cannot has no such item", () => {
  const withIt = openMessageMenu(createTestMessage(), { attribution: true });
  click(buttonByText(withIt.host, t.attribution.menuItem));
  expect(withIt.calls.attribution).toBe(1);
  expect(withIt.calls.close).toBe(1);
  withIt.close();
  const without = openMessageMenu(createTestMessage());
  expect([...without.host.querySelectorAll("button")].some((b) => b.textContent?.trim() === t.attribution.menuItem)).toBe(false);
  without.close();
});

test("a menu opened by a touch offers 「选择文本」 under copy, which opens the text and closes the menu; one opened by a mouse does not", () => {
  const touch = openMessageMenu(createTestMessage(), { selectText: true });
  const labels = [...touch.host.querySelectorAll(".msg-context-menu-item")].map((b) => b.textContent?.trim());
  expect(labels.indexOf(t.chat.selectText)).toBe(labels.indexOf(t.chat.copyMessage) + 1);
  click(buttonByText(touch.host, t.chat.selectText));
  expect(touch.calls.selectText).toBe(1);
  expect(touch.calls.close).toBe(1);
  expect(touch.calls.copy).toBe(0);
  touch.close();
  const mouse = openMessageMenu(createTestMessage());
  expect([...mouse.host.querySelectorAll("button")].some((b) => b.textContent?.trim() === t.chat.selectText)).toBe(false);
  mouse.close();
});

test("a message with no text has nothing to select", () => {
  const { host, close } = openMessageMenu(createTestMessage({ body: "" }), { selectText: true });
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === t.chat.selectText)).toBe(false);
  close();
});

test("编辑 is offered only where the stage passes it, right after 回复, and opens the line and closes the menu", () => {
  const yours = createTestMessage({ kind: "user", author: "user", body: "片长 30 秒" });
  const without = openMessageMenu(yours);
  expect([...without.host.querySelectorAll(".msg-context-menu-item")].map((item) => item.textContent?.trim())).not.toContain(t.chat.editMessage);
  without.close();

  const { host, calls, close } = openMessageMenu(yours, { edit: true });
  const labels = [...host.querySelectorAll(".msg-context-menu-item")].map((item) => item.textContent?.trim());
  expect(labels.indexOf(t.chat.editMessage)).toBe(labels.indexOf(t.chat.replyMessage) + 1);
  click(buttonByText(host, t.chat.editMessage));
  expect(calls.edit).toBe(1);
  expect(calls.close).toBe(1);
  close();
});
