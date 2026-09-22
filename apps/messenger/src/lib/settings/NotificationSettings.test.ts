import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import NotificationSettings from "./NotificationSettings.svelte";
import type { NotificationPolicy } from "../notifications/types.ts";

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
  const runtime = fakeRuntime();
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

test("device toggle calls enableDeviceNotifications or disableDeviceNotifications", () => {
  const { host, runtime, close } = mountSettings({ deviceEnabled: false });
  const deviceToggle = host.querySelector(".device-body input[type='checkbox']") as HTMLInputElement;
  click(deviceToggle);
  expect(runtime.calls.some((c) => c.name === "enableDeviceNotifications")).toBe(true);
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
  expect(host.textContent).toContain(t.notifications.testSent);
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
