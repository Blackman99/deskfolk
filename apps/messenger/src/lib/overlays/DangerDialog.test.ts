import { expect, test } from "bun:test";
import { mount, unmount } from "svelte";
import { dangerCopy, type DangerKind } from './danger-confirm.ts';
import { copyFor } from '../copy.ts';
import DangerDialog from "./DangerDialog.svelte";
import { buttonByText, click, render } from "../test-render.ts";

const copy = { title: "删除", body: "删了就没了。", confirm: "确认删除", cancel: "取消" };
const t = { common: { close: "关闭" } } as never;

for (const kind of ['bot', 'group', 'history', 'skill', 'memory', 'provider'] as DangerKind[]) test(`shared ${kind} confirmation is modal, keyboard contained and restores its caller`, () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  let confirmed = 0;
  const { host, close } = render(DangerDialog, { copy: dangerCopy(kind, copyFor('en')), t: copyFor('en'), onDismiss: () => {}, onConfirm: () => confirmed++ });
  const dialog = host.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(host.querySelector('.deny'));
  click(document.activeElement); expect(confirmed).toBe(1);
  close(); expect(document.activeElement).toBe(opener); opener.remove();
});

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
  expect(document.activeElement).toBe(backdrop);
  backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(dismissed).toBe(1);
  close();
});

test("native cancel dismisses without installing a global keyboard listener", () => {
  let dismissed = 0;
  const { host, close } = render(DangerDialog, { copy, t, onDismiss: () => dismissed++, onConfirm: () => {} });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(dismissed).toBe(0);
  const cancel = new Event('cancel', { cancelable: true });
  host.querySelector('dialog')!.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(dismissed).toBe(1);
  close();
});

test('Tab and Shift+Tab wrap within confirmation controls and teardown restores the opener', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const { host, close } = render(DangerDialog, { copy, t, onDismiss: () => {}, onConfirm: () => {} });
  const dialog = host.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  const buttons = [...dialog.querySelectorAll('button')];
  const tab = (shiftKey = false) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
  for (let i = 0; i < 7; i++) { tab(); expect(document.activeElement).toBe(buttons[i % 3]); }
  tab(true); expect(document.activeElement).toBe(buttons[2]);
  close(); expect(document.activeElement).toBe(opener); opener.remove();
});

test('nested native modal restores focus in its parent without closing that overlay', () => {
  const parent = document.createElement('dialog');
  const opener = document.createElement('button'); parent.append(opener); document.body.append(parent); parent.showModal(); opener.focus();
  const { close } = render(DangerDialog, { copy, t, onDismiss: () => {}, onConfirm: () => {} });
  close(); expect(parent.open).toBe(true); expect(document.activeElement).toBe(opener);
  parent.close(); parent.remove();
});

test('busy confirmation contains Tab and refuses Escape, native cancel and duplicate confirmation', () => {
  let dismissed = 0; let confirmed = 0;
  const { host, close } = render(DangerDialog, { copy, t, busy: true, onDismiss: () => dismissed++, onConfirm: () => confirmed++ });
  const dialog = host.querySelector('dialog')!;
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(dialog);
  for (const button of dialog.querySelectorAll('button')) { expect(button.disabled).toBe(true); button.click(); }
  expect(dismissed).toBe(0); expect(confirmed).toBe(0); close();
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
