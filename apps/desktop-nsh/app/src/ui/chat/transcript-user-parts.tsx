/**
 * What hangs under one of your lines (`TranscriptUserGroup`): the time and 「已编辑」 under the
 * bubble, the row of a line no Bot has read yet (queued: insert it now, take it back), the
 * withdrawn line's notice, and the earlier versions of a changed line.
 */
import { Text, View } from "nsh";
import type { Message } from "@real-bot/protocol";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { copy } from "../../runtime";
import { tip } from "../tip";

/** A quiet text-link button: the accent, grey when it cannot be pressed. */
export function LineButton(props: { label: string; title?: string; disabled?: boolean; testID?: string; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      tooltip={props.title ? tip(props.title) : undefined}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      class="cursor-pointer select-none disabled:cursor-default group"
    >
      <Text class={`text-[11px] ${props.disabled ? "text-ink-muted" : "text-brand group-hover:text-accent-hover group-hover:underline"}`}>{props.label}</Text>
    </View>
  );
}

/**
 * Under the bubble, as under a Bot's line: when you sent it, then 「已编辑」 where what it said
 * before opens. Focus mode keeps only 「已编辑」: it says the words changed.
 */
export function MessageFoot(props: { message: Message; stage: TranscriptStage }) {
  const t = () => copy();
  const stage = () => props.stage;
  const edited = () => Boolean(props.message.edited_at && !props.message.withdrawn_at);
  const open = () => stage().versionsShown[props.message.id]?.at === (props.message.edited_at ?? "");
  return (
    <If when={!stage().focus || edited()}>
      <View testID="msg-foot" class="flex-row justify-end items-baseline gap-[6px] mt-[4px] px-[2px]">
        <If when={!stage().focus}>
          <View tooltip={tip(formatFullTimestamp(props.message.created_at))}>
            <Text class="text-[11px] font-mono text-ink-muted">{formatMessageTime(props.message.created_at)}</Text>
          </View>
        </If>
        <If when={edited()}>
          <If when={!stage().focus}>
            <Text class="text-[11px] text-ink-muted" style={{ opacity: 0.6 }} accessible={false}>
              ·
            </Text>
          </If>
          <View
            role="button"
            testID="msg-edited"
            accessibilityState={{ expanded: open() }}
            tooltip={tip(t().chat.editedAt(formatFullTimestamp(props.message.edited_at ?? props.message.created_at)))}
            onPress={() => void stage().toggleVersions(props.message)}
            class="cursor-pointer select-none group"
          >
            <Text class={`text-[11px] ${open() ? "text-ink underline" : "text-ink-muted group-hover:text-ink group-hover:underline"}`}>{t().chat.edited}</Text>
          </View>
        </If>
      </View>
    </If>
  );
}

/** Still unread (ADR 0069): where it waits, and what you can do about it before a Bot reads it. */
export function QueuedRow(props: { message: Message; stage: TranscriptStage }) {
  const t = () => copy();
  const stage = () => props.stage;
  const queued = () => stage().queuedLine(props.message);
  const note = () => stage().lineNoteText(props.message);
  return (
    <>
      <If when={queued()}>
        {(line) => (
          <View testID="msg-queued" class="flex-row flex-wrap justify-end items-baseline gap-x-[10px] gap-y-[2px] mt-[3px] px-[2px]">
            <Text testID="msg-queued-state" class="text-[11px] text-ink-muted">
              {line().wait === "held" ? t().chat.queuedHeld : line().wait === "next_step" ? t().chat.queuedNextStep : t().chat.queuedItsTurn}
            </Text>
            <If when={line().canInsert}>
              <LineButton
                testID="msg-insert-now"
                label={t().chat.insertNow}
                title={stage().insertTitle(props.message)}
                disabled={stage().lineBusy(props.message)}
                onPress={() => stage().insertLine(props.message)}
              />
            </If>
            <If when={line().canWithdraw}>
              <LineButton
                testID="msg-withdraw"
                label={t().chat.withdrawLine}
                title={t().chat.withdrawLineTitle}
                disabled={stage().lineBusy(props.message)}
                onPress={() => void stage().withdrawLine(props.message)}
              />
            </If>
          </View>
        )}
      </If>
      <If when={note()}>
        {(text) => (
          <Text role="text" testID="msg-line-note" class="mt-[2px] px-[2px] text-[11px] text-ink-muted text-right">
            {text()}
          </Text>
        )}
      </If>
    </>
  );
}

/** What a changed line said before, newest first, under its bubble once 「已编辑」 is open. */
export function VersionsBlock(props: { message: Message; stage: TranscriptStage }) {
  const t = () => copy();
  const shown = () => {
    const row = props.stage.versionsShown[props.message.id];
    return row && row.at === (props.message.edited_at ?? "") ? row : null;
  };
  return (
    <If when={shown()}>
      {(row) => (
        <View
          role="region"
          testID="msg-versions"
          accessibilityLabel={t().chat.earlierVersions}
          class="self-end max-w-full gap-[6px] mt-[6px] px-[10px] py-[8px] bg-pane border border-line rounded-(--radius-md)"
        >
          <Text class="text-[11px] text-ink-muted">{t().chat.earlierVersions}</Text>
          <If
            when={!row().loading}
            else={
              <Text class="text-[11px] text-ink-muted">{t().chat.versionsLoading}</Text>
            }
          >
            <If
              when={!row().failed}
              else={
                <Text class="text-[11px] text-ink-muted">{t().chat.versionsFailed}</Text>
              }
            >
              <Each of={[...row().versions].reverse()} key={(version) => version.created_at + version.body}>
                {(version) => (
                  <View testID="msg-version" class="flex-row items-baseline gap-[8px]">
                    <View tooltip={tip(formatFullTimestamp(version().created_at))} class="shrink-0">
                      <Text class="text-[11px] font-mono text-ink-muted">{formatMessageTime(version().created_at)}</Text>
                    </View>
                    <Text class="shrink min-w-0 text-[13px] leading-[1.5] text-ink-secondary">{version().body}</Text>
                  </View>
                )}
              </Each>
            </If>
          </If>
        </View>
      )}
    </If>
  );
}
