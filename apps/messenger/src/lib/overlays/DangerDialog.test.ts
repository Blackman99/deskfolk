import { expect, test } from "bun:test";
import { mount, unmount } from "svelte";
import DangerDialog from "./DangerDialog.svelte";
import { buttonByText, click, render } from "../test-render.ts";

const copy = { title: "删除", body: "删了就没了。", confirm: "确认删除", cancel: "取消" };
const t = { common: { close: "关闭" } } as never;

test("shows the copy it is handed", () => {
  const { host, close } = render(DangerDialog, { copy, t, onDismiss: () => {}, onConfirm: () => {} });
  expect(host.textContent).toContain("删除");
  expect(host.textContent).toContain("删了就没了。");
  expect(host.textContent).toContain("确认删除");
  close();
});

test("cancel and ✕ dismiss, confirm confirms", () => {
  let dismissed = 0;
  let confirmed = 0;
  const { host, close } = render(DangerDialog, {
    copy,
    t,
    onDismiss: () => (dismissed += 1),
    onConfirm: () => (confirmed += 1),
  });
  click(buttonByText(host, "取消"));
  click(host.querySelector(".modal-close"));
  expect(dismissed).toBe(2);
  expect(confirmed).toBe(0);
  click(buttonByText(host, "确认删除"));
  expect(confirmed).toBe(1);
  close();
});

test("a click on the backdrop dismisses, a click inside the dialog does not", () => {
  let dismissed = 0;
  const { host, close } = render(DangerDialog, {
    copy,
    t,
    onDismiss: () => (dismissed += 1),
    onConfirm: () => {},
  });
  const backdrop = host.querySelector(".confirm-backdrop") as HTMLElement;
  click(host.querySelector(".confirm-dialog"));
  expect(dismissed).toBe(0);
  click(backdrop);
  expect(dismissed).toBe(1);
  close();
});

test("Escape on the backdrop dismisses", () => {
  let dismissed = 0;
  const { host, close } = render(DangerDialog, {
    copy,
    t,
    onDismiss: () => (dismissed += 1),
    onConfirm: () => {},
  });
  const backdrop = host.querySelector(".confirm-backdrop") as HTMLElement;
  backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(dismissed).toBe(1);
  close();
});

test("mount and unmount are symmetric", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = mount(DangerDialog, {
    target: host,
    props: { copy, t, onDismiss: () => {}, onConfirm: () => {} },
  });
  expect(host.querySelector(".confirm-dialog")).not.toBeNull();
  void unmount(app);
  expect(host.querySelector(".confirm-dialog")).toBeNull();
  host.remove();
});
