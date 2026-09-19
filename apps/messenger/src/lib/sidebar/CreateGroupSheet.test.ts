import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot } from "../test-fixtures.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fieldErrors, fill, render } from "../test-render.ts";
import CreateGroupSheet from "./CreateGroupSheet.svelte";

const t = copyFor("zh");
const bots = [aBot({ id: "b1", name: "甲" }), aBot({ id: "b2", name: "乙" })];

function open() {
  const runtime = fakeRuntime();
  const view = render(CreateGroupSheet, { runtime, bots, t, onClose: () => {} });
  return { ...view, runtime };
}

test("an empty form reports both required fields and sends nothing", () => {
  const { host, runtime, close } = open();
  click(buttonByText(host, t.sidebar.create));
  const errors = fieldErrors(host);
  expect(errors).toContain(t.sidebar.groupNameEmpty);
  expect(errors).toContain(t.sidebar.membersTooFew);
  expect(runtime.calls.filter((c) => c.name === "createGroup")).toHaveLength(0);
  close();
});

test("ticking a member clears only the member error", () => {
  const { host, close } = open();
  click(buttonByText(host, t.sidebar.create));
  click(host.querySelectorAll("input[type=checkbox]")[0]);
  const errors = fieldErrors(host);
  expect(errors).toContain(t.sidebar.groupNameEmpty);
  expect(errors).not.toContain(t.sidebar.membersTooFew);
  close();
});

test("a name and two members reach createGroup", () => {
  const { host, runtime, close } = open();
  fill(host.querySelector("#group-name"), "新群");
  for (const box of host.querySelectorAll("input[type=checkbox]")) click(box);
  click(buttonByText(host, t.sidebar.create));
  const call = runtime.calls.find((c) => c.name === "createGroup");
  expect(call?.args[0]).toEqual({ name: "新群", members: ["b1", "b2"] });
  close();
});

test("a fresh mount is the reset: the sheet comes back empty", () => {
  const first = open();
  fill(first.host.querySelector("#group-name"), "打了一半");
  expect((first.host.querySelector("#group-name") as HTMLInputElement).value).toBe("打了一半");
  first.close();

  const second = open();
  expect((second.host.querySelector("#group-name") as HTMLInputElement).value).toBe("");
  expect([...second.host.querySelectorAll("input[type=checkbox]")].filter((b) => (b as HTMLInputElement).checked)).toHaveLength(0);
  second.close();
});

test("close asks the shell to close it", () => {
  const runtime = fakeRuntime();
  let closed = 0;
  const { host, close } = render(CreateGroupSheet, { runtime, bots, t, onClose: () => (closed += 1) });
  click(host.querySelector(".sheet-close"));
  expect(closed).toBe(1);
  close();
});
