import { describe, expect, test } from "bun:test";
import type { Attachment, Message } from "@real-bot/protocol";
import {
  deriveMessageContextMenu,
  extractAssociatedFiles,
} from "./message-context-menu.ts";

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    session_id: "s-1",
    turn_id: null,
    parent_id: null,
    kind: "bot",
    author: "bot-1",
    body: "Here is your message",
    source_turn_id: null,
    created_at: new Date().toISOString(),
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

describe("extractAssociatedFiles", () => {
  test("returns empty array for plain text without files", () => {
    expect(extractAssociatedFiles({ body: "Hello world, how are you?" })).toEqual([]);
    expect(extractAssociatedFiles({ body: "" })).toEqual([]);
    expect(extractAssociatedFiles({ body: null })).toEqual([]);
  });

  test("extracts paths from message attachments first", () => {
    const attachments: Attachment[] = [
      {
        id: "att-1",
        message_id: "msg-1",
        workspace_relpath: "reports/q3.pdf",
        original_filename: "q3.pdf",
        created_at: new Date().toISOString(),
      },
      {
        id: "att-2",
        message_id: "msg-1",
        workspace_relpath: "src/main.ts",
        original_filename: "main.ts",
        created_at: new Date().toISOString(),
      },
    ];
    const files = extractAssociatedFiles({ body: "Check this out", attachments });
    expect(files).toEqual(["reports/q3.pdf", "src/main.ts"]);
  });

  test("extracts markdown links and artifact schemes", () => {
    const body = "See [the design](docs/spec.md) and [mock](artifact:images/preview.png)";
    const files = extractAssociatedFiles({ body });
    expect(files).toEqual(["docs/spec.md", "images/preview.png"]);
  });

  test("extracts backtick inline code paths", () => {
    const body = "I updated `src/app.svelte` and `package.json` for you.";
    const files = extractAssociatedFiles({ body });
    expect(files).toEqual(["src/app.svelte", "package.json"]);
  });

  test("extracts bare path tokens that look like workspace paths", () => {
    const body = "Created file at docs/readme.md successfully.";
    const files = extractAssociatedFiles({ body });
    expect(files).toEqual(["docs/readme.md"]);
  });

  test("deduplicates paths while keeping attachment priority", () => {
    const attachments: Attachment[] = [
      {
        id: "att-1",
        message_id: "msg-1",
        workspace_relpath: "src/app.ts",
        original_filename: "app.ts",
        created_at: new Date().toISOString(),
      },
    ];
    const body = "I modified `src/app.ts` and [link](src/app.ts) as well as docs/notes.txt";
    const files = extractAssociatedFiles({ body, attachments });
    expect(files).toEqual(["src/app.ts", "docs/notes.txt"]);
  });

  test("ignores web links and external schemes", () => {
    const body = "Visit https://example.com/spec.ts or mailto:user@test.org";
    const files = extractAssociatedFiles({ body });
    expect(files).toEqual([]);
  });

  test("ignores CJK prose with slashes and markdown asterisks", () => {
    const body = "这是**主角「林准」基准定妆图（正面/侧面）**：请查看 `src/app.ts`";
    const files = extractAssociatedFiles({ body });
    expect(files).toEqual(["src/app.ts"]);
  });
});

describe("deriveMessageContextMenu", () => {
  test("derives capabilities for a standard bot message", () => {
    const msg = createMessage({
      kind: "bot",
      body: "Generated `out/result.csv` for you.",
      parent_id: null,
    });
    const data = deriveMessageContextMenu(msg, {
      lockedComposer: false,
      hasWorkspace: true,
    });

    expect(data.canReply).toBe(true);
    expect(data.canCopy).toBe(true);
    expect(data.canOpenWorkspace).toBe(true);
    expect(data.associatedFiles).toEqual(["out/result.csv"]);
    expect(data.targetPath).toBe("out/result.csv");
  });

  test("disables reply when composer is locked or message is a reply", () => {
    const topMsg = createMessage({ kind: "bot", parent_id: null });
    const replyMsg = createMessage({ kind: "bot", parent_id: "msg-0" });

    expect(deriveMessageContextMenu(topMsg, { lockedComposer: true }).canReply).toBe(false);
    expect(deriveMessageContextMenu(replyMsg, { lockedComposer: false }).canReply).toBe(false);
  });

  test("canOpenWorkspace is false when no workspace is configured", () => {
    const msg = createMessage({ body: "Plain text" });
    const data = deriveMessageContextMenu(msg, { hasWorkspace: false });
    expect(data.canOpenWorkspace).toBe(false);
    expect(data.targetPath).toBeNull();
  });
});
