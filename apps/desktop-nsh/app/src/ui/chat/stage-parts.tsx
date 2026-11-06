/**
 * The pieces the stage's list is drawn from, apart from the groups themselves: the delegation
 * records of a Bot↔Bot direct (and why they did not load), the shimmering skeleton a remote
 * transcript shows while it comes over the relay, the date line, the "New" line, the line above
 * the first message while an earlier page is on its way, and the row that draws one group.
 */
import { createMotion, effect, reduceMotion, Text, View } from "nsh";
import type { SessionSummary } from "@real-bot/protocol";
import { formatDateDivider } from "../../m/chat/chat-view.ts";
import type { TranscriptItem } from "../../m/chat/transcript.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { DelegationRecords } from "./DelegationRecords";
import { ReplyingIndicator } from "./ReplyingIndicator";
import { TranscriptApproval } from "./TranscriptApproval";
import { TranscriptAsk } from "./TranscriptAsk";
import { TranscriptBotGroup } from "./TranscriptBotGroup";
import { TranscriptSystem } from "./TranscriptSystem";
import { TranscriptUserGroup } from "./TranscriptUserGroup";
import type { MessageMenuHandler } from "./transcript-parts";
import type { StageContext } from "./stage-context";
import type { StageRow } from "./stage-rows";

/** What the Bots asked of each other in a Bot↔Bot direct, and a retry when the thread did not load. */
export function DelegationBlock(props: {
  ctx: StageContext;
  session: SessionSummary;
  onOpenArtifact: (path: string, messageId?: string) => void;
}) {
  const t = () => copy();
  const failed = () => Boolean(runtime.delegationLoadError[props.session.id]);
  return (
    <View testID="delegations" class="w-full max-w-[800px] self-center">
      <DelegationRecords records={props.ctx.delegations()} botsById={props.ctx.botsById()} onOpenArtifact={props.onOpenArtifact} />
      <If when={failed()}>
        <View role="text" testID="delegation-load-error" class="flex-row items-center gap-2 my-2">
          <Text class="text-[12px] text-danger-text">{t().delegation.loadFailed}</Text>
          <Button
            size="sm"
            variant="secondary"
            testID="delegation-retry"
            disabled={!props.ctx.connected() || Boolean(runtime.delegationLoading[props.session.id])}
            onPress={() => void runtime.loadDelegations(props.session.id)}
          >
            {t().delegation.retry}
          </Button>
        </View>
      </If>
    </View>
  );
}

/** A remote transcript arrives over the relay; two replies and a line of yours, shimmering in place. */
export function HistoryLoading() {
  const shimmer = createMotion();
  effect(() => {
    if (!reduceMotion()) void shimmer.play({ duration: 1400, iterations: "infinite", direction: "alternate", keyframes: { opacity: [1, 0.45] } });
    else shimmer.reset();
  });
  const bar = (width: number | string, height = 10) => (
    <View class="rounded-(--radius-sm) bg-line" style={{ width: width as never, height, opacity: shimmer.opacity }} />
  );
  return (
    <View testID="history-loading" role="text" class="w-full max-w-[800px] self-center gap-9 py-10 px-6">
      <Each of={[0.9, 0.62]}>
        {(width: () => number) => (
          <View accessible={false} class="flex-row gap-3">
            <View class="w-[32px] h-[32px] rounded-full bg-line shrink-0" style={{ opacity: shimmer.opacity }} />
            <View class="flex-1 gap-4 pt-[2px]">
              {bar("22%")}
              {bar(`${Math.round(width() * 100)}%`)}
              {bar(`${Math.round(width() * 70)}%`)}
            </View>
          </View>
        )}
      </Each>
      <View accessible={false} class="self-end rounded-(--radius-lg) bg-line" style={{ width: "40%" as never, height: 36, opacity: shimmer.opacity }} />
      <Text class="text-[12px] text-ink-muted text-center">{copy().stream.loadingHistory}</Text>
    </View>
  );
}

function DateDivider(props: { at: string; locale: "en" | "zh" }) {
  return (
    <View testID="date-divider" class="relative items-center justify-center mt-6 mb-2 w-full">
      <View class="absolute left-0 right-0 h-[1px] bg-line-subtle" />
      <Text class="px-3 bg-pane text-[11px] font-semibold text-ink-muted">{formatDateDivider(props.at, props.locale)}</Text>
    </View>
  );
}

