import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, fakeRuntime } from "../test-fixtures.ts";
import { fieldErrors, fill, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import GroupIdentity from "./GroupIdentity.svelte";
import type { GroupDetailDraft } from "./group-edit.ts";

const t = copyFor("zh");

function aDraft(over: Partial<GroupDetailDraft> = {}): GroupDetailDraft {
  return reactive({ sessionId: "sess-1", name: "视频组", nameError: undefined, failed: false, pullPick: "", ...over }) as GroupDetailDraft;
}

function open(detail: GroupDetailDraft, name = "视频组") {
  const session = aGroup({ name });
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "甲" }), aBot({ id: "bot-2", name: "乙" })],
    sessions: [session],
  });
  const view = render(GroupIdentity, { runtime, session, detail, t });
  return { ...view, runtime, session };
}

function title(host: HTMLElement): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>("#detail-group-name");
  if (!field) throw new Error("no group title");
  return field;
}

test("the header is the group's avatar and an editable name", () => {
  const { host, close } = open(aDraft());
  expect(title(host).value).toBe("视频组");
  expect(title(host).getAttribute("aria-label")).toBe(t.sidebar.groupName);
  expect(host.querySelector(".group-identity-avatar .row-avatar")).not.toBeNull();
  expect(host.textContent).toContain(`3 ${t.detail.members}`);
  expect(host.querySelector("button")).toBeNull();
  close();
});

test("leaving a changed name patches the session", async () => {
  const detail = aDraft();
  const { host, runtime, close } = open(detail);
  fill(title(host), "新名字");
  title(host).dispatchEvent(new FocusEvent("blur"));
  await Promise.resolve();
  flushSync();
  expect(runtime.calls.find((call) => call.name === "patchSession")?.args).toEqual(["sess-1", { name: "新名字" }]);
  expect(detail.name).toBe("新名字");
  close();
});

test("Enter leaves the field and saves", async () => {
  const { host, runtime, close } = open(aDraft());
  fill(title(host), "新名字");
  press(title(host), "Enter");
  await Promise.resolve();
  flushSync();
  expect(runtime.calls.find((call) => call.name === "patchSession")?.args).toEqual(["sess-1", { name: "新名字" }]);
  close();
});

test("a blank name reports itself and sends no patch", async () => {
  const detail = aDraft();
  const { host, runtime, close } = open(detail);
  fill(title(host), "   ");
  title(host).dispatchEvent(new FocusEvent("blur"));
  await Promise.resolve();
  flushSync();
  expect(fieldErrors(host)).toContain(t.sidebar.groupNameEmpty);
  expect(runtime.calls.filter((call) => call.name === "patchSession")).toHaveLength(0);
  close();
});

test("leaving an unchanged name sends nothing", async () => {
  const { host, runtime, close } = open(aDraft());
  fill(title(host), "  视频组  ");
  title(host).dispatchEvent(new FocusEvent("blur"));
  await Promise.resolve();
  flushSync();
  expect(runtime.calls.filter((call) => call.name === "patchSession")).toHaveLength(0);
  close();
});

test("a failed save says so under the title", async () => {
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })],
    sessions: [aGroup()],
  }));
  runtime.patchSession = () => Promise.resolve({ message: "nope", status: 500, code: "error" } as never);
  const detail = aDraft();
  const { host, close } = render(GroupIdentity, { runtime, session: aGroup(), detail, t });
  fill(title(host), "新名字");
  title(host).dispatchEvent(new FocusEvent("blur"));
  await Promise.resolve();
  flushSync();
  expect(fieldErrors(host)).toContain(t.detail.saveFailed);
  close();
});
