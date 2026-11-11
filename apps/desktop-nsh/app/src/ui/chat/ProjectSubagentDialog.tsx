/**
 * A project session's subagent, read in a popup over the conversation that sent it
 * (`ProjectSubagentDialog.svelte`, ADR 0095, 25), as a Bot↔Bot direct is: what it was asked, what
 * it said, its tool calls folded between, and where it is now while it runs. It is read from the
 * subagent's own session file, so it is read again while it goes on and once more when it ends.
 * It is yours to read, not to stop from here: Stop is in the composer.
 *
 * It is `Modal` underneath (the whole page in a narrow window, the phone's Back closing it first
 * through `holdBack`). The facts line the Svelte head carries under the title sits at the top of
 * the body on a desktop, and under the title in the narrow page.
 */
import { cleanup, effect, signal, Text, View } from "nsh";
import type { AgentRunTask, AgentTaskDetail } from "@real-bot/protocol";
import { formatLiveDuration } from "../../m/chat/chat-view.ts";
import { holdBack } from "../../m/chat/message-text-pages.ts";
import { runningCall, trailBlocks } from "../../m/chat/project-tasks.ts";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { MarkdownBody } from "../MarkdownBody";
import { Modal, narrowWindow } from "../Modal";
import { pulseMotion } from "./labels";
import { CommandActivity } from "./CommandActivity";

const POLL_MS = 1500;

export function ProjectSubagentDialog(props: {
  task: AgentRunTask;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}) {
  const t = () => copy();
  const going = () => props.task.status === "running";
  const detail = signal<AgentTaskDetail | null>(null);
  const failed = signal(false);
  const nowMs = signal(Date.now());

  // Read it, and again while it runs.
  effect(() => {
    const api = runtime.client;
    const taskId = props.task.id;
    const run = props.task.run_id;
    const again = going();
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      if (!api) return;
      try {
        const next = await api.agentTaskDetail(run, taskId);
        if (gone) return;
        detail.set(next);
        failed.set(false);
      } catch {
        if (!gone) failed.set(true);
      }
      if (!gone && again) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
    };
  });

  effect(() => {
    if (!going()) return;
    const timer = setInterval(() => nowMs.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });

  // A phone's Back closes it first, rather than leaving the conversation under it.
  cleanup(holdBack(() => props.onClose()));

  const blocks = () => trailBlocks(detail()?.steps ?? []);
  const onCall = () => (detail() ? runningCall(detail()!.steps) : null);
  const facts = () =>
    [
      props.task.agent_type,
      detail()?.model,
      props.task.tool_uses ? t().project.taskCalls(props.task.tool_uses) : null,
      props.task.tokens ? t().project.taskTokens(props.task.tokens) : null,
      props.task.status === "running" ? null : t().project.taskStatus[props.task.status],
    ]
      .filter((fact): fact is string => Boolean(fact))
      .join(" · ");
  const pulse = pulseMotion(going, 1200);

  const factsLine = () => (
    <If when={facts()}>
      <Text testID="subagent-facts" class="text-[12px] text-ink-muted line-clamp-1">
        {facts()}
      </Text>
    </If>
  );

  return (
    <Modal
      testID={`subagent-dialog-${props.task.id}`}
      title={props.task.description || t().project.taskDoing.subagent}
      closeLabel={t().common.close}
      backLabel={t().common.back}
      onClose={props.onClose}
      width={960}
      maxHeight={0.92}
      pageOnPhone
      subject={factsLine()}
      bodyClass="px-5 pt-4 pb-6 gap-3"
    >
      <If when={!narrowWindow()}>{factsLine()}</If>
      <If
        when={detail()}
        else={
          <Text role="text" testID="subagent-note" class="text-[13px] text-ink-muted">
            {failed() ? t().project.taskReadFailed : t().project.taskLoading}
          </Text>
        }
      >
        {(read: () => AgentTaskDetail) => (
          <>
            <If when={read().prompt}>
              {/* What it was asked sits where a line you send does: it was sent this. All of it, flat. */}
              <View
                testID="subagent-prompt"
                selectable
                class="self-end max-w-[85%] px-[14px] py-[10px] bg-chip rounded-tl-(--radius-lg) rounded-tr-(--radius-xs) rounded-br-(--radius-lg) rounded-bl-(--radius-lg)"
              >
                <Text class="text-[14px] leading-[1.5] text-ink">{read().prompt}</Text>
              </View>
            </If>
            {/* The Svelte rows are keyed; a list inside a dialog is a function child (PORTING.md). */}
            {() =>
              blocks().map((block) =>
                block.kind === "say" ? (
                  <View testID="subagent-say" class="min-w-0">
                    <MarkdownBody source={block.text} copyLabel={t().chat.copyCode} copiedLabel={t().chat.copied} onOpenArtifact={props.onOpenPath} />
                  </View>
                ) : (
                  <CommandActivity rows={block.rows} countLabel={t().project.taskCalls} />
                ),
              )
            }
            <If when={blocks().length === 0 && !going()}>
              <Text role="text" testID="subagent-note" class="text-[13px] text-ink-muted">
                {t().project.taskStepsGone}
              </Text>
            </If>
            <If when={going()}>
              <View role="text" testID="subagent-foot" class="flex-row items-center gap-[6px] min-w-0">
                <View class="shrink-0 w-[7px] h-[7px] rounded-full bg-brand" style={{ opacity: pulse.opacity }} accessible={false} />
                <Text testID="subagent-step" class="shrink min-w-0 text-[12px] font-medium text-brand line-clamp-1">
                  {onCall() ?? props.task.activity ?? (blocks().length === 0 ? t().project.taskNoSteps : t().sidebar.statusRunning)}
                </Text>
                <View class="flex-row items-center gap-[6px] shrink-0 ml-auto pl-2">
                  <Icon name="clock" size={12} class="tint-ink-muted" />
                  <Text class="text-[12px] text-ink-muted">{formatLiveDuration(props.task.started_at, nowMs(), t().chat.spanPart)}</Text>
                </View>
              </View>
            </If>
          </>
        )}
      </If>
    </Modal>
  );
}