/** Above the first message that came in since you last read here, for as long as the conversation stays open. */
function NewDivider() {
  return (
    <View testID="new-divider" role="group" accessibilityLabel={copy().stream.newMessages} class="flex-row items-center gap-[10px] mt-[6px] mb-[2px] w-full">
      <View class="flex-1 h-[1px] bg-accent-border" />
      <Text class="text-[11px] font-bold text-brand">{copy().stream.newMessages}</Text>
      <View class="flex-1 h-[1px] bg-accent-border" />
    </View>
  );
}

/** The line above the first message: it says an earlier page is on its way, and holds its place so it never shifts the transcript. */
function EarlierLine(props: { loading: boolean }) {
  return (
    <View role="text" testID="load-earlier" class="items-center py-3 w-full">
      <Text class="text-[12px] text-ink-muted">{props.loading ? copy().stream.loadingEarlier : " "}</Text>
    </View>
  );
}

/** One row of the list: a group of lines with its date and "New" lines, the delegations, or the earlier line. */
export function StageRowView(props: {
  row: StageRow;
  stage: TranscriptStage;
  ctx: StageContext;
  loadingEarlier: boolean;
  onContextMenu: MessageMenuHandler;
  onOpenArtifact: (path: string, messageId?: string) => void;
}) {
  const row = () => props.row;
  const group = () => {
    const r = row();
    return r.kind === "group" ? r : null;
  };
  return (
    <>
      <If when={row().kind === "delegations" ? props.stage.selected : null}>
        {(session: () => SessionSummary) => <DelegationBlock ctx={props.ctx} session={session()} onOpenArtifact={props.onOpenArtifact} />}
      </If>
      <If when={row().kind === "earlier"}>
        <EarlierLine loading={props.loadingEarlier} />
      </If>
      <If when={group()}>
        {(g: () => Extract<StageRow, { kind: "group" }>) => (
          <View testID={`row-${g().id}`} class="w-full max-w-[800px] self-center">
            <If when={g().date}>{(at: () => string) => <DateDivider at={at()} locale={props.stage.locale} />}</If>
            <If when={g().fresh}>
              <NewDivider />
            </If>
            <GroupView group={g().group} stage={props.stage} onContextMenu={props.onContextMenu} />
          </View>
        )}
      </If>
    </>
  );
}

type ReplyingEntries = Extract<TranscriptItem, { type: "replying" }>["entries"];

function GroupView(props: { group: Extract<StageRow, { kind: "group" }>["group"]; stage: TranscriptStage; onContextMenu: MessageMenuHandler }) {
  const kind = () => props.group.kind;
  const replying = (): ReplyingEntries | null => {
    const block = props.group.items[0];
    return kind() === "replying" && block?.type === "replying" ? block.entries : null;
  };
  return (
    <>
      <If when={replying()}>
        {(entries: () => ReplyingEntries) => (
          <View role="text" class="gap-[5px] self-start max-w-full pt-[2px] px-[2px] pb-[1px] -mt-2">
            <ReplyingIndicator
              entries={entries()}
              botsById={props.stage.botsById}
              isUser={false}
              thinkingText={props.stage.statusLabels.running}
              deletedText={copy().top.deleted}
              onOpenProfile={props.stage.onOpenProfile}
            />
          </View>
        )}
      </If>
      <If when={kind() === "ask"}>
        <TranscriptAsk group={props.group} stage={props.stage} onContextMenu={props.onContextMenu} />
      </If>
      <If when={kind() === "approval"}>
        <TranscriptApproval group={props.group} stage={props.stage} />
      </If>
      <If when={kind() === "system"}>
        <TranscriptSystem group={props.group} stage={props.stage} onContextMenu={props.onContextMenu} />
      </If>
      <If when={kind() === "user"}>
        <TranscriptUserGroup group={props.group} stage={props.stage} onContextMenu={props.onContextMenu} />
      </If>
      <If when={kind() === "bot"}>
        <TranscriptBotGroup group={props.group} stage={props.stage} onContextMenu={props.onContextMenu} />
      </If>
    </>
  );
}
