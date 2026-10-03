import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aMessage, anAttachment, fakeRuntime } from "../test-fixtures.ts";
import { render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

test("a card asking you to approve a hand-over shows its files, to open before you decide", () => {
  // 2026-10-03: the card named slogans.md only in its words; the file itself was not there to open.
  const session = aGroup();
  const path = "work/做一张咖啡店开业海报-a1r9/02-三句宣传语/slogans.md";
  const card = aMessage({ id: "card", session_id: session.id, kind: "system", author: "user",
    body: "做一张咖啡店开业海报 的任务 02「三句宣传语」交上来了（slogans.md），等你定。\n看过之后，放行或者退回。",
    attachments: [anAttachment({ message_id: "card", workspace_relpath: path, original_filename: "slogans.md" })],
    control: { kind: "review_item", submission_id: "sub-1", task_id: "plan-1", ticket_id: "ticket-2", requirement_ids: [], check_ids: [], offer: ["approve", "reject"] } as never });
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages: [card] }, { selectedId: session.id });
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    const row = host.querySelector('[data-message-id="card"]')!;
    expect(row.querySelector(".attachment-file-btn, .attachment-bundle-btn")).not.toBeNull();
    expect(row.textContent).toContain("slogans.md");
    // The buttons are still there, after the file.
    expect([...row.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(["放行", "退回"]));
  } finally { close(); }
});
