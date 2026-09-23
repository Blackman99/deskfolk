/**
 * The annotation surfaces on their own: the per-file list (filters, edit / delete a draft, resolve
 * and reopen a sent one), the transcript cards (status toggle, stale badge, the way back from a
 * Bot↔Bot batch), and the send bar (summary, send, clear only after confirming).
 */
import { expect, test } from "bun:test";
import type { Annotation } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import AnnotationCards from "./AnnotationCards.svelte";
import AnnotationList from "./AnnotationList.svelte";
import AnnotationSendBar from "./AnnotationSendBar.svelte";

const t = copyFor("zh");
const bots = new Map([["bot-1", { name: "Writer" }]]);

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "src/pick.ts",
    anchor_kind: "text_range",
    anchor: { start_line: 3, start_col: 1, end_line: 4, end_col: 5, quote: "const x", prefix: "", suffix: "" },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "sess-1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "sess-1",
    message_id: "m2",
    body: "这里换个名字",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

function listHarness(rows: Annotation[]) {
  const calls: string[] = [];
  const view = render(AnnotationList, {
    annotations: rows,
    t,
    locale: "zh",
    bots,
    focusId: null,
    onReveal: (r: Annotation) => calls.push(`reveal:${r.id}`),
    onEdit: (r: Annotation, body: string) => calls.push(`edit:${r.id}:${body}`),
    onDelete: (r: Annotation) => calls.push(`delete:${r.id}`),
    onToggleStatus: (r: Annotation, status: string) => calls.push(`status:${r.id}:${status}`),
  });
  return { ...view, calls };
}

test("the list counts the file's annotations and filters them by state", () => {
  const { host, close } = listHarness([
    row({ id: "d", status: "draft", message_id: null }),
    row({ id: "o" }),
    row({ id: "r", status: "resolved", resolved_by: "bot-1", resolved_note: "改名为 picked" }),
  ]);
  expect(host.querySelector("h3")?.textContent).toBe("3 条批注");
  expect(host.querySelectorAll(".annot-item")).toHaveLength(3);
  click(buttonByText(host, "已处理"));
  const items = host.querySelectorAll(".annot-item");
  expect(items).toHaveLength(1);
  expect(items[0]?.textContent).toContain("Writer 已处理：改名为 picked");
  click(buttonByText(host, "草稿"));
  expect(host.querySelector(".annot-item")?.getAttribute("data-annotation-id")).toBe("d");
  close();
});

test("a draft is edited in place and deleted; a sent one is resolved or reopened", () => {
  const { host, calls, close } = listHarness([row({ id: "d", status: "draft", message_id: null }), row({ id: "o" }), row({ id: "r", status: "resolved" })]);
  const draft = host.querySelector('[data-annotation-id="d"]')!;
  click(buttonByText(draft as HTMLElement, "编辑"));
  const box = draft.querySelector("textarea")!;
  fill(box, "  改成 picked  ");
  click(buttonByText(draft as HTMLElement, "存为草稿"));
  click(buttonByText(host.querySelector('[data-annotation-id="d"]') as HTMLElement, "删除"));
  click(buttonByText(host.querySelector('[data-annotation-id="o"]') as HTMLElement, "标为已处理"));
  click(buttonByText(host.querySelector('[data-annotation-id="r"]') as HTMLElement, "重新打开"));
  click(host.querySelector('[data-annotation-id="o"] .annot-item-main'));
  expect(calls).toEqual(["edit:d:改成 picked", "delete:d", "status:o:resolved", "status:r:open", "reveal:o"]);
  // A sent annotation cannot be edited or deleted from here.
  expect([...host.querySelectorAll('[data-annotation-id="o"] button')].map((b) => b.textContent?.trim())).not.toContain("删除");
  close();
});

