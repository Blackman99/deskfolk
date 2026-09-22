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
  } = {},
) {
  const calls = {
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
