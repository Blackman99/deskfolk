/**
 * The device card of Settings › Notifications (`settings/NotificationSettings.svelte`): whether
 * this device notifies, the health of its push (a desktop shell asks the system for permission;
 * a web client reads the push health), sound, preview, badge, and the test notification.
 *
 * Props: `device`; `pushHealth`; `deviceLoading`; `testBusy`; `testFeedback`; `disableFeedback`;
 * `canSendTest`; `usesNativeTestGate`; `onToggle()`; `onRepair()`; `onSendTest()`. Test ids:
 * `notif-device-switch`, `notif-device-state`, `notif-health-${kind}`, `notif-repair`,
 * `notif-sound`, `notif-preview`, `notif-badge`, `notif-send-test`, `notif-test-feedback`,
 * `notif-test-disabled`.
 */
import { Text, View, type JSX } from "nsh";
import type { NotificationDevice } from "../../m/notifications/types.ts";
import type { PushHealth } from "../../m/notifications/tab-owner.ts";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { Select } from "../Select";
import { Switch } from "../Switch";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { SettingsRow } from "./SettingsRow";
import { Badge, CardIcon } from "./notification-categories";

type Tone = "danger" | "warn" | "info" | "muted";
const NOTICE: Record<Tone, { box: string; ink: string; tint: string }> = {
  danger: { box: "bg-danger-bg border-danger-line", ink: "text-danger-text", tint: "tint-danger-text" },
  warn: { box: "bg-warn-bg border-warn-line", ink: "text-warn-text", tint: "tint-warn-text" },
  info: { box: "bg-accent-tint border-accent-border", ink: "text-brand", tint: "tint-brand" },
  muted: { box: "bg-sidebar-bg border-line", ink: "text-ink-muted", tint: "tint-ink-muted" },
};

function Notice(props: { tone: Tone; icon: IconName; testID: string; alert?: boolean; children: JSX.Element }) {
  const look = () => NOTICE[props.tone];
  return (
    <View testID={props.testID} role={props.alert ? "alert" : "group"} class={`flex-row items-center gap-2 px-3 py-[10px] border rounded-(--radius-md) ${look().box}`}>
      <Icon name={props.icon} size={16} class={look().tint} />
      <Text class={`flex-1 min-w-0 text-[13px] leading-[1.4] ${look().ink}`}>{props.children}</Text>
    </View>
  );
}

