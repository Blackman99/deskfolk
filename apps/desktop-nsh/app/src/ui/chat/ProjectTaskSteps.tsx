/**
 * What a project session's working bubble opens onto (ADR 0095, `ProjectTaskSteps.svelte`): the list
 * a Bot's does, with what a background command prints. A Bot's bytes come over the stream; these the
 * Mac reads from Claude Code's own files, so they are asked for while the list is open, and only then.
 */
import { effect, signal } from "nsh";
import type { AgentRunTask } from "@real-bot/protocol";
import type { StepRow } from "../../m/chat/turn-activity.ts";
import { runtime } from "../../runtime";
import { TurnStepList } from "./TurnStepList";

const POLL_MS = 1500;

export function ProjectTaskSteps(props: {
  id?: string;
  title: string;
  rows: StepRow[];
  /** The commands going on now, whose output is read. */
  tasks: readonly AgentRunTask[];
  onClose: () => void;
}) {
  const outputs = signal<Record<string, string>>({});
  // Which ones, not their progress: each event of the run brings new task objects.
  const asked = () => props.tasks.map((task) => `${task.run_id}/${task.id}`).join(" ");

  effect(() => {
    const key = asked();
    const api = runtime.client;
    const each = key ? key.split(" ").map((entry) => entry.split("/") as [string, string]) : [];
    if (!api || each.length === 0) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      await Promise.all(
        each.map(async ([run, task]) => {
          try {
            const detail = await api.agentTaskDetail(run, task);
            if (!gone && detail.output !== null) outputs.update((current) => ({ ...current, [task]: detail.output! }));
          } catch {
            // The next read tries again; the row still says what runs.
          }
        }),
      );
      if (!gone) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
    };
  });

  // In the transcript's one selection (`ProjectChat`), so a right click reaches the pane's menu.
  return <TurnStepList id={props.id} title={props.title} rows={props.rows} outputOf={(task) => outputs()[task] || null} selectable={false} onClose={props.onClose} />;
}
