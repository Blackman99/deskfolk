/**
 * One agent's usage (ADR 0080): its name with its day here, then each account with every window,
 * what is used and when it starts over. The phone's page lists one per agent; the widget shows
 * the one you point at (`UsageAgentSection.svelte`).
 */
import { Text, View } from "nsh";
import type { UsageAgent } from "@real-bot/protocol";
import { copy } from "../../runtime";
import {
  usageAccountNote,
  usageAccountShortName,
  usageCreditsText,
  usageLevel,
  usageResetText,
  usageTokenText,
  usageUsed,
  usageUsedText,
  usageWindowLabel,
  usageWindowsSorted,
} from "../../m/usage/usage.ts";
import { AgentLogo } from "../settings/AgentLogo";
import { tip } from "../tip";

const FILL = { normal: "bg-ink-muted", warn: "bg-warn", danger: "bg-danger" } as const;
const PERCENT = { normal: "text-ink", warn: "text-warn-text", danger: "text-danger-text" } as const;

export function UsageAgentSection(props: {
  agent: UsageAgent;
  locale: string;
  now: number;
  /** The agent's mark beside its name: larger in the widget's card. */
  logoSize?: number;
  /** The widget's card reads a little larger than the phone's page: 13 / 12 for 12 / 11. */
  large?: boolean;
}) {
  /** Several accounts: each in a box of its own, so its windows read as its. */
  const several = () => props.agent.accounts.length > 1;
  const today = () => copy().usage.today(String(props.agent.today.turns), usageTokenText(props.agent.today.tokens));
  const body = () => (props.large ? "text-[13px]" : "text-[12px]");
  const small = () => (props.large ? "text-[12px]" : "text-[11px]");
  return (
    <View testID={`usage-agent-${props.agent.runner}`} class="gap-[10px]">
      <View class="flex-row items-center gap-[6px] min-w-0">
        <AgentLogo runner={props.agent.runner} size={props.logoSize ?? 14} />
        <Text testID="usage-agent-name" class={`${body()} font-semibold text-ink`}>
          {props.agent.runner === "claude_code" ? "Claude" : props.agent.label}
        </Text>
        <Text testID="usage-agent-today" class={`ml-auto shrink min-w-0 ${small()} text-ink-muted line-clamp-1`}>
          {today()}
        </Text>
      </View>
      {() =>
        props.agent.accounts.map((account) => {
          const note = () => usageAccountNote(account, copy());
          const name = () => usageAccountShortName(props.agent, account, copy());
          return (
            <View
              testID={`usage-account-${account.config_dir ?? ""}`}
              class={several() ? "gap-[10px] pt-[10px] px-[12px] pb-[12px] border border-line rounded-(--radius-md) bg-ink/3" : "gap-[8px]"}
            >
              <View class="flex-row items-baseline gap-[8px] min-w-0">
                <View tooltip={account.error ? tip(account.error!) : undefined} class="flex-row items-center gap-[6px] min-w-0 shrink">
                  <If when={name().plan}>
                    {(plan) => (
                      <Text testID="usage-account-plan" class={`shrink-0 px-[7px] py-[1px] rounded-full bg-ink/10 ${body()} font-semibold text-ink`}>
                        {plan()}
                      </Text>
                    )}
                  </If>
                  <If when={name().who}>
                    {(who) => (
                      <Text testID="usage-account-who" class={`min-w-0 shrink ${body()} text-ink-muted line-clamp-1`}>
                        {who()}
                      </Text>
                    )}
                  </If>
                </View>
                <If when={account.credits}>
                  {(credits) => (
                    <Text testID="usage-credits" class={`ml-auto ${small()} text-ink-muted`}>
                      {copy().usage.credits(usageCreditsText(credits(), props.locale))}
                    </Text>
                  )}
                </If>
              </View>
              <If
                when={note()}
                else={
                  <View class="gap-[8px]">
                    {() =>
                      usageWindowsSorted(account.windows).map((window) => {
                        const level = () => usageLevel(window.percent);
                        const reset = () => usageResetText(window.resets_at, props.now, copy(), props.locale);
                        return (
                          <View testID={`usage-window-${window.model ?? window.minutes ?? ""}`} class="gap-[4px] min-w-0">
                            <View class="flex-row items-baseline gap-[8px] min-w-0">
                              <Text testID="usage-name" class={`${body()} text-ink line-clamp-1`}>{usageWindowLabel(window, copy())}</Text>
                              <Text testID="usage-reset" class={`flex-1 min-w-0 ${small()} text-ink-muted line-clamp-1`}>{reset() ?? ""}</Text>
                              <Text testID="usage-percent" class={`${body()} font-semibold ${PERCENT[level()]}`}>
                                {copy().usage.used(usageUsedText(window.percent))}
                              </Text>
                            </View>
                            <View class="h-[4px] rounded-full bg-line overflow-hidden" accessible={false}>
                              <View class={`h-full rounded-full ${FILL[level()]}`} style={{ width: `${usageUsed(window.percent)}%` }} />
                            </View>
                          </View>
                        );
                      })
                    }
                  </View>
                }
              >
                {(text) => <Text testID="usage-note" class={`${body()} text-ink-muted`}>{text()}</Text>}
              </If>
            </View>
          );
        })
      }
    </View>
  );
}
