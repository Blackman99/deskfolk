import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { ApiError } from "../api.ts";
import { click, render } from "../test-render.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { MessengerRuntime } from "../runtime.svelte.ts";
import NotificationSettings from "./NotificationSettings.svelte";
import type { NotificationPolicy } from "../notifications/types.ts";

import { reactive } from "../test-reactive.svelte.ts";

const t = copyFor("zh");

function mountSettings(overrides: {
  policy?: NotificationPolicy;
  pushPermission?: "default" | "granted" | "denied" | "unsupported";
  deviceEnabled?: boolean;
  remoteGated?: boolean;
  isDesktopShell?: boolean;
  nativeDelivery?: boolean;
  remote?: boolean;
} = {}) {
  const runtime = reactive(fakeRuntime());
  runtime.connection = "connected";
  runtime.pushPermission = overrides.pushPermission ?? "granted";
  if (overrides.remoteGated !== undefined) runtime.remoteGated = overrides.remoteGated;
  runtime.isDesktopShell = overrides.isDesktopShell ?? false;
  runtime.remote = overrides.remote ?? false;
  runtime.nativeCapabilities = {
    native_reading_v1: false,
    native_delivery_v1: overrides.nativeDelivery ?? false,
  };
  runtime.notificationPolicy = overrides.policy ?? {
    revision: 1,
    categories: {
      approval: true,
      ask: true,
      failure: true,
      interrupted: true,
      reply: true,
      routine_result: true,
    },
    quiet_hours: {
      enabled: false,
      start: "22:00",
      end: "08:00",
      time_zone: "Asia/Shanghai",
    },
  };
  runtime.notificationDevice = {
    revision: 1,
    enabled: overrides.deviceEnabled ?? false,
    badge: true,
    sound: "default",
    preview: "generic",
  };

  const view = render(NotificationSettings, {
    runtime,
    t,
  });
  return { ...view, runtime };
}

test("notification settings renders categories and quiet hours", () => {
  const { host, close } = mountSettings();
  expect(host.textContent).toContain(t.notifications.sectionCategories);
  expect(host.textContent).toContain(t.notifications.catApproval);
  expect(host.textContent).toContain(t.notifications.catAsk);
  expect(host.textContent).toContain(t.notifications.quietHours);
  expect(host.textContent).toContain(t.notifications.deviceNotifications);
  close();
});

test("toggling category calls patchNotificationPolicy", () => {
  const { host, runtime, close } = mountSettings();
  const checkboxes = host.querySelectorAll<HTMLInputElement>(".category-toggle-item input[type='checkbox']");
  expect(checkboxes.length).toBe(6);
  click(checkboxes[0]);
  expect(runtime.calls.some((c) => c.name === "patchNotificationPolicy")).toBe(true);
  close();
});

test("toggling quiet hours calls patchNotificationPolicy", () => {
  const { host, runtime, close } = mountSettings();
  const quietHoursCheckbox = host.querySelector(".quiet-hours-body input[type='checkbox']") as HTMLInputElement;
  click(quietHoursCheckbox);
  expect(runtime.calls.some((c) => c.name === "patchNotificationPolicy")).toBe(true);
  close();
});

test("device toggle calls enableDeviceNotifications and refreshes notification device", async () => {
  const { host, runtime, close } = mountSettings({ deviceEnabled: false });
  const deviceToggle = host.querySelector(".device-body input[type='checkbox']") as HTMLInputElement;
  click(deviceToggle);
  await new Promise((r) => setTimeout(r, 10));
  expect(runtime.calls.some((c) => c.name === "enableDeviceNotifications")).toBe(true);
  expect(runtime.calls.some((c) => c.name === "loadNotificationDevice")).toBe(true);
  close();
});

test("desktop test stays disabled when native delivery is unqualified even if the device is enabled", () => {
  const { host, close } = mountSettings({ deviceEnabled: true, isDesktopShell: true, nativeDelivery: false });
  const testBtn = host.querySelector(".test-row button") as HTMLButtonElement;
  expect(testBtn.disabled).toBe(true);
  expect(host.textContent).toContain(t.notifications.nativeTestDisabled);
  close();
});