export function NotificationDeviceCard(props: {
  device: NotificationDevice | null;
  pushHealth: PushHealth;
  deviceLoading: boolean;
  testBusy: boolean;
  testFeedback: string | null;
  disableFeedback: string | null;
  canSendTest: boolean;
  usesNativeTestGate: boolean;
  onToggle: () => void;
  onRepair: () => void;
  onSendTest: () => void;
}) {
  const t = () => copy();
  const n = () => t().notifications;
  const en = () => runtime.snapshot.settings.locale === "en";
  const enabled = () => props.device?.enabled ?? false;
  const masterRow = (desc: string) => (
    <View class="flex-col border-t border-line-subtle">
      <SettingsRow last title={n().deviceEnable} desc={desc} testID="notif-device-row">
        <Switch testID="notif-device-switch" label={n().deviceEnable} checked={enabled()} disabled={props.deviceLoading} onChange={() => props.onToggle()} />
      </SettingsRow>
    </View>
  );
  const desktopBranch = () => (
    <>
      <If when={runtime.pushPermission === "denied"}>
        <Notice tone="danger" icon="alert-circle" alert testID="notif-health-denied">{n().permissionDenied}</Notice>
      </If>
      {masterRow(enabled() ? n().deviceEnabledDesktopNote : n().deviceDisabled)}
    </>
  );
  const health = () => props.pushHealth;
  const webBranch = () => (
    <>
      <If when={health() === "unsupported"}>
        <Notice tone="muted" icon="alert-circle" testID="notif-health-unsupported">{n().pushUnsupported}</Notice>
      </If>
      <If when={health() === "install_required"}>
        <Notice tone="info" icon="upload" testID="notif-health-install_required">{n().iosInstallRequired}</Notice>
      </If>
      <If when={health() === "denied"}>
        <Notice tone="danger" icon="alert-circle" alert testID="notif-health-denied">{n().permissionDenied}</Notice>
      </If>
      <If when={health() === "gated"}>
        <Notice tone="warn" icon="alert-triangle" testID="notif-health-gated">{n().remoteGated}</Notice>
      </If>
      <If when={health() === "paused_upgrade"}>
        <Notice tone="muted" icon="clock" testID="notif-health-paused_upgrade">{n().pushUpgrading}</Notice>
      </If>
      <If when={health() === "needs_repair"}>
        <View testID="notif-health-needs_repair" class="flex-row items-center justify-between gap-2 px-3 py-[10px] border rounded-(--radius-md) bg-warn-bg border-warn-line">
          <View class="flex-row items-center gap-2 min-w-0 flex-1">
            <Icon name="alert-triangle" size={16} class="tint-warn-text" />
            <Text class="flex-1 min-w-0 text-[13px] font-medium text-warn-text">{n().needsRepair}</Text>
          </View>
          <View
            role="button"
            testID="notif-repair"
            disabled={props.deviceLoading || runtime.pushBusy}
            onPress={() => props.onRepair()}
            class="shrink-0 px-3 py-[5px] rounded-(--radius-sm) bg-warn disabled:opacity-[0.5]"
          >
            <Text class="text-[12px] font-semibold text-on-warn">{n().repairButton}</Text>
          </View>
        </View>
      </If>
      <If when={!["unsupported", "install_required", "denied", "gated", "paused_upgrade", "needs_repair"].includes(health())}>
        {masterRow(enabled() ? (en() ? "Web Push delivery is active for this device" : "通过 Web Push 推送在当前设备接收通知") : n().deviceDisabled)}
      </If>
      <If when={runtime.pushError === "failed"}>
        <View testID="notif-push-failed" role="alert" class="flex-row flex-wrap items-center gap-[6px] px-3 py-[10px] border rounded-(--radius-md) bg-danger-bg border-danger-line">
          <Text class="text-[13px] text-danger-text">{t().remote.pushFailed}</Text>
          <If when={runtime.pushErrorCode}>
            <Text class="text-[13px] text-danger-text font-mono">{runtime.pushErrorCode ?? ""}</Text>
          </If>
        </View>
      </If>
      <If when={props.disableFeedback}>
        {(message) => (
          <Notice tone="warn" icon="alert-triangle" testID="notif-disable-feedback">{message()}</Notice>
        )}
      </If>
    </>
  );
  return (
    <SettingsCard testID="notif-device">
      <SettingsCardHeader
        title={n().deviceNotifications}
        subtitle={n().deviceSubtitle}
        icon={<CardIcon name="bell" />}
        end={<Badge tone={enabled() ? "ok" : "neutral"} testID="notif-device-state">{enabled() ? n().deviceEnabled : n().deviceDisabled}</Badge>}
      />
      <View class="flex-col gap-3">
        <If when={runtime.isDesktopShell} else={webBranch()}>
          {desktopBranch()}
        </If>

        <If when={props.device?.enabled ? props.device : null}>
          {(device) => (
            <View class="flex-col border-t border-line-subtle">
              <SettingsRow
                title={n().deviceSound}
                desc={en() ? "Play audio alert when new notification arrives" : "接收到通知时播放系统声音提示"}
              >
                <If
                  when={runtime.hosted}
                  else={
                    <Select
                      testID="notif-sound"
                      ariaLabel={n().deviceSound}
                      value={device().sound}
                      options={[
                        { value: "default", label: en() ? "Default" : "默认" },
                        { value: "system", label: en() ? "System" : "系统" },
                        { value: "off", label: en() ? "Mute" : "静音" },
                      ]}
                      onChange={(value) => void runtime.patchNotificationDevice({ sound: value as NotificationDevice["sound"] })}
                    />
                  }
                >
                  <View class="px-2 py-1 rounded-(--radius-sm) bg-chip">
                    <Text class="text-[12px] text-ink-muted">{en() ? "Managed by system" : "由系统管理"}</Text>
                  </View>
                </If>
              </SettingsRow>
              <SettingsRow
                title={n().devicePreview}
                desc={en() ? "Information detail visible in banners and lock screen" : "横幅与锁屏通知中展示的内容详细度"}
              >
                <If
                  when={runtime.hosted}
                  else={
                    <Select
                      testID="notif-preview"
                      ariaLabel={n().devicePreview}
                      value={device().preview}
                      options={[
                        { value: "generic", label: n().previewGeneric },
                        { value: "reply_excerpt", label: n().previewExcerpt },
                      ]}
                      onChange={(value) => void runtime.patchNotificationDevice({ preview: value as NotificationDevice["preview"] })}
                    />
                  }
                >
                  <View class="px-2 py-1 rounded-(--radius-sm) bg-chip">
                    <Text class="text-[12px] text-ink-muted">{n().previewGeneric}</Text>
                  </View>
                </If>
              </SettingsRow>
              <SettingsRow last title={n().deviceBadge} desc={en() ? "Show unread count badge on app icon" : "在应用图标或 Dock 上标出未读计数"}>
                <Switch testID="notif-badge" label={n().deviceBadge} checked={device().badge} onChange={(checked) => void runtime.patchNotificationDevice({ badge: checked })} />
              </SettingsRow>
            </View>
          )}
        </If>

        <View class={`pt-1 gap-3 ${narrowWindow() ? "flex-col items-start" : "flex-row items-center"}`}>
          <Button
            testID="notif-send-test"
            icon={props.testBusy ? "spinner" : "send"}
            disabled={props.testBusy || !props.canSendTest}
            onPress={() => props.onSendTest()}
          >
            {props.testBusy ? n().testSubmitting : n().sendTest}
          </Button>
          <If
            when={props.testFeedback}
            else={
              <If when={props.usesNativeTestGate && !runtime.nativeCapabilities.native_delivery_v1}>
                <Text testID="notif-test-disabled" class="flex-1 min-w-0 text-[12px] leading-[1.35] text-ink-muted">{n().nativeTestDisabled}</Text>
              </If>
            }
          >
            {(message) => (
              <View testID="notif-test-feedback" role="text" class="flex-row items-center gap-[5px] flex-1 min-w-0">
                <Icon name="check-circle" size={16} class="tint-ok-text" />
                <Text class="flex-1 min-w-0 text-[12px] leading-[1.35] text-ok-text">{message()}</Text>
              </View>
            )}
          </If>
        </View>
      </View>
    </SettingsCard>
  );
}
