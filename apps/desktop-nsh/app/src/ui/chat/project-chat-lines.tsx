/**
 * The lines of a project session's transcript (`ProjectChat.svelte`): the app's, centred in a chip;
 * yours on the right in a bubble with its files; the agent's on the left as Markdown with the
 * commands it ran folded under it (and a way into its subagents). A day line above the first line
 * of each day, and the line that says an earlier page is on its way. Questions the agent asked
 * together are one card (`ProjectAskGroup`); those its run still waits on are asked at its end
 * (`project-chat-working`), not here.
 *
 * An agent line's time sits at the right end of the line under it, as a Bot reply's does, and at
 * the right end of the command card's line when it ran commands (the messenger's `.command-beside`).
 * Not as the messenger, whose agent line without commands has its time under it on the left. The
 * transcript is one selection (`ProjectChat`), and the times, the day lines and the earlier line
 * stay out of it, so a drag runs from one line into the next and copies the words alone. No line is a
 * selection area of its own (no `selectable` view, Markdown with `selectable={false}`): the nearest
 * area takes a right click before the pane hears it (`pane-menu.ts`).
 */
import { Text, View, type ViewRef } from "nsh";
import type { Annotation, Message } from "@real-bot/protocol";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import { formatDateDivider, formatMessageTime } from "../../m/chat/chat-view.ts";
import { snapshot } from "../../lib/reactive";
import { copy, runtime } from "../../runtime";
import { AnnotationCards } from "../annotations/AnnotationCards";
import { CommandActivity } from "./CommandActivity";
import { SEAM_LINE } from "../glass";
import { AskCard } from "./AskCard";
import { ProjectAsks } from "./project-chat-asks";
import { MarkdownBody } from "../lazy-views";
import { MessageAttachments } from "./MessageAttachments";
import { ProjectSubagentEntry } from "./ProjectSubagentEntry";
import { lineOf, type ProjectState } from "./project-chat-state";
import { SendFlightOf } from "./send-flight";
import type { Attachment } from "@real-bot/protocol";
import type { PressedPicture } from "./image-origin";

export type ProjectRow =
  | { id: "earlier"; kind: "earlier" }
  | { id: string; kind: "line"; message: Message; date: string | null }
  /** Questions one call asked, the run waiting on none of them now: one card, a step at a time. */
  | { id: string; kind: "asks"; messages: Message[]; date: string | null }
  /** A run that ended with nothing said: what it started has no line to hang under. */
  | { id: "tasks"; kind: "tasks" }
  | { id: "working"; kind: "working" };

/** The day, a line either side, stopping short of the words (no patch of `pane` under them: on glass it was a box). */
function DayLine(props: { at: string; locale: "en" | "zh" }) {
  return (
    <View testID="project-day" class="flex-row items-center gap-3 mt-[10px] w-full">
      <View class={`flex-1 h-[1px] ${SEAM_LINE}`} />
      <Text class="select-none text-[11px] font-semibold text-ink-muted">{formatDateDivider(props.at, props.locale)}</Text>
      <View class={`flex-1 h-[1px] ${SEAM_LINE}`} />
    </View>
  );
}

/** A line's time. Out of the transcript's selection: a drag across lines passes over it and copies the words alone. */
function LineTime(props: { at: string }) {
  return (
    <Text testID="project-line-time" class="select-none text-[11px] text-ink-muted" style={{ fontVariant: ["tabular-nums"] }}>
      {formatMessageTime(props.at)}
    </Text>
  );
}

export function EarlierLine(props: { loading: boolean }) {
  return (
    <View role="text" testID="project-earlier" class="items-center w-full">
      <Text class="select-none text-[12px] text-ink-muted">{props.loading ? copy().stream.loadingEarlier : " "}</Text>
    </View>
  );
}

/** A project session has no Bot: its cards name only you as who handled one. */
const NO_BOTS: ReadonlyMap<string, { name: string }> = new Map();

