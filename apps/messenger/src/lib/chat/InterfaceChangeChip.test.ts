import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { InterfaceRevisionHead } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import InterfaceChangeChip from "./InterfaceChangeChip.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function head(over: Partial<InterfaceRevisionHead> = {}): InterfaceRevisionHead {
  return { id: "r1", revision: 1, op: "edit", actor: "bot", bot_id: "b1", turn_id: "t1", approval_id: null, message_id: null, reason: null, app_version: null, created_at: "", changes: ["专注模式 开", "第二处"], undoable: true, ...over };
}

test("a change this turn made shows its first line and an Undo that takes it back", async () => {
  const undone: string[] = [];
  const api = { undoInterfaceRevision: async (id: string) => void undone.push(id) };
  const { host, close } = render(InterfaceChangeChip, { turnIds: ["t1"], recent: [head()], t, api: api as never });
  expect(host.textContent).toContain(t.ui.chip.changed);
  expect(host.textContent).toContain("专注模式 开");
  expect(host.textContent).not.toContain("第二处");
  const undo = buttonByText(host, t.ui.chip.undo);
  expect(undo.getAttribute("data-floor")).toBe("interface-undo");
  click(undo);
  await sleep(10);
  flushSync();
  expect(undone).toEqual(["r1"]);
  expect(host.textContent).toContain(t.ui.chip.undone);
  expect(host.querySelector("button")).toBeNull();
  close();
});

test("a change that cannot be taken back any more says where to go", () => {
  const { host, close } = render(InterfaceChangeChip, { turnIds: ["t1"], recent: [head({ undoable: false })], t, api: null });
  expect(host.textContent).toContain(t.ui.chip.cannotUndo);
  expect(host.querySelector("button")).toBeNull();
  close();
});

test("nothing for a card-approved change, another turn's change, or a change of yours", () => {
  const recent = [head({ id: "a", approval_id: "ap1" }), head({ id: "b", turn_id: "t2" }), head({ id: "c", actor: "user", bot_id: null, turn_id: null })];
  const { host, close } = render(InterfaceChangeChip, { turnIds: ["t1"], recent, t, api: null });
  expect(host.querySelector(".interface-chip")).toBeNull();
  close();
});
