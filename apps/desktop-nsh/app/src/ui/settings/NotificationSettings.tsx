/**
 * Settings › Notifications (`settings/NotificationSettings.svelte`): which categories notify,
 * quiet hours, and this device's notifications with a test. The state and the actions are here; the
 * three cards are `notification-categories.tsx`, `notification-quiet-hours.tsx` and
 * `notification-device.tsx`.
 *
 * A desktop shell asks the system for the notification permission through the runtime
 * (`requestDesktopNotificationPermission`, which calls the shell's `request_notification_permission`
 * and polls `notification_permission_state`). A shell that does not answer them leaves the runtime's
 * state as the messenger has it: permission "default", no native delivery, so the switch shows off
 * and the test button is disabled with the native-test hint.
 */
import { effect, signal, untracked, View } from "nsh";
import { ApiError } from "../../m/api.ts";
import { classifyPushHealth } from "../../m/notifications/tab-owner.ts";
import { pushPermission } from "../../m/remote/push.ts";
import { copy, runtime } from "../../runtime";
import { NotificationCategories } from "./notification-categories";
import { NotificationDeviceCard } from "./notification-device";
import { NotificationQuietHours } from "./notification-quiet-hours";
import { closeFeedback, testErrorText, type CategoryKey } from "./notification-view";

export function NotificationSettings() {
  const t = () => copy();
  const policyLoading = signal(false);
  const deviceLoading = signal(false);
  const testBusy = signal(false);
  const testFeedback = signal<string | null>(null);
  const quietHoursError = signal<string | null>(null);
  const disableFeedback = signal<string | null>(null);

  untracked(() => {
    if (runtime.connection === "connected" && !runtime.isDesktopShell && typeof runtime.prefetchPushState === "function") {
      void runtime.prefetchPushState();
    }
  });

  async function loadPolicyAndDevice(): Promise<void> {
    if (!runtime.client) return;
    try {
      policyLoading.set(true);
      if ("getNotificationPolicy" in runtime.client) await runtime.loadNotificationPolicy();
      if ("getNotificationDevice" in runtime.client) await runtime.loadNotificationDevice();
    } catch {
      // Handled gracefully in UI
    } finally {
      policyLoading.set(false);
    }
  }
  effect(() => {
    if (runtime.connection === "connected") untracked(() => void loadPolicyAndDevice());
  });

  const policy = () => runtime.notificationPolicy;
  const device = () => runtime.notificationDevice;

  async function toggleCategory(category: CategoryKey): Promise<void> {
    const current = policy();
    if (!current) return;
    await runtime.patchNotificationPolicy({ categories: { [category]: !current.categories[category] } });
  }
  async function toggleQuietHours(): Promise<void> {
    const current = policy();
    if (!current) return;
    await runtime.patchNotificationPolicy({ quiet_hours: { enabled: !current.quiet_hours.enabled } });
  }
  async function updateQuietHoursTimes(start: string, end: string): Promise<void> {
    if (!policy()) return;
    if (start === end) {
      quietHoursError.set(t().notifications.quietHoursEqualTimes);
      return;
    }
    quietHoursError.set(null);
    await runtime.patchNotificationPolicy({ quiet_hours: { start, end } });
  }

  const permission = () => runtime.pushPermission || pushPermission();
  const nav = (globalThis as { navigator?: { standalone?: boolean; userAgent?: string } }).navigator;
  const pushHealth = () =>
    classifyPushHealth({
      permission: permission(),
      standalone: nav?.standalone === true,
      ios: /iPad|iPhone|iPod/.test(nav?.userAgent ?? ""),
      transport: runtime.pushTransport,
      enabled: device()?.enabled ?? false,
      subscribed: runtime.pushSubscribed || (device()?.enabled ?? false),
      recovery: runtime.pushRecovery ?? "none",
      remoteGate: runtime.remoteGated,
    });

  async function handleDeviceToggle(): Promise<void> {
    disableFeedback.set(null);
    if (runtime.isDesktopShell) {
      if (device()?.enabled) await runtime.patchNotificationDevice({ enabled: false });
      else await runtime.requestDesktopNotificationPermission();
      return;
    }
    deviceLoading.set(true);
    try {
      if (device()?.enabled) {
        const outcome = await runtime.disableDeviceNotifications();
        if (typeof outcome === "object") disableFeedback.set(closeFeedback(outcome, t()));
      } else {
        await runtime.enableDeviceNotifications();
      }
      if (typeof runtime.loadNotificationDevice === "function") await runtime.loadNotificationDevice();
    } finally {
      deviceLoading.set(false);
    }
  }

  async function handleRepair(): Promise<void> {
    deviceLoading.set(true);
    try {
      await runtime.enableDeviceNotifications();
      await runtime.loadNotificationDevice();
    } finally {
      deviceLoading.set(false);
    }
  }

  const usesNativeTestGate = () => runtime.isDesktopShell || !runtime.remote;
  const canSendDesktopTest = () =>
    Boolean(usesNativeTestGate() && runtime.nativeCapabilities.native_delivery_v1 && runtime.pushPermission === "granted" && device()?.enabled);
  const canSendRemoteTest = () =>
    Boolean(
      !usesNativeTestGate() &&
        device()?.enabled &&
        !runtime.remoteGated &&
        !["gated", "paused_upgrade", "unsupported", "denied", "install_required"].includes(pushHealth()),
    );
  const canSendTest = () => canSendDesktopTest() || canSendRemoteTest();

  async function handleSendTest(): Promise<void> {
    if (testBusy() || !canSendTest()) return;
    testBusy.set(true);
    testFeedback.set(null);
    try {
      const result = await runtime.sendTestNotification();
      const n = t().notifications;
      if (!usesNativeTestGate() && result.error_code === "timeout") testFeedback.set(n.testRemoteTimeout);
      else if (result.status === "accepted") testFeedback.set(usesNativeTestGate() ? n.testSent : n.testRemoteAccepted);
      else testFeedback.set(usesNativeTestGate() ? n.testQueued : n.testRemoteQueued);
    } catch (err) {
      testFeedback.set(testErrorText(err instanceof ApiError ? err.code : null, t()));
    } finally {
      testBusy.set(false);
    }
  }

  return (
    <View testID="notification-settings" class="flex-col gap-[14px]">
      <NotificationCategories policy={policy()} loading={policyLoading()} onToggle={(key) => void toggleCategory(key)} />
      <NotificationQuietHours
        policy={policy()}
        loading={policyLoading()}
        error={quietHoursError()}
        onToggle={() => void toggleQuietHours()}
        onTimes={(start, end) => void updateQuietHoursTimes(start, end)}
      />
      <NotificationDeviceCard
        device={device()}
        pushHealth={pushHealth()}
        deviceLoading={deviceLoading()}
        testBusy={testBusy()}
        testFeedback={testFeedback()}
        disableFeedback={disableFeedback()}
        canSendTest={canSendTest()}
        usesNativeTestGate={usesNativeTestGate()}
        onToggle={() => void handleDeviceToggle()}
        onRepair={() => void handleRepair()}
        onSendTest={() => void handleSendTest()}
      />
    </View>
  );
}
