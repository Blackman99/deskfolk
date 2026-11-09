/**
 * A model choice unfolded under its own card, the way a file is: what was picked, why, and what
 * came of it — the trouble it drew, the verdict on the correction chain, and your 「记为模型问题」.
 */
import { Text, View, signal } from "nsh";
import type { Provider, TaskTraceNode } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { formatDurationMs, formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import type { RouteLogRow } from "../../m/overlays/route-log.ts";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";

function Chip(props: { text: string; tip?: string; model?: boolean }) {
  return (
    <View
      tooltip={props.tip ? tip(props.tip) : undefined}
      class={`px-[7px] border rounded-full ${props.model ? "border-accent-border bg-accent-tint" : "border-line bg-chip"}`}
      style={{ maxWidth: "100%" }}
    >
      <Text class={`text-[11px] line-clamp-1 ${props.model ? "text-brand font-mono" : "text-ink-secondary"}`}>{props.text}</Text>
    </View>
  );
}

const OUTCOME: Record<string, string> = {
  completed: "border-ok-line bg-ok-bg text-ok-text",
  failed: "border-danger-line bg-danger-bg text-danger-text",
  interrupted: "border-warn-line bg-warn-bg text-warn-text",
  live: "border-accent-border bg-accent-tint text-brand",
  redirected: "border-accent-border bg-accent-tint text-brand",
};

export function TraceRouteDetail(props: {
  node: TaskTraceNode;
  route: RouteLogRow;
  providers: readonly Provider[];
  onJump: (sessionId: string, messageId: string) => void;
  /** The card's own toggle closes this instead: the state it opens on lives in the parent. */
  onClose: () => void;
  /** Your 「记为模型问题」 (engine level 8); absent where nothing can be marked. Rejects when it did not go through. */
  onMarkModel?: (marked: boolean) => Promise<void>;
}) {
  const route = () => props.route;
  // What you set here wins until the card's record catches up with it.
  const markOverride = signal<boolean | null>(null);
  const markBusy = signal(false);
  const markFailed = signal(false);
  const marked = () => markOverride() ?? route().markedModel ?? false;

  async function toggleMark(): Promise<void> {
    if (!props.onMarkModel || markBusy()) return;
    const next = !marked();
    markBusy.set(true);
    markFailed.set(false);
    try {
      await props.onMarkModel(next);
      markOverride.set(next);
    } catch {
      markFailed.set(true);
    } finally {
      markBusy.set(false);
    }
  }

  const stats = () => {
    const parts: string[] = [];
    if (route().durationMs !== null) parts.push(formatDurationMs(route().durationMs!));
    if (route().hops !== null && route().toolErrors !== null) parts.push(copy().routes.execution(route().hops!, route().toolErrors!));
    return parts.join(" · ");
  };
  const t = () => copy();
  return (
    <View
      testID={`trace-route-${props.node.turn_id}`}
      accessibilityLabel={t().routes.cardTitle}
      class="gap-[7px] pt-[8px] px-[10px] pb-[10px] border border-line rounded-(--radius-md) bg-pane"
      style={{ boxShadow: shadow("xs") }}
    >
      <View class="flex-row items-center gap-[6px]">
        <Text class="text-[12px] font-semibold text-ink">{t().routes.cardTitle}</Text>
        <View class={`px-[6px] border rounded-full ${OUTCOME[route().outcome] ?? "border-line bg-chip text-ink-muted"}`}>
          <Text class={`text-[11px] font-semibold ${(OUTCOME[route().outcome] ?? "text-ink-muted").split(" ").pop()}`}>{route().outcomeLabel}</Text>
        </View>
        <View
          role="button"
          testID="trace-route-close"
          accessibilityLabel={t().trace.outputClose}
          tooltip={tip(t().trace.outputClose)}
          onPress={props.onClose}
          class="cursor-pointer select-none ml-auto w-[20px] h-[20px] items-center justify-center rounded-(--radius-sm) hover:bg-line-subtle"
        >
          <Icon name="x" size={12} />
        </View>
      </View>
      <View class="flex-row flex-wrap gap-[4px]">
        <Chip model text={route().model} tip={route().model} />
        <Chip text={`${t().routes.thinkingPrefix} ${route().thinkingLabel}`} />
        <Chip text={route().signatureLabel} tip={t().routes.kindLabel} />
        <If when={props.providers.length > 1 && route().providerName}>
          <Chip text={route().providerName!} tip={t().routes.endpoint} />
        </If>
        <If when={route().reasonLabel}>
          <Chip text={route().reasonLabel!} tip={t().routes.reasonLabel} />
        </If>
      </View>
      <If when={stats() !== ""}>
        <Text class="text-[11px] leading-[16px] text-ink-muted font-mono">{stats()}</Text>
      </If>
      <If when={route().failReason}>
        <Text class="text-[12px] leading-[17px] text-danger-text">{route().failReason!}</Text>
      </If>
      <If when={route().reason}>
        <Text class="text-[12px] leading-[17px] text-ink-secondary">
          <Text class="font-semibold text-ink-muted">{`${t().routes.pickReason}  `}</Text>
          {route().reason!}
        </Text>
      </If>
      <If when={route().feedback.length > 0}>
        <View class="gap-[4px]">
          <Text class="text-[12px] font-semibold text-ink-muted">{t().routes.feedbackCount(route().feedback.length)}</Text>
          <Each of={route().feedback} key={(note: RouteLogRow["feedback"][number]) => note.message_id}>
            {(note: () => RouteLogRow["feedback"][number]) => (
              <View
                role="button"
                testID={`trace-route-note-${note().message_id}`}
                tooltip={tip(t().routes.jump)}
                onPress={() => props.onJump(props.node.session_id, note().message_id)}
                class="cursor-pointer select-none flex-row items-start gap-[6px] w-full px-[7px] py-[5px] border border-line rounded-(--radius-sm) bg-chip hover:border-accent-border"
              >
                <Text class="flex-1 min-w-0 text-[12px] leading-[17px] text-ink">{note().body}</Text>
                <Text tooltip={tip(formatFullTimestamp(note().created_at))} class="shrink-0 pt-[1px] text-[10px] text-ink-muted font-mono">
                  {formatMessageTime(note().created_at)}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={route().review}>
        {(review: () => NonNullable<RouteLogRow["review"]>) => (
          <View
            testID="trace-route-review"
            class={`gap-[4px] px-[8px] py-[6px] border rounded-(--radius-sm) ${review().blamedModel ? "border-warn-line bg-warn-bg" : "border-transparent bg-line-subtle"}`}
          >
            <View class="flex-row flex-wrap items-center gap-[5px]">
              <Text class="text-[12px] font-semibold text-ink-muted">{t().routes.reviewTitle}</Text>
              <Text class="text-[12px] font-semibold text-ink-secondary">{review().faultLabel}</Text>
              <If when={review().directionLabel}>
                <Text class="text-[11px] text-ink-muted">{review().directionLabel!}</Text>
              </If>
              <If when={review().rounds > 0}>
                <Text class="text-[11px] text-ink-muted">{t().routes.reviewRounds(review().rounds)}</Text>
              </If>
            </View>
            <If when={review().reason}>
              <Text class="text-[12px] leading-[17px] text-ink-secondary">{review().reason}</Text>
            </If>
            <If when={review().retired}>
              <Text class="text-[11px] text-ink-muted">{t().routes.effectRetired}</Text>
            </If>
            <If when={!review().retired && review().effect === "unknown"}>
              <Text class="text-[11px] text-ink-muted">{t().routes.effectUnused}</Text>
            </If>
            <If when={!review().retired && review().effect === "followed"}>
              <Text class="text-[11px] text-ink-muted">{`${t().routes.effectFollowed}${review().cleaner ? ` · ${t().routes.effectCleaner}` : ""}`}</Text>
            </If>
          </View>
        )}
      </If>
      <If when={route().markedModel !== null && props.onMarkModel}>
        <View class="flex-row flex-wrap items-center gap-[6px]">
          <View
            role="button"
            testID="trace-route-mark"
            accessibilityState={{ pressed: marked(), disabled: markBusy() }}
            disabled={markBusy()}
            tooltip={tip(t().routes.markModelHint)}
            onPress={() => void toggleMark()}
            class={`cursor-pointer select-none disabled:cursor-default px-[9px] py-[2px] border rounded-full disabled:opacity-[0.6] ${
              marked() ? "border-warn-line bg-warn-bg" : "border-line bg-pane hover:border-accent-border"
            }`}
          >
            <Text class={`text-[11px] ${marked() ? "text-warn-text" : "text-ink-secondary"}`}>{marked() ? t().routes.markedModel : t().routes.markModel}</Text>
          </View>
          <If when={markFailed()}>
            <Text testID="trace-route-mark-failed" class="text-[11px] text-danger-text">{t().routes.markModelFailed}</Text>
          </If>
        </View>
      </If>
      <If when={route().learning}>
        {(learning: () => NonNullable<RouteLogRow["learning"]>) => (
          <Text class="text-[12px] leading-[17px] text-ok-text">
            {learning().kind === "memory"
              ? t().routes.learnedMemory(learning().label)
              : learning().kind === "skill"
                ? t().routes.learnedSkill(learning().label)
                : t().routes.learnedNone}
          </Text>
        )}
      </If>
    </View>
  );
}
