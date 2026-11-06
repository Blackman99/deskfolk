/**
 * A phone's usage page (ADR 0080), opened from Tools in place of the list: Back on the left, the
 * title in the middle, then the usage tab's board in one column — each agent under its own
 * head, a card per account, each window a dial — and when it was checked with Refresh
 * (`UsagePage.svelte`).
 */
import { safeArea, Scroll, Text, View } from "nsh";
import { copy } from "../../runtime";
import { usageCheckedTime, usageLatestCheck } from "../../m/usage/usage.ts";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { UsageBoard } from "./UsageBoard";
import { useUsageFeed } from "./usage-session";

export function UsagePage(props: { onBack: () => void }) {
  const { feed, client, locale } = useUsageFeed();
  const checked = () => (feed.agents ? usageCheckedTime(usageLatestCheck(feed.agents), locale()) : null);
  return (
    <View class="flex-1 min-h-0 bg-sidebar-bg">
      <View
        class="flex-row items-center justify-between min-h-[52px] pb-[6px] pl-[8px] pr-[12px] bg-pane border-b border-line shrink-0"
        style={{ paddingTop: Math.max(6, safeArea().top) }}
      >
        <IconButton testID="usage-page-back" icon="chevron-left" size="lg" label={copy().usage.back} onPress={props.onBack} />
        <Text role="header" class="text-[16px] font-semibold text-ink">{copy().usage.title}</Text>
        <View class="w-[38px] shrink-0" accessible={false} />
      </View>
      <Scroll testID="usage-page" class="flex-1 min-h-0" contentClass="pt-[16px] px-[16px] pb-[76px]">
        <If when={feed.agents}>
          {(agents) => (
            <>
              <UsageBoard agents={agents()} locale={locale()} now={feed.now} meter="dial" />
              <If when={agents().length > 0}>
                <View class="flex-row items-center justify-between gap-[12px] mt-[20px] pt-[14px] border-t border-line">
                  <Text testID="usage-checked" class="text-[12px] text-ink-muted">
                    {checked() ? (feed.failed ? copy().usage.stale(checked()!) : copy().usage.checkedAt(checked()!)) : ""}
                  </Text>
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
              </If>
            </>
          )}
        </If>
      </Scroll>
    </View>
  );
}
