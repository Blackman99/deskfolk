import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import type { Snapshot } from "../snapshot.ts";
import { aBot, aBotDirect, aGroup, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, render } from "../test-render.ts";
import GroupPane from "./GroupPane.svelte";
import type { GroupDetailDraft } from "./group-edit.ts";
import { reactive } from "../test-reactive.svelte.ts";

const t = copyFor("zh");

function aDraft(over: Partial<GroupDetailDraft> = {}): GroupDetailDraft {
  return reactive({ sessionId: "sess-1", name: "视频组", nameError: undefined, failed: false, pullPick: "", ...over }) as GroupDetailDraft;
}

function open(detail: GroupDetailDraft, selected = aGroup(), over: Partial<Snapshot> = {}) {
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "甲" }), aBot({ id: "bot-2", name: "乙" }), aBot({ id: "bot-3", name: "丙" })],
    sessions: [selected],
    ...over,
  });
  const view = render(GroupPane, {
    runtime,
    selected,
    t,
    detail,
    onOpenProfile: () => {},
    onDeleteGroup: () => {},
    onClearHistory: () => {},
  });
  return { ...view, runtime };
}

test("shows the group's members", () => {
  const { host, close } = open(aDraft());
  expect(host.querySelector("#detail-group-name")).toBeNull();
  expect(host.textContent).toContain("甲");
  expect(host.textContent).toContain("乙");
  close();
});

/** Three Bots in: a group is allowed to drop to two, so removal is only offered above that. */
function aThreeBotGroup() {
  const base = aGroup();
  return {
    ...base,
    participants: [...base.participants, { member: "bot-3", joined_at: base.created_at, left_at: null }],
  } as typeof base;
}

test("pulling a member in goes through the runtime", () => {
  const detail = aDraft({ pullPick: "bot-3" });
  const { host, runtime, close } = open(detail);
  click(buttonByText(host, t.detail.pullIn));
  expect(runtime.calls.find((c) => c.name === "addMember")?.args).toEqual(["sess-1", "bot-3"]);
  close();
});

test("removing a member goes through the runtime", () => {
  const { host, runtime, close } = open(aDraft(), aThreeBotGroup());
  click([...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t.detail.remove));
  expect(runtime.calls.find((c) => c.name === "removeMember")?.args[0]).toBe("sess-1");
  close();
});

/**
 * The floor is two Bots, so the last removal is not offered at all. This used to pass by accident:
 * the fixture called the user `"you"` while the protocol calls them `"user"`, so the pane counted
 * the user as a third, unknown member and kept the button.
 */
test("a two-Bot group offers no way to remove either of them", () => {
  const { host, close } = open(aDraft());
  const removes = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === t.detail.remove);
  expect(removes.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  close();
});

test("批量换模型 on the members card opens the dialog with this group's Bots ticked", () => {
  const { host, runtime, close } = open(aDraft(), aThreeBotGroup());
  const button = host.querySelector(".group-members-card .panel-card-head .btn-bulk-model");
  expect(button?.textContent?.trim()).toBe(t.bulkModel.open);
  click(button);
  expect(runtime.calls.find((c) => c.name === "openBulkModel")?.args).toEqual([["bot-1", "bot-2", "bot-3"]]);
  close();
});

/** A deleted Bot has nothing to change; it is left out rather than handed to the dialog. */
test("a deleted member is not handed to the bulk model dialog", () => {
  const { host, runtime, close } = open(aDraft(), aGroup(), { bots: [aBot({ id: "bot-1", name: "甲" })] });
  click(host.querySelector(".btn-bulk-model"));
  expect(runtime.calls.find((c) => c.name === "openBulkModel")?.args).toEqual([["bot-1"]]);
  close();
});

test("a Bot↔Bot direct offers 批量换模型 for its two Bots too", () => {
  const { host, runtime, close } = open(aDraft({ sessionId: "botbot-1" }), aBotDirect());
  click(host.querySelector(".group-members-card .btn-bulk-model"));
  expect(runtime.calls.find((c) => c.name === "openBulkModel")?.args).toEqual([["bot-1", "bot-2"]]);
  close();
});

test("with no member left on the roster there is no 批量换模型", () => {
  const { host, close } = open(aDraft(), aGroup(), { bots: [] });
  expect(host.querySelector(".btn-bulk-model")).toBeNull();
  close();
});

/** Remote writes carry each Bot's own revision and there is no bulk route over the link. */
test("a remote link offers no 批量换模型", () => {
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "甲" }), aBot({ id: "bot-2", name: "乙" })],
    sessions: [aGroup()],
  });
  runtime.remote = true;
  const view = render(GroupPane, {
    runtime,
    selected: aGroup(),
    t,
    detail: aDraft(),
    onOpenProfile: () => {},
    onDeleteGroup: () => {},
    onClearHistory: () => {},
  });
  expect(view.host.querySelector(".btn-bulk-model")).toBeNull();
  view.close();
});
