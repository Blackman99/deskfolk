/**
 * The quiet-hours card of Settings › Notifications (`settings/NotificationSettings.svelte`): a
 * switch, and while it is on the two times (nsh/base `TimeField`, the Svelte's `<input type=time>`),
 * the time zone the daemon uses and the error for two equal times.
 *
 * Props: `policy`; `loading`; `error` (the equal-times message, or null); `onToggle()`;
 * `onTimes(start, end)`. Test ids: `notif-quiet-switch`, `notif-quiet-start`, `notif-quiet-end`,
 * `notif-quiet-state`, `notif-quiet-error`.
 */
import { Text, View } from "nsh";
import { TimeField } from "nsh/base";
import type { NotificationPolicy } from "../../m/notifications/types.ts";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { Switch } from "../Switch";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { SettingsRow } from "./SettingsRow";
import { Badge, CardIcon } from "./notification-categories";

function TimePicker(props: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <View class="flex-1 flex-col gap-[6px]">
      <Text class="text-[12px] font-medium text-ink-muted">{props.label}</Text>
      <View class="flex-row items-center gap-2 min-h-9 px-[10px] border border-line rounded-(--radius-sm) bg-pane">
        <Icon name="clock" size={16} class="tint-ink-muted" />
        <TimeField
          testID={props.id}
          accessibilityLabel={props.label}
          value={props.value}
          onChange={(e) => props.onChange(e.value)}
          class="flex-row items-center"
          segmentClass="px-[2px] text-[13px] text-ink rounded-(--radius-sm) focus:bg-accent-tint"
          separatorClass="text-[13px] text-ink-muted"
        />
      </View>
    </View>
  );
}

export function NotificationQuietHours(props: {
  policy: NotificationPolicy | null;
  loading: boolean;
  error: string | null;
  onToggle: () => void;
  onTimes: (start: string, end: string) => void;
}) {
  const t = () => copy();
  const en = () => runtime.snapshot.settings.locale === "en";
  const on = () => props.policy?.quiet_hours.enabled ?? false;
  return (
    <SettingsCard testID="notif-quiet-hours">
      <SettingsCardHeader
        title={t().notifications.quietHours}
        subtitle={t().notifications.quietHoursSubtitle}
        icon={<CardIcon name="moon" />}
        end={<Badge tone={on() ? "ok" : "neutral"} testID="notif-quiet-state">{on() ? (en() ? "Active" : "已生效") : en() ? "Disabled" : "未开启"}</Badge>}
      />
      <View class="flex-col gap-3">
        <View class="flex-col border-t border-line-subtle">
          <SettingsRow
            last
            title={t().notifications.quietHoursEnabled}
            desc={en() ? "Suppress external banners and sounds during this window" : "在指定时段内抑制系统通知横幅与提示音，会话列表保留待办"}
          >
            <Switch testID="notif-quiet-switch" label={t().notifications.quietHoursEnabled} checked={on()} disabled={props.loading} onChange={() => props.onToggle()} />
          </SettingsRow>
        </View>
        <If when={on() ? props.policy : null}>
          {(policy) => (
            <View testID="notif-quiet-times" class="flex-col gap-[10px] p-[14px] bg-sidebar-bg border border-line rounded-(--radius-md)">
              <View class="flex-row items-center gap-3">
                <TimePicker id="notif-quiet-start" label={t().notifications.quietHoursStart} value={policy().quiet_hours.start} onChange={(v) => props.onTimes(v, policy().quiet_hours.end)} />
                <Text class="pt-[18px] text-[12px] font-medium text-ink-muted">至</Text>
                <TimePicker id="notif-quiet-end" label={t().notifications.quietHoursEnd} value={policy().quiet_hours.end} onChange={(v) => props.onTimes(policy().quiet_hours.start, v)} />
              </View>
              <If when={policy().quiet_hours.time_zone}>
                {(zone) => (
                  <View class="flex-row items-center gap-[5px] self-start px-2 py-1 rounded-(--radius-sm) bg-chip">
                    <Icon name="globe" size={12} class="tint-ink-muted" />
                    <Text class="text-[12px] text-ink-muted">{`${t().notifications.quietHoursTimeZone}:`}</Text>
                    <Text class="text-[12px] text-ink font-mono">{zone()}</Text>
                  </View>
                )}
              </If>
              <If when={props.error}>
                {(message) => (
                  <View testID="notif-quiet-error" role="alert" class="flex-row items-center gap-[6px] px-[10px] py-[6px] rounded-(--radius-sm) bg-danger-bg border border-danger-line">
                    <Icon name="alert-circle" size={16} class="tint-danger-text" />
                    <Text class="text-[12px] text-danger-text">{message()}</Text>
                  </View>
                )}
              </If>
            </View>
          )}
        </If>
      </View>
    </SettingsCard>
  );
}
