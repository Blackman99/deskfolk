/**
 * The workbench's usage tab (ADR 0080), opened from Tools and the menu bar where the settings
 * say: a bar with when it was checked and Refresh, then the board. A hidden ball is brought
 * back from the bar, since Tools no longer opens it (`UsageTab.svelte`).
 */
import { Scroll, Text, View } from "nsh";
import { copy } from "../../runtime";
import { usageCheckedTime, usageLatestCheck } from "../../m/usage/usage.ts";
import { usageWidget } from "../../m/usage/usage-widget.svelte.ts";
import { Button } from "../Button";
import { UsageBoard } from "./UsageBoard";
import { persistUsageWidget, useUsageFeed } from "./usage-session";

export function UsageTab() {
  persistUsageWidget();
  const { feed, client, locale } = useUsageFeed();
  const checked = () => (feed.agents ? usageCheckedTime(usageLatestCheck(feed.agents), locale()) : null);
  return (
    <View testID="usage-tab" accessibilityLabel={copy().usage.title} class="flex-1 min-h-0 min-w-0 overflow-hidden bg-sidebar-bg">
      <View class="flex-row flex-wrap items-baseline gap-x-[12px] gap-y-[6px] pt-[18px] px-[24px] pb-[14px] border-b border-line shrink-0">
        <Text role="header" class="text-[18px] font-semibold text-ink">{copy().usage.title}</Text>
        <If when={checked()}>
          {(time) => (
            <Text testID="usage-checked" class="text-[12px] text-ink-muted">
              {feed.failed ? copy().usage.stale(time()) : copy().usage.checkedAt(time())}
            </Text>
          )}
        </If>
        <View class="flex-row gap-[8px] ml-auto self-center">
          <If when={usageWidget.hidden}>
            <Button testID="usage-tab-widget" onPress={() => usageWidget.unhide()}>{copy().usage.showWidget}</Button>
          </If>
          <Button
            testID="usage-refresh"
            disabled={feed.busy || !client()}
            onPress={() => {
              const api = client();
              if (api) void feed.load(api, true);
            }}
          >
            {feed.busy ? copy().usage.refreshing : copy().usage.refresh}
          </Button>
        </View>
      </View>
      <Scroll class="flex-1 min-h-0" contentClass="pt-[20px] px-[24px] pb-[32px]">
        <If when={feed.agents}>
          {(agents) => <UsageBoard agents={agents()} locale={locale()} now={feed.now} meter="bar" />}
        </If>
      </Scroll>
    </View>
  );
}