export function ProjectLine(props: {
  message: Message;
  date: string | null;
  state: ProjectState;
  onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string) => void;
  onOpenImage: (att: Attachment, from?: PressedPicture) => void;
}) {
  const t = () => copy();
  const s = () => props.state;
  const msg = () => props.message;
  const who = () => lineOf(msg());
  /** The line you just sent flies in from the box (`send-flight`). */
  const flight = SendFlightOf();
  const flies = flight?.claim(msg().id, msg().body, who() === "you" && msg().attachments.length === 0) ?? false;
  let bubble: ViewRef | null = null;
  /** The bubble as it flies in: the words as the box showed them, or the bubble itself. */
  const ghost = (words: boolean) => (
    <View class={`w-full h-full px-[14px] py-[10px] rounded-[16px] gap-2 ${words ? "" : "bg-you"}`}>
      <Text class={`text-[14px] ${words ? "text-ink" : "text-you-foreground"}`}>{msg().body}</Text>
    </View>
  );
  const hosted = () => s().placed().byLine.get(msg().id) ?? [];
  const kept = () => (focusMode.on ? [] : s().keptRows(hosted()));
  const time = () => <LineTime at={msg().created_at} />;
  return (
    <View testID={`project-line-${msg().id}`} class="w-full gap-[14px]">
      <If when={props.date}>{(at: () => string) => <DayLine at={at()} locale={s().locale()} />}</If>
      <If when={who() === "app"}>
        <View testID="project-line-app" class="self-center max-w-[90%] px-3 py-1 rounded-full bg-chip">
          <Text class="text-[12px] text-ink-muted text-center">{msg().body}</Text>
        </View>
      </If>
      <If when={who() === "you"}>
        <View testID="project-line-you" class="items-end w-full" style={flies ? flight?.hides(msg().id) : undefined}>
          <View
            ref={(node: ViewRef) => (bubble = node)}
            onLayout={() => {
              if (flies && bubble) flight?.placed(msg().id, bubble, ghost);
            }}
            class="max-w-[88%] px-[14px] py-[10px] rounded-[16px] bg-you gap-2"
          >
            <If when={msg().body}>
              {/* In the transcript's selection, as no area of its own: an area here would take the right click (`pane-menu.ts`). */}
              <View>
                <Text testID="project-words" class="text-[14px] text-you-foreground">{msg().body}</Text>
              </View>
            </If>
            <If when={msg().attachments.length > 0}>
              <MessageAttachments
                attachments={msg().attachments}
                api={runtime.client}
                onPreview={(att) => props.onOpenArtifact(att.workspace_relpath, att, msg().id)}
                onOpenImage={props.onOpenImage}
              />
            </If>
            <If when={s().annotationsOf(msg().id)}>
              {(rows: () => Annotation[]) => (
                <AnnotationCards
                  annotations={rows()}
                  locale={s().locale()}
                  bots={NO_BOTS}
                  onOpen={s().openAnnotation}
                  onToggleStatus={(row, status) => void s().toggleAnnotation(msg().id, row, status)}
                  error={s().cardErrors()[msg().id] ?? null}
                />
              )}
            </If>
          </View>
          <View class="mt-[3px]">{time()}</View>
        </View>
      </If>
      <If when={who() === "agent"}>
        <View testID="project-line-agent" class="items-start w-full">
          {/* The whole line wide, as a wrapping paragraph is in the messenger. Left to fit its text, NSH
              narrowed it to its widest line yet kept the heights measured at the full width: a paragraph
              that wrapped once more than measured ran under what followed it, and its last line was cut. */}
          <MarkdownBody class="self-stretch" selectable={false} source={msg().body} copyLabel={t().chat.copyCode} copiedLabel={t().chat.copied} onOpenArtifact={(path) => s().openCited(path, msg().id)} files={s().files()} />
          {/* A question for you (`kind: "ask"`): its card answers it while the run waits on it, and keeps the answer after. */}
          <If when={msg().kind === "ask"}>
            <View testID="project-line-ask" class="self-stretch mt-[8px] max-w-[440px]">
              {/* A plain copy: the store's deep proxy arrays draw nothing in the card's `Each` (PORTING.md). */}
              <AskCard
                message={snapshot(msg())}
                answerable={s().awaitsAsk(msg().id) && s().connected()}
                draft={runtime.getAskDraft(msg().id)}
                sending={s().view().sending}
                onDraft={(body) => runtime.setAskDraft(msg().id, body)}
                onSelect={(picks) => runtime.setAskSelection(msg().id, picks)}
                onSubmit={() => void s().answerAsk(msg().id)}
              />
            </View>
          </If>
          {/* The time at the right end: of its own line, or of the command card's. */}
          <If
            when={kept().length > 0}
            else={
              <View testID="project-line-foot" class="self-stretch flex-row justify-end mt-[3px]">
                {time()}
              </View>
            }
          >
            <View class="self-stretch mt-[8px]">
              <CommandActivity rows={kept()} beside={<View class="ml-auto">{time()}</View>} />
            </View>
          </If>
          <If when={!focusMode.on}>
            <ProjectSubagentEntry tasks={hosted().filter((task) => task.kind === "subagent")} onOpen={(task) => s().subagentOpen.set(task.id)} />
          </If>
        </View>
      </If>
    </View>
  );
}

/** Questions the agent asked together, answered or no longer waited on: one card, a step at a time, as they were asked. */
export function ProjectAskGroup(props: { messages: Message[]; date: string | null; state: ProjectState }) {
  const s = () => props.state;
  const first = () => props.messages[0]!;
  return (
    <View testID={`project-asks-${first().id}`} class="w-full gap-[14px]">
      <If when={props.date}>{(at: () => string) => <DayLine at={at()} locale={s().locale()} />}</If>
      <View class="items-start w-full">
        <ProjectAsks asks={props.messages} state={s()} />
        <View testID="project-line-foot" class="self-stretch flex-row justify-end mt-[3px]">
          <LineTime at={first().created_at} />
        </View>
      </View>
    </View>
  );
}

/** What a run that ended with nothing said started, with no line to hang under. */
export function ProjectTasksEnd(props: { state: ProjectState }) {
  const s = () => props.state;
  return (
    <If when={s().placed().end.length > 0 && !focusMode.on}>
      <View testID="project-line-tasks" class="items-start w-full">
        <CommandActivity rows={s().keptRows(s().placed().end)} />
        <ProjectSubagentEntry tasks={s().placed().end.filter((task) => task.kind === "subagent")} onOpen={(task) => s().subagentOpen.set(task.id)} />
      </View>
    </If>
  );
}
