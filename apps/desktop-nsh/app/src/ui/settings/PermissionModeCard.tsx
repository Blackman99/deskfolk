/**
 * Settings › General: the app's permission mode (ADR 0092), what every Bot without its own may do
 * without asking you (`settings/PermissionModeCard.svelte`). One choice of four, saved as it is
 * picked; the Bots that chose their own are named under it, so a Bot behaving otherwise is not a
 * mystery.
 *
 * Props: `mode` (the saved one); `bots`; `onChoose(mode)` (resolves false when it could not be
 * saved). Test ids: `permission-modes` (the group), `permission-mode-<mode>` (each option),
 * `permission-overrides`, `permission-save-failed`.
 */
import { effect, signal, Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type Bot, type PermissionMode } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";

export function PermissionModeCard(props: {
  mode: PermissionMode;
  bots: readonly Bot[];
  onChoose: (mode: PermissionMode) => Promise<boolean>;
}) {
  const t = () => copy().permissions;
  const busy = signal(false);
  const failed = signal(false);
  /** The mode just picked, shown until the saved one catches up; dropped again if it did not save. */
  const picked = signal<PermissionMode | null>(null);
  const shown = () => picked() ?? props.mode;

  effect(() => {
    if (picked() !== null && props.mode === picked()) picked.set(null);
  });

  const overrides = () =>
    props.bots
      .filter((bot) => !bot.archived_at && bot.permission_mode)
      .map((bot) => t().overrideItem(bot.name, t().modes[bot.permission_mode!]));

  async function choose(next: PermissionMode): Promise<void> {
    if (busy() || next === shown()) return;
    busy.set(true);
    failed.set(false);
    picked.set(next);
    try {
      failed.set(!(await props.onChoose(next)));
    } catch {
      failed.set(true);
    } finally {
      busy.set(false);
      if (failed()) picked.set(null);
    }
  }

  return (
    <SettingsCard testID="settings-card-permission-mode">
      <SettingsCardHeader
        title={t().title}
        subtitle={t().subtitle}
        icon={
          <View class="w-[30px] h-[30px] rounded-(--radius-md) bg-accent-tint items-center justify-center shrink-0">
            <Icon name="shield-check" class="tint-brand" />
          </View>
        }
      />
      <RadioGroup testID="permission-modes" class="flex-col gap-[6px] mt-1">
        <Each of={PERMISSION_MODES} key={(option) => option}>
          {(option) => (
            <Radio
              testID={`permission-mode-${option()}`}
              accessibilityLabel={t().modes[option()]}
              checked={shown() === option()}
              disabled={busy()}
              onChange={() => void choose(option())}
              class={`group flex-row items-start gap-[10px] px-3 py-[9px] border rounded-(--radius-md) disabled:opacity-[0.6] ${
                shown() === option() ? "border-brand bg-accent-tint" : "border-line-subtle hover:border-line-hover"
              }`}
            >
              <View
                class={`w-[14px] h-[14px] mt-[3px] shrink-0 rounded-full border items-center justify-center ${
                  shown() === option() ? "border-brand bg-brand" : "border-line-hover bg-input-bg"
                }`}
              >
                <If when={shown() === option()}>
                  <View class="w-[6px] h-[6px] rounded-full bg-on-accent" />
                </If>
              </View>
              <View class="flex-col gap-[2px] min-w-0 shrink grow">
                <View class="flex-row items-center gap-[6px]">
                  <Text class="text-[13px] font-semibold text-ink">{t().modes[option()]}</Text>
                  <If when={option() === DEFAULT_PERMISSION_MODE}>
                    <View class="px-[6px] rounded-full bg-line-subtle">
                      <Text class="text-[11px] font-semibold leading-4 text-ink-muted">{t().defaultTag}</Text>
                    </View>
                  </If>
                </View>
                <Text class={`text-[12px] leading-[1.45] ${shown() === option() ? "text-ink-secondary" : "text-ink-muted"}`}>
                  {t().descriptions[option()]}
                </Text>
              </View>
            </Radio>
          )}
        </Each>
      </RadioGroup>
      <If when={failed()}>
        <Text role="alert" testID="permission-save-failed" class="text-[12px] text-danger-text">
          {t().saveFailed}
        </Text>
      </If>
      <If when={overrides().length > 0}>
        <Text testID="permission-overrides" class="mt-2 text-[12px] leading-[1.45] text-ink-muted">
          {t().overrides(overrides())}
        </Text>
      </If>
      <Text class="mt-2 text-[12px] leading-[1.45] text-ink-muted">{t().alwaysRefused}</Text>
    </SettingsCard>
  );
}
