/**
 * One account's usage in a line (ADR 0080), as the menu bar says it: a ring for its tightest
 * window, then what is used of the plan's 5-hour and 7-day windows; or why there are none.
 * The whole of it is in the usage widget (`UsageLine.svelte`).
 */
import { Text, View } from "nsh";
import type { UsageAccount } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { usageAccountNote, usageCreditsText, usageSummary, usageTightest } from "../../m/usage/usage.ts";
import { tip } from "../tip";
import { UsageRing } from "./UsageRing";

export function UsageLine(props: { account: UsageAccount }) {
  const tightest = () => (props.account.available ? usageTightest(props.account.windows) : null);
  return (
    <View
      testID="usage-line"
      tooltip={props.account.error ? tip(props.account.error) : undefined}
      class="flex-row items-center gap-[6px] min-w-0"
    >
      <If when={tightest()} else={<Text class="text-[12px] text-ink-muted">{usageAccountNote(props.account, copy())}</Text>}>
        {(window) => (
          <>
            <UsageRing percent={window().percent} size={13} />
            <Text class="text-[12px] text-ink">{usageSummary(props.account, copy())}</Text>
            <If when={props.account.credits}>
              {(credits) => <Text class="text-[12px] text-ink-muted">{`· ${copy().usage.credits(usageCreditsText(credits()))}`}</Text>}
            </If>
          </>
        )}
      </If>
    </View>
  );
}