test("local browser test stays disabled when native delivery is unqualified even if the device is enabled", () => {
  const { host, close } = mountSettings({ deviceEnabled: true, isDesktopShell: false, remote: false, nativeDelivery: false });
  const testBtn = host.querySelector(".test-row button") as HTMLButtonElement;
  expect(testBtn.disabled).toBe(true);
  expect(host.textContent).toContain(t.notifications.nativeTestDisabled);
  close();
});

test("send test button dispatches sendTestNotification when remote device is enabled", async () => {
  const { host, runtime, close } = mountSettings({ deviceEnabled: true, remote: true });
  runtime.sendTestNotification = async () => {
    runtime.calls.push({ name: "sendTestNotification", args: [] });
    return { ok: true, status: "accepted" };
  };
  const testBtn = host.querySelector(".test-row button") as HTMLButtonElement;
  expect(testBtn.disabled).toBe(false);
  click(testBtn);
  await new Promise((r) => setTimeout(r, 10));
  expect(runtime.calls.some((c) => c.name === "sendTestNotification")).toBe(true);
  expect(host.textContent).toContain(t.notifications.testRemoteAccepted);
  close();
});

test("remote queued tests describe Web Push delivery", async () => {
  const { host, runtime, close } = mountSettings({ deviceEnabled: true, remote: true });
  runtime.sendTestNotification = async () => ({ ok: true, status: "queued" });
  click(host.querySelector(".test-row button"));
  await new Promise((r) => setTimeout(r, 10));
  expect(host.textContent).toContain("等待执行 Mac 向推送服务投递");
  expect(host.textContent).not.toContain("等待本机投递槽");
  close();
});

test("remote timeout explains the host network failure and pending retry", async () => {
  const { host, runtime, close } = mountSettings({ deviceEnabled: true, remote: true });
  runtime.sendTestNotification = async () => ({ ok: true, status: "queued", error_code: "timeout" });
  click(host.querySelector(".test-row button"));
  await new Promise((r) => setTimeout(r, 10));
  expect(host.textContent).toContain("执行 Mac 连接推送服务超时");
  close();
});

test.each([
  ["push_pending", "上一条推送仍在发送或等待重试"],
  ["rate_limited", "每 60 秒"],
  ["push_contact_required", "联系人"],
  ["no_subscription", "重新开启"],
  ["rejected", "rejected"],
])("remote test explains %s without showing the generic rejection", async (code, expected) => {
  const { host, runtime, close } = mountSettings({ deviceEnabled: true, remote: true });
  runtime.sendTestNotification = async () => { throw new ApiError(409, code, "remote request rejected"); };
  click(host.querySelector(".test-row button"));
  await new Promise((r) => setTimeout(r, 10));
  expect(host.querySelector(".test-feedback")?.textContent).toContain(expected);
  expect(host.querySelector(".test-feedback")?.textContent).not.toContain("remote request rejected");
  close();
});

test("failed enable is visible and restores the unchecked device switch", async () => {
  const { host, runtime, close } = mountSettings({ deviceEnabled: false, remote: true });
  runtime.loadNotificationDevice = async () => {};
  runtime.enableDeviceNotifications = async () => {
    runtime.pushError = "failed";
    runtime.pushErrorCode = "revision_conflict";
    return false;
  };
  const toggle = host.querySelector<HTMLInputElement>(".device-master-row input")!;
  click(toggle);
  await new Promise((r) => setTimeout(r, 10));
  expect(host.textContent).toContain(t.remote.pushFailed);
  expect(toggle.checked).toBe(false);
  expect(host.querySelector<HTMLButtonElement>(".btn-send-test")!.disabled).toBe(true);
  close();
});

test("permission denied shows warning message", () => {
  const { host, close } = mountSettings({ pushPermission: "denied" });
  expect(host.textContent).toContain(t.notifications.permissionDenied);
  close();
});

test("remote gated shows remote activation warning", () => {
  const { host, close } = mountSettings({ remoteGated: true });
  expect(host.textContent).toContain(t.notifications.remoteGated);
  close();
});
