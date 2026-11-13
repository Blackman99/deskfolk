/**
 * What the Bots asked of each other in this conversation (`DelegationRecords.svelte`): who asked
 * whom, what, the status, the reply once it came and, while it waits, since when and until when.
 */
import { Text, View } from "nsh";
import type { Bot, DelegationView } from "@real-bot/protocol";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import { copy } from "../../runtime";
import { MarkdownBody } from "../MarkdownBody";
import { workspaceFiles } from "../file-on-disk";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

function Time(props: { at: string; class?: string }) {
  return (
    <View tooltip={tip(formatFullTimestamp(props.at))}>
      <Text class={props.class ?? ""}>{formatMessageTime(props.at)}</Text>
    </View>
  );
}

export function DelegationRecords(props: {
  records: DelegationView[];
  botsById: Map<string, Bot>;
  onOpenArtifact: (path: string, messageId?: string) => void;
}) {
  const t = () => copy();
  const ordered = () => props.records.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const nameOf = (id: string) => props.botsById.get(id)?.name ?? t().top.deleted;
  return (
    <If when={ordered().length > 0}>
      <View testID="delegation-records" accessibilityLabel={t().delegation.title} class="my-[16px] min-w-0">
        <Text class="mb-[8px] text-[12px] font-semibold text-ink-muted">{t().delegation.title}</Text>
        <View class="gap-[8px]">
          <Each of={ordered()} key={(row) => row.id}>
            {(row) => (
              <View testID={`delegation-${row().id}`} class={`min-w-0 border border-line rounded-[10px] ${narrowWindow() ? "px-[12px] py-[10px]" : "px-[14px] py-[12px]"}`}>
                <View class="flex-row flex-wrap items-baseline gap-x-[10px] gap-y-[6px] mb-[7px]">
                  <Text class="text-[11px] font-medium text-ink-secondary">{`${nameOf(row().from_bot_id)} → ${nameOf(row().to_bot_id)}`}</Text>
                  <Text class="text-[10px] text-ink-muted">{t().delegation.expects[row().expects]}</Text>
                  <Text testID="delegation-status" class={`text-[10px] ${row().wait?.state === "held" ? "text-warn-text" : "text-ink-muted"}`}>{t().delegation[row().status]}</Text>
                  <View class="ml-auto">
                    <Time at={row().created_at} class="text-[11px] text-ink-muted" />
                  </View>
                </View>
                <Text class="text-[13px] leading-[1.6] text-ink">
                  {`${t().delegation.request}${row().ask}${row().wait?.state === "waiting" ? t().delegation.waitingSuffix : row().wait?.state === "held" ? t().delegation.heldSuffix : ""}`}
                </Text>
                <If when={row().reply}>
                  {(reply: () => NonNullable<DelegationView["reply"]>) => (
                    <>
                      <View class="flex-row gap-[4px] mt-[8px]">
                        <Text class="text-[13px] leading-[1.6] text-ink">{t().delegation.result}</Text>
                        <MarkdownBody
                          class="flex-1"
                          source={reply().body}
                          copyLabel={t().chat.copyCode}
                          copiedLabel={t().chat.copied}
                          onOpenArtifact={(path) => props.onOpenArtifact(path, row().result_message_id ?? undefined)}
                          files={workspaceFiles()}
                        />
                      </View>
                      <Time at={reply().created_at} class="mt-[4px] text-[10px] text-ink-muted" />
                    </>
                  )}
                </If>
                <If when={row().wait}>
                  {(wait: () => NonNullable<DelegationView["wait"]>) => (
                    <View testID="delegation-wait" class="flex-row flex-wrap gap-x-[12px] gap-y-[4px] border-t border-line pt-[8px] mt-[10px]">
                      <Text class={`text-[11px] ${wait().state === "held" ? "text-warn-text" : "text-ink-secondary"}`}>
                        {wait().state === "held" ? t().delegation.held : t().delegation.waiting(nameOf(row().to_bot_id))}
                      </Text>
                      <View class={`flex-row items-baseline gap-[4px] ${narrowWindow() ? "basis-full" : ""}`}>
                        <Text class="text-[11px] text-ink-muted">{`${t().delegation.since} `}</Text>
                        <Time at={wait().since} class="text-[11px] text-ink-muted" />
                        <If when={wait().due_at}>
                          {(due: () => string) => (
                            <>
                              <Text class="text-[11px] text-ink-muted">{`· ${t().delegation.due} `}</Text>
                              <Time at={due()} class="text-[11px] text-ink-muted" />
                            </>
                          )}
                        </If>
                      </View>
                    </View>
                  )}
                </If>
              </View>
            )}
          </Each>
        </View>
      </View>
    </If>
  );
}