test("Escape in the edit box cancels the edit without closing anything else", () => {
  const { host, calls, close } = listHarness([row({ id: "d", status: "draft", message_id: null })]);
  click(buttonByText(host, "编辑"));
  const box = host.querySelector("textarea")!;
  let escaped = false;
  document.addEventListener("keydown", () => { escaped = true; }, { once: true });
  press(box, "Escape");
  expect(host.querySelector("textarea")).toBeNull();
  expect(escaped).toBe(false);
  expect(calls).toEqual([]);
  close();
});

test("the list says so when a file has no annotations, and marks stale ones", () => {
  const empty = listHarness([]);
  expect(empty.host.textContent).toContain("这个文件还没有批注。");
  empty.close();
  const stale = listHarness([row({ stale: { kind: "moved", start_line: 9, start_col: 1, end_line: 10, end_col: 2 } }), row({ id: "gone", stale: { kind: "missing" } })]);
  expect(stale.host.textContent).toContain("原文已变，现在在第 9–10 行");
  expect(stale.host.textContent).toContain("文件不在了");
  stale.close();
});

test("cards name the file, the place, the remark, and the state; the state toggles", () => {
  const calls: string[] = [];
  const { host, close } = render(AnnotationCards, {
    annotations: [row(), row({ id: "r", status: "resolved", resolved_by: "user", stale: { kind: "changed" } })],
    t,
    locale: "zh",
    bots,
    onOpen: (r: Annotation) => calls.push(`open:${r.id}`),
    onToggleStatus: (r: Annotation, status: string) => calls.push(`status:${r.id}:${status}`),
  });
  const cards = host.querySelectorAll(".annot-card");
  expect(cards).toHaveLength(2);
  expect(cards[0]?.textContent).toContain("src/pick.ts");
  expect(cards[0]?.textContent).toContain("第 3–4 行");
  expect(cards[0]?.textContent).toContain("这里换个名字");
  expect(cards[1]?.textContent).toContain("原文已变");
  expect(cards[1]?.textContent).toContain("你 已处理");
  click(cards[0]!.querySelector(".annot-toggle"));
  click(cards[1]!.querySelector(".annot-toggle"));
  click(cards[0]!.querySelector(".annot-card-main"));
  expect(calls).toEqual(["status:a1:resolved", "status:r:open", "open:a1"]);
  close();
});

test("a batch routed from a Bot↔Bot direct shows the way back; a read-only view has no toggle", () => {
  let back = 0;
  const { host, close } = render(AnnotationCards, {
    annotations: [row()],
    t,
    locale: "zh",
    bots,
    onOpen: () => {},
    sourceLabel: "来自 Writer ↔ Editor 的那条消息",
    onOpenSource: () => { back += 1; },
  });
  click(host.querySelector(".annot-source"));
  expect(back).toBe(1);
  expect(host.querySelector(".annot-toggle")).toBeNull();
  expect(host.querySelector(".annot-badge")?.textContent).toBe("待处理");
  close();
});

test("the send bar sends the summary, and clears only after a confirm", () => {
  const calls: string[] = [];
  const { host, close } = render(AnnotationSendBar, {
    count: 3,
    destination: "将发到你和 Writer 的私聊",
    sending: false,
    error: null,
    t,
    onSend: (summary: string) => calls.push(`send:${summary}`),
    onClear: () => calls.push("clear"),
  });
  expect(host.textContent).toContain("3 条批注待发送");
  expect(host.textContent).toContain("将发到你和 Writer 的私聊");
  fill(host.querySelector("input"), "  三处都改一下 ");
  press(host.querySelector("input"), "Enter");
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("");
  click(buttonByText(host, "清空"));
  expect(calls).toEqual(["send:三处都改一下"]);
  expect(host.textContent).toContain("清空这批草稿？");
  click(buttonByText(host, "取消"));
  click(buttonByText(host, "清空"));
  click(host.querySelector(".annot-send-clear.is-danger"));
  click(buttonByText(host, "发送批注"));
  expect(calls).toEqual(["send:三处都改一下", "clear", "send:"]);
  close();
});
