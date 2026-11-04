import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { Approval, InterfaceRevisionHead } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { interfaceController } from "../interface/controller.svelte.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, render } from "../test-render.ts";
import InterfaceEditCard from "./InterfaceEditCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const body = ["改界面", "理由：太亮了", "- 专注模式 开", "@@patch", '{"behaviour":{"focus_mode":true}}'].join("\n");

function approval(status: Approval["status"]): Approval {
  return { id: "a1", turn_id: "t1", message_id: "m1", status, kind_key: "ui-edit", summary: body, target: null, created_at: "", resolved_at: null, requires_api_key: false };
}

function head(over: Partial<InterfaceRevisionHead> = {}): InterfaceRevisionHead {
  return { id: "r1", revision: 1, op: "edit", actor: "bot", bot_id: "b1", turn_id: "t1", approval_id: "a1", message_id: null, reason: null, app_version: null, created_at: "", changes: ["专注模式 开"], undoable: true, ...over };
}

afterEach(() => interfaceController.stopTrying());

test("the card shows the head, the reason and the change lines, not the patch", () => {
  const { host, close } = render(InterfaceEditCard, { body, t, approval: approval("pending"), api: null, recent: [] });
  expect(host.querySelector(".interface-card-head")?.textContent).toBe(t.ui.card.head);
  expect(host.querySelector(".interface-card-reason")?.textContent).toBe("理由：太亮了");
  expect(host.querySelector(".interface-card-changes li")?.textContent).toBe("专注模式 开");
  expect(host.textContent).not.toContain("@@patch");
  expect(host.textContent).not.toContain(t.ui.chip.undo);
  close();
});

test("try here tries the patch in this window until the card is decided", async () => {
  const props = reactive({ body, t, approval: approval("pending"), api: null, recent: [] as InterfaceRevisionHead[] });
  const { host, close } = render(InterfaceEditCard, props);
  click(buttonByText(host, t.ui.card.tryHere));
  expect(interfaceController.trying?.approvalId).toBe("a1");
  expect(interfaceController.trying?.profile.behaviour.focus_mode).toBe(true);
  expect(host.textContent).toContain(t.ui.card.trying);
  click(buttonByText(host, t.ui.card.stopTrying));
  expect(interfaceController.trying).toBeNull();
  click(buttonByText(host, t.ui.card.tryHere));
  expect(interfaceController.trying).not.toBeNull();
  // Denied: the window goes back.
  props.approval = approval("denied");
  flushSync();
  expect(interfaceController.trying).toBeNull();
  expect(host.textContent).not.toContain(t.ui.card.tryHere);
  close();
});

test("a card taken off the page while it is being tried puts the window back", () => {
  const { host, close } = render(InterfaceEditCard, { body, t, approval: approval("pending"), api: null, recent: [] });
  click(buttonByText(host, t.ui.card.tryHere));
  expect(interfaceController.trying).not.toBeNull();
  close();
  expect(interfaceController.trying).toBeNull();
});

test("a restore card fetches the revision and tries its profile", async () => {
  const restoreBody = ["改界面", "理由：回去", "- x", "@@patch", '{"restore":"r0"}'].join("\n");
  const profile = { enabled: true, tokens: { light: {}, dark: {} }, behaviour: { motion: "reduce" }, css: "", copy: { zh: {}, en: {} } };
  const api = { getInterfaceRevision: async () => ({ after: { profile } }) };
  const { host, close } = render(InterfaceEditCard, { body: restoreBody, t, approval: approval("pending"), api: api as never, recent: [] });
  click(buttonByText(host, t.ui.card.tryHere));
  await sleep(10);
  flushSync();
  expect(interfaceController.trying?.profile.behaviour.motion).toBe("reduce");
  close();
});

test("without a readable patch there is nothing to try", () => {
  const { host, close } = render(InterfaceEditCard, { body: "改界面\n理由：x\n- a", t, approval: approval("pending"), api: null, recent: [] });
  expect(host.textContent).not.toContain(t.ui.card.tryHere);
  close();
});

test("once allowed, the card offers Undo while the change can still be taken back", async () => {
  const undone: string[] = [];
  const api = { undoInterfaceRevision: async (id: string) => void undone.push(id) };
  const { host, close } = render(InterfaceEditCard, { body, t, approval: approval("allowed_once"), api: api as never, recent: [head()] });
  expect(host.textContent).not.toContain(t.ui.card.tryHere);
  click(buttonByText(host, t.ui.chip.undo));
  await sleep(10);
  flushSync();
  expect(undone).toEqual(["r1"]);
  expect(host.textContent).toContain(t.ui.chip.undone);
  close();
  const late = render(InterfaceEditCard, { body, t, approval: approval("allowed_once"), api: null, recent: [head({ undoable: false })] });
  expect(late.host.textContent).not.toContain(t.ui.chip.undo);
  late.close();
});
