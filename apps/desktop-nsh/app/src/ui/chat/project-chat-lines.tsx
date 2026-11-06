/**
 * The lines of a project session's transcript (`ProjectChat.svelte`): the app's, centred in a chip;
 * yours on the right in a bubble with its files; the agent's on the left as Markdown with the
 * commands it ran folded under it (and a way into its subagents) and the time. A day line above the
 * first line of each day, and the line that says an earlier page is on its way.
 */
import { Text, View } from "nsh";
import type { Message } from "@real-bot/protocol";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import { formatDateDivider, formatMessageTime } from "../../m/chat/chat-view.ts";
import { copy, runtime } from "../../runtime";
import { CommandActivity } from "./CommandActivity";
import { MarkdownBody } from "../MarkdownBody";
import { MessageAttachments } from "./MessageAttachments";
import { ProjectSubagentEntry } from "./ProjectSubagentEntry";
import { lineOf, type ProjectState } from "./project-chat-state";
import type { Attachment } from "@real-bot/protocol";
import type { ViewRef } from "nsh";

export type ProjectRow =
  | { id: "earlier"; kind: "earlier" }
  | { id: string; kind: "line"; message: Message; date: string | null }
  /** A run that ended with nothing said: what it started has no line to hang under. */
  | { id: "tasks"; kind: "tasks" }
  | { id: "working"; kind: "working" };

function DayLine(props: { at: string; locale: "en" | "zh" }) {
  return (
    <View testID="project-day" class="relative items-center justify-center mt-[10px] w-full">
      <View class="absolute left-0 right-0 h-[1px] bg-line-subtle" />
      <Text class="px-3 bg-pane text-[11px] font-semibold text-ink-muted">{formatDateDivider(props.at, props.locale)}</Text>
    </View>
  );
}

export function EarlierLine(props: { loading: boolean }) {
  return (
    <View role="text" testID="project-earlier" class="items-center w-full">
      <Text class="text-[12px] text-ink-muted">{props.loading ? copy().stream.loadingEarlier : " "}</Text>
    </View>
  );
}

export function ProjectLine(props: {
  message: Message;
  date: string | null;
  state: ProjectState;
  onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string) => void;
  onOpenImage: (att: Attachment, from?: ViewRef) => void;
}) {
  const t = () => copy();
  const s = () => props.state;
  const msg = () => props.message;
  const who = () => lineOf(msg());
  const hosted = () => s().placed().byLine.get(msg().id) ?? [];
  const kept = () => (focusMode.on ? [] : s().keptRows(hosted()));
  const time = () => (
    <Text testID="project-line-time" class="text-[11px] text-ink-muted">{formatMessageTime(msg().created_at)}</Text>
  );
  return (
    <View testID={`project-line-${msg().id}`} class="w-full gap-[14px]">
      <If when={props.date}>{(at: () => string) => <DayLine at={at()} locale={s().locale()} />}</If>
      <If when={who() === "app"}>
        <View testID="project-line-app" class="self-center max-w-[90%] px-3 py-1 rounded-full bg-chip">
          <Text class="text-[12px] text-ink-muted text-center">{msg().body}</Text>
        </View>
      </If>
      <If when={who() === "you"}>
        <View testID="project-line-you" class="items-end w-full">
          <View class="max-w-[88%] px-[14px] py-[10px] rounded-[16px] bg-you gap-2">
            <If when={msg().body}>
              <View selectable>
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
          </View>
          <View class="mt-[3px]">{time()}</View>
        </View>
      </If>
      <If when={who() === "agent"}>
        <View testID="project-line-agent" class="items-start w-full">
          <MarkdownBody source={msg().body} copyLabel={t().chat.copyCode} copiedLabel={t().chat.copied} onOpenArtifact={(path) => s().openCited(path, msg().id)} />
          <View class="self-stretch mt-[3px]">
            <If when={kept().length > 0} else={time()}>
              <View class="mt-[5px]">
                <CommandActivity rows={kept()} beside={time()} />
              </View>
            </If>
          </View>
          <If when={!focusMode.on}>
            <ProjectSubagentEntry tasks={hosted().filter((task) => task.kind === "subagent")} onOpen={(task) => s().subagentOpen.set(task.id)} />
          </If>
        </View>
      </If>
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
