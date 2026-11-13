/**
 * A project session's subagent, read in a popup over the conversation that sent it
 * (`ProjectSubagentDialog.svelte`, ADR 0095, 25), as a Bot↔Bot direct is: what it was asked, what
 * it said, its tool calls folded between, and where it is now while it runs. It is read from the
 * subagent's own session file, so it is read again while it goes on and once more when it ends.
 * It is yours to read, not to stop from here: Stop is in the composer.
 *
 * It is `Modal` underneath (the whole page in a narrow window, the phone's Back closing it first
 * through `holdBack`). The facts line the Svelte head carries under the title sits at the top of
 * the body on a desktop, and under the title in the narrow page. The card keeps the Svelte one's
 * height (`fill`), so it does not jump as the trail is read again; until there is a trail to read,
 * where it is and for how long sit in its middle.
 */
import { cleanup, effect, signal, Text, View, type JSX } from "nsh";
import type { AgentRunTask, AgentTaskDetail } from "@real-bot/protocol";
import { formatLiveDuration } from "../../m/chat/chat-view.ts";
import { holdBack } from "../../m/chat/message-text-pages.ts";
import { runningCall, trailBlocks } from "../../m/chat/project-tasks.ts";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { MarkdownBody } from "../MarkdownBody";
import type { FileOnDisk } from "../file-on-disk";
import { Modal, narrowWindow } from "../Modal";
import { pulseMotion } from "./labels";
import { CommandActivity } from "./CommandActivity";

const POLL_MS = 1500;

export function ProjectSubagentDialog(props: {
  task: AgentRunTask;
  onClose: () => void;
  onOpenPath: (path: string) => void;
  /** Where the files its lines name are on this computer: a right click on one opens its menu. */
  files?: FileOnDisk;
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

  const step = () => onCall() ?? props.task.activity ?? (blocks().length === 0 ? t().project.taskNoSteps : t().sidebar.statusRunning);
  const pulseDot = () => <View class="shrink-0 w-[7px] h-[7px] rounded-full bg-brand" style={{ opacity: pulse.opacity }} accessible={false} />;
  const elapsed = () => (
    <View class="flex-row items-center gap-[6px] shrink-0">
      <Icon name="clock" size={12} class="tint-ink-muted" />
      <Text class="text-[12px] text-ink-muted">{formatLiveDuration(props.task.started_at, nowMs(), t().chat.spanPart)}</Text>
    </View>
  );
  /** Nothing to read yet, or any more: the one line there is sits in the middle of the card, not alone at its top. */
  const centred = (children: JSX.Element) => <View class="flex-1 items-center justify-center gap-2 px-6 pb-10">{children}</View>;
  /** `text` is read where it shows, so a note follows what it says (loading, then failed). */
  const note = (text: () => string) => (
    <Text role="text" testID="subagent-note" class="text-[13px] text-ink-muted text-center">
      {text()}
    </Text>
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
      fill
      pageOnPhone
      subject={factsLine()}
      bodyClass="px-5 pt-4 pb-6 gap-3"
    >
      <If when={!narrowWindow()}>{factsLine()}</If>
      <If when={detail()} else={centred(note(() => (failed() ? t().project.taskReadFailed : t().project.taskLoading)))}>
        {(read: () => AgentTaskDetail) => (
          <If
            when={read().prompt || blocks().length > 0}
            else={centred(
              <If when={going()} else={note(() => t().project.taskStepsGone)}>
                <View role="text" testID="subagent-foot" class="items-center gap-2 max-w-full">
                  <View class="flex-row items-center gap-2 min-w-0 max-w-full">
                    {pulseDot()}
                    <Text testID="subagent-step" class="shrink min-w-0 text-[13px] font-medium text-brand line-clamp-1">
                      {step()}
                    </Text>
                  </View>
                  {elapsed()}
                </View>
              </If>,
            )}
          >
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
                    <MarkdownBody source={block.text} copyLabel={t().chat.copyCode} copiedLabel={t().chat.copied} onOpenArtifact={props.onOpenPath} files={props.files} />
                  </View>
                ) : (
                  <CommandActivity rows={block.rows} countLabel={t().project.taskCalls} />
                ),
              )
            }
            <If when={blocks().length === 0 && !going()}>{note(() => t().project.taskStepsGone)}</If>
            <If when={going()}>
              <View role="text" testID="subagent-foot" class="flex-row items-center gap-[6px] min-w-0">
                {pulseDot()}
                <Text testID="subagent-step" class="shrink min-w-0 text-[12px] font-medium text-brand line-clamp-1">
                  {step()}
                </Text>
                <View class="shrink-0 ml-auto pl-2">{elapsed()}</View>
              </View>
            </If>
          </If>
        )}
      </If>
    </Modal>
  );
}
