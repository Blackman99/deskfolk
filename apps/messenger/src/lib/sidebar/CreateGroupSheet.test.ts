import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot } from "../test-fixtures.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fieldErrors, fill, mouseDown, press, render } from "../test-render.ts";
import CreateGroupSheet from "./CreateGroupSheet.svelte";

const t = copyFor("zh");
const bots = [
  aBot({ id: "b1", name: "甲" }),
  aBot({ id: "b2", name: "乙" }),
  // The roster letter stands in for a Bot that has no image of its own.
  aBot({ id: "b3", name: "丙", avatar: null }),
];

function open() {
  const runtime = fakeRuntime();
  const view = render(CreateGroupSheet, { runtime, bots, t, onClose: () => {} });
  return { ...view, runtime };
}

/** The member picker is a dropdown now: it opens on a click in the field, not on mount. */
function memberOptions(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".multi-select-option")];
}

function openMembers(host: HTMLElement): HTMLElement[] {
  mouseDown(host.querySelector(".multi-select-field"));
  return memberOptions(host);
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

test("picking a member clears only the member error", () => {
  const { host, close } = open();
  click(buttonByText(host, t.sidebar.create));
  click(openMembers(host)[0]);
  const errors = fieldErrors(host);
  expect(errors).toContain(t.sidebar.groupNameEmpty);
  expect(errors).not.toContain(t.sidebar.membersTooFew);
  close();
});

test("a name and two members reach createGroup", () => {
  const { host, runtime, close } = open();
  fill(host.querySelector("#group-name"), "新群");
  const options = openMembers(host);
  click(options[0]);
  click(options[1]);
  click(buttonByText(host, t.sidebar.create));
  const call = runtime.calls.find((c) => c.name === "createGroup");
  expect(call?.args[0]).toEqual({ name: "新群", members: ["b1", "b2"] });
  close();
});

test("the search narrows the list, and what it hides stays picked", () => {
  const { host, runtime, close } = open();
  fill(host.querySelector("#group-name"), "新群");
  click(openMembers(host)[0]);
  fill(host.querySelector("#group-members"), "乙");
  const narrowed = memberOptions(host);
  expect(narrowed.map((o) => o.querySelector(".multi-select-option-label")?.textContent)).toEqual([
    "乙",
  ]);
  click(narrowed[0]);
  click(buttonByText(host, t.sidebar.create));
  const call = runtime.calls.find((c) => c.name === "createGroup");
  expect(call?.args[0]).toEqual({ name: "新群", members: ["b1", "b2"] });
  close();
});

test("a row carries the Bot's own avatar, and its letter when it has none", () => {
  const { host, close } = open();
  const rows = openMembers(host);
  expect(rows[0].querySelector(".member-avatar img")).not.toBeNull();
  expect(rows[2].querySelector(".member-avatar img")).toBeNull();
  expect(rows[2].querySelector(".member-avatar")?.textContent?.trim()).toBe("丙");
  close();
});

test("the chip a pick becomes carries that avatar too", () => {
  const { host, close } = open();
  click(openMembers(host)[2]);
  const chip = host.querySelector(".multi-select-chip");
  expect(chip?.querySelector(".member-avatar")?.textContent?.trim()).toBe("丙");
  expect(chip?.querySelector(".multi-select-chip-label")?.textContent).toBe("丙");
  close();
});

test("a picked member can be taken back off the field", () => {
  const { host, close } = open();
  click(openMembers(host)[0]);
  expect(host.querySelectorAll(".multi-select-chip")).toHaveLength(1);
  click(host.querySelector(".multi-select-chip-remove"));
  expect(host.querySelectorAll(".multi-select-chip")).toHaveLength(0);
  close();
});

test("Escape closes the open member list without closing the sheet", () => {
  const runtime = fakeRuntime();
  let closed = 0;
  const { host, close } = render(CreateGroupSheet, { runtime, bots, t, onClose: () => (closed += 1) });
  openMembers(host);
  expect(memberOptions(host)).toHaveLength(bots.length);
  press(host.querySelector("#group-members"), "Escape");
  expect(memberOptions(host)).toHaveLength(0);
  expect(closed).toBe(0);
  close();
});

test("a fresh mount is the reset: the sheet comes back empty", () => {
  const first = open();
  fill(first.host.querySelector("#group-name"), "打了一半");
  click(openMembers(first.host)[0]);
  expect((first.host.querySelector("#group-name") as HTMLInputElement).value).toBe("打了一半");
  first.close();

  const second = open();
  expect((second.host.querySelector("#group-name") as HTMLInputElement).value).toBe("");
  expect(second.host.querySelectorAll(".multi-select-chip")).toHaveLength(0);
  second.close();
});

test("close asks the shell to close it", () => {
  const runtime = fakeRuntime();
  let closed = 0;
  const { host, close } = render(CreateGroupSheet, { runtime, bots, t, onClose: () => (closed += 1) });
  click(host.querySelector(".modal-close"));
  expect(closed).toBe(1);
  close();
});

test("a click outside the sheet closes it", () => {
  const runtime = fakeRuntime();
  let closed = 0;
  const { host, close } = render(CreateGroupSheet, { runtime, bots, t, onClose: () => (closed += 1) });
  const backdrop = host.querySelector(".modal-backdrop") as HTMLElement;
  mouseDown(backdrop);
  click(backdrop);
  expect(closed).toBe(1);
  close();
});

test("a drag that starts inside the sheet and releases on the backdrop does not close it", () => {
  const runtime = fakeRuntime();
  let closed = 0;
  const { host, close } = render(CreateGroupSheet, { runtime, bots, t, onClose: () => (closed += 1) });
  const backdrop = host.querySelector(".modal-backdrop") as HTMLElement;
  const sheet = host.querySelector(".modal-dialog") as HTMLElement;
  // The press lands inside the sheet, the release on the backdrop. The browser reports the click
  // on their common ancestor, the backdrop, which used to read as an outside click.
  mouseDown(sheet);
  click(backdrop);
  expect(closed).toBe(0);
  close();
});

test("a sheet that swallows the press still keeps a drag-out from closing it", () => {
  const runtime = fakeRuntime();
  let closed = 0;
  const { host, close } = render(CreateGroupSheet, { runtime, bots, t, onClose: () => (closed += 1) });
  const backdrop = host.querySelector(".modal-backdrop") as HTMLElement;
  const sheet = host.querySelector(".modal-dialog") as HTMLElement;
  // A custom field inside a sheet may stop `mousedown` from bubbling. The backdrop records the
  // press on the way down, so a drag that began inside still cannot read as an outside click.
  sheet.addEventListener("mousedown", (event) => event.stopPropagation());
  mouseDown(sheet);
  click(backdrop);
  expect(closed).toBe(0);
  close();
});
