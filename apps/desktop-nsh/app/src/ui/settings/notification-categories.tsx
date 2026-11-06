/**
 * The first card of Settings › Notifications (`settings/NotificationSettings.svelte`): which
 * categories of event notify, six switches in two columns while the card has room. Pressing a
 * row's words or its switch toggles it.
 *
 * Props: `policy` (null before it loaded: every category reads on); `loading`; `onToggle(key)`.
 * Test ids: `notif-cat-${key}` (the switch), `notif-cat-count`.
 */
import { Text, View, windowSize } from "nsh";
import type { NotificationPolicy } from "../../m/notifications/types.ts";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { Switch } from "../Switch";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { CATEGORY_LOOK, categoryList, type CategoryKey } from "./notification-view";

export function CardIcon(props: { name: Parameters<typeof Icon>[0]["name"] }) {
  return (
    <View class="w-[30px] h-[30px] rounded-(--radius-md) bg-accent-tint items-center justify-center shrink-0">
      <Icon name={props.name} size={16} class="tint-brand" />
    </View>
  );
}

export function Badge(props: { tone: "ok" | "neutral" | "warn"; testID?: string; children: string }) {
  const box = () => (props.tone === "ok" ? "bg-ok-bg border-ok-line" : props.tone === "warn" ? "bg-warn-bg border-warn-line" : "bg-chip border-chip-line");
  const ink = () => (props.tone === "ok" ? "text-ok-text" : props.tone === "warn" ? "text-warn-text" : "text-ink-muted");
  return (
    <View testID={props.testID} class={`shrink-0 px-2 py-[2px] border rounded-(--radius-full) ${box()}`}>
      <Text class={`text-[11px] font-semibold ${ink()}`}>{props.children}</Text>
    </View>
  );
}

export function NotificationCategories(props: {
  policy: NotificationPolicy | null;
  loading: boolean;
  onToggle: (key: CategoryKey) => void;
}) {
  const t = () => copy();
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const rows = () => categoryList(props.policy?.categories, t(), locale());
  const active = () => (props.policy ? Object.values(props.policy.categories).filter(Boolean).length : 0);
  // Two columns while the card has room (the Svelte's container query at 480px).
  const wide = () => windowSize().width > 600;
  const row = (cat: ReturnType<typeof rows>[number], at: number, total: number) => {
    const look = CATEGORY_LOOK[cat.key];
    const lastRow = wide() ? at >= total - 2 : at === total - 1;
    return (
      <View
        testID={`notif-cat-row-${cat.key}`}
        class={`flex-row items-center justify-between gap-3 py-2 min-h-[56px] ${wide() ? "w-[48%]" : "w-full"} ${lastRow ? "" : "border-b border-line-subtle"}`}
      >
        <View
          role="button"
          accessibilityLabel={cat.label}
          disabled={props.loading}
          onPress={() => props.onToggle(cat.key)}
          class="flex-row items-center gap-[10px] min-w-0 flex-1 px-[6px]"
        >
          <View class={`w-8 h-8 rounded-(--radius-sm) items-center justify-center shrink-0 ${look.box}`}>
            <Icon name={look.icon} size={16} class={look.tint} />
          </View>
          <View class="flex-col gap-[2px] min-w-0 flex-1">
            <Text class="text-[13px] font-medium text-ink leading-[1.3]">{cat.label}</Text>
            <Text class="text-[12px] text-ink-muted leading-[1.35]">{cat.desc}</Text>
          </View>
        </View>
        <View class="shrink-0 pr-[6px]">
          <Switch testID={`notif-cat-${cat.key}`} label={cat.label} checked={cat.checked} disabled={props.loading} onChange={() => props.onToggle(cat.key)} />
        </View>
      </View>
    );
  };
  return (
    <SettingsCard testID="notif-categories">
      <SettingsCardHeader
        title={t().notifications.sectionCategories}
        subtitle={t().notifications.categoriesSubtitle}
        icon={<CardIcon name="grid" />}
        end={<If when={props.policy}><Badge tone="ok" testID="notif-cat-count">{`${active()} / 6`}</Badge></If>}
      />
      <View class={`border-t border-line-subtle ${wide() ? "flex-row flex-wrap gap-x-5" : "flex-col"}`}>
        {() => rows().map((cat, at) => row(cat, at, rows().length))}
      </View>
    </SettingsCard>
  );
}
