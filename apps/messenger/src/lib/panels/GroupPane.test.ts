import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, render } from "../test-render.ts";
import GroupPane from "./GroupPane.svelte";
import type { GroupDetailDraft } from "./group-edit.ts";
import { reactive } from "../test-reactive.svelte.ts";

const t = copyFor("zh");

function aDraft(over: Partial<GroupDetailDraft> = {}): GroupDetailDraft {
  return reactive({ sessionId: "sess-1", name: "视频组", nameError: undefined, failed: false, pullPick: "", ...over }) as GroupDetailDraft;
}

function open(detail: GroupDetailDraft, selected = aGroup()) {
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "甲" }), aBot({ id: "bot-2", name: "乙" }), aBot({ id: "bot-3", name: "丙" })],
    sessions: [selected],
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
