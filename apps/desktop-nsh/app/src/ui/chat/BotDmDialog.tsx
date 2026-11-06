/**
 * A Bot↔Bot direct, read in a popup over the conversation it came from (`BotDmDialog.svelte`,
 * ADR 0091). It is opened only from the message it hangs under, or a link, a search hit or a
 * notification that names it; never from the list and never as a tab: you read that one exchange and
 * close it. The transcript is the conversation's own (`ChatStage`), read-only as a Bot↔Bot direct
 * always is. What opens from inside it (a file, a Bot's profile, a flow) opens where it always does, so
 * the popup steps aside for it first (the shell closes it in those callbacks).
 *
 * It is `Modal` (a dialog 900 wide, nearly the window's height; the whole page on a phone, its ✕ a
 * back chevron). Differences from the Svelte popup: the line it came from sits in a strip under the
 * head with the avatar, not in the head under the title (`Modal` has one title line); the Svelte's
 * guard that a menu inside the transcript takes its own Escape first is `Dialog`'s and the menu's own
 * key handling here.
 */
import { Text, View, windowSize } from "nsh";
import type { Attachment, SessionSummary } from "@real-bot/protocol";
import { resolveBotDmOrigin } from "../../m/sidebar/bot-dm-source.ts";
import { copy, runtime } from "../../runtime";
import { Modal, narrowWindow } from "../Modal";
import { SessionAvatar } from "../SessionAvatar";
import { tip } from "../tip";
import { ChatStage } from "./ChatStage";
import { rosterLabelsOf } from "./labels";
import { sessionTitle } from "../../m/sidebar/session-title.ts";

export function BotDmDialog(props: {
  session: SessionSummary;
  onClose: () => void;
  onOpenProfile: (botId: string) => void;
  onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string, forceTree?: boolean) => void;
  onCreateBot: () => void;
}) {
  const t = () => copy();
  const snapshot = () => runtime.snapshot;
  const botsById = () => new Map(snapshot().bots.map((bot) => [bot.id, bot] as const));
  const sessionsById = () => new Map(snapshot().sessions.map((row) => [row.id, row] as const));
  const titleOf = (row: SessionSummary) => sessionTitle(row, botsById(), rosterLabelsOf(t()));
  const title = () => titleOf(props.session);
  const source = () => resolveBotDmOrigin(props.session, sessionsById());

  /** The line it came from: in the conversation under the popup, or in the direct it was opened from. */
  function goToSource(): void {
    const origin = source();
    if (origin.kind !== "session") return;
    void runtime.selectSession(origin.session.id, origin.messageId ? { messageId: origin.messageId } : undefined);
  }

  /** The card's height: nearly the window's (`min(92dvh, 100dvh - 48px)`), less its head and the source strip. */
  const bodyHeight = () => {
    const h = windowSize().height;
    const card = narrowWindow() ? h : Math.min(Math.round(h * 0.92), h - 48);
    return Math.max(160, card - (narrowWindow() ? 52 : 60) - 37);
  };

  const sourceLine = () => {
    const origin = source();
    if (origin.kind !== "session") return null;
    const name = titleOf(origin.session);
    return {
      text: t().sidebar.botBotSource(name),
      tip: origin.root ? t().sidebar.botBotSourceRoot(name, titleOf(origin.root)) : t().sidebar.botBotSource(name),
      mark: origin.depth > 0 ? "↳" : "↰",
    };
  };

  return (
    <Modal
      testID="bot-dm-dialog"
      title={title()}
      closeLabel={t().common.close}
      backLabel={t().common.back}
      onClose={props.onClose}
      pageOnPhone
      scroll={false}
      width={900}
      maxHeight={0.92}
      bodyClass="p-0"
    >
      <View class="flex-row items-center gap-[8px] px-4 py-[7px] border-b border-line min-w-0" style={{ height: 37 }}>
        <SessionAvatar session={props.session} bots={botsById()} size="sm" />
        <If
          when={sourceLine()}
          else={
            <Text testID="bot-dm-source" class="text-[12px] text-ink-muted opacity-70 line-clamp-1">
              {source().kind === "missing" ? t().sidebar.botBotSourceMissing : t().sidebar.botBotSourceUnknown}
            </Text>
          }
        >
          {(line: () => NonNullable<ReturnType<typeof sourceLine>>) => (
            <View
              role="button"
              testID="bot-dm-source"
              accessibilityLabel={line().tip}
              tooltip={tip(line().tip)}
              onPress={goToSource}
              class="group flex-row items-center gap-1 min-w-0 shrink"
            >
              <Text accessible={false} class="text-[12px] text-ink-muted group-hover:text-brand">{line().mark}</Text>
              <Text class="text-[12px] text-ink-muted group-hover:text-brand line-clamp-1">{line().text}</Text>
            </View>
          )}
        </If>
      </View>
      <View testID="bot-dm-conversation" class="min-w-0" style={{ height: bodyHeight() }}>
        <ChatStage selected={props.session} onOpenProfile={props.onOpenProfile} onOpenArtifact={props.onOpenArtifact} onCreateBot={props.onCreateBot} />
      </View>
    </Modal>
  );
}
