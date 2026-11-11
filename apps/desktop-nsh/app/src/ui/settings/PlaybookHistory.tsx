/**
 * One engine's history beside the map on a wide window, in the picked step's place
 * (`settings/PlaybookHistory.svelte`, ADR 0085): every change, newest first, never rewritten. Read
 * again when the engine changes; picking a step, or ✕, goes back to the step.
 *
 * Props: `playbooks`; `playbook`; `name`; `onclose`. Test ids: `playbook-history-of-<id>`,
 * `playbook-history-close`, `playbook-history`.
 */
import type { Playbook, PlaybookRevision } from "@real-bot/protocol";
import { effect, signal, Text, View } from "nsh";
import { copy } from "../../runtime";
import { formatFullTimestamp } from "../../m/chat/chat-view.ts";
import type { Playbooks } from "../../m/settings/playbooks.svelte.ts";
import { IconButton } from "../IconButton";
import { shadow } from "../styles";

export function PlaybookHistory(props: { playbooks: Playbooks; playbook: Playbook; name: string; onclose: () => void }) {
  const c = () => copy().playbooks;
  const rows = signal<PlaybookRevision[] | null>(null);
  effect(() => {
    const id = props.playbook.id;
    void props.playbook.revision;
    void props.playbooks.revisions(id).then((read) => {
      if (props.playbook.id === id) rows.set(read);
    });
  });

  return (
    <View
      role="region"
      testID={`playbook-history-of-${props.playbook.id}`}
      accessibilityLabel={c().historyOf(props.name)}
      class="gap-[10px] p-[14px] bg-pane border border-line rounded-(--radius-md) min-w-0"
      style={{ boxShadow: shadow("xs") }}
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text role="header" class="flex-1 min-w-0 text-[14px] font-semibold text-ink">{c().historyOf(props.name)}</Text>
        <IconButton testID="playbook-history-close" icon="x" size="xs" label={copy().common.close} onPress={props.onclose} />
      </View>
      <If when={rows()}>
        <View role="list" testID="playbook-history" class="gap-[6px]">
          {() =>
            (rows() ?? []).length === 0 ? (
              <Text class="text-[12px] text-ink-muted">{c().historyEmpty}</Text>
            ) : (
              (rows() ?? []).map((row, index) => (
                <View class={`flex-row flex-wrap gap-x-[10px] gap-y-1 ${index > 0 ? "pt-[6px] border-t border-line-subtle" : ""}`}>
                  <Text class="text-[12px] font-semibold text-ink">{c().historyOp[row.op]}</Text>
                  <Text class="text-[12px] text-ink">{c().historyBy(row.actor)}</Text>
                  <Text class="text-[12px] font-mono text-ink-muted">{formatFullTimestamp(row.created_at)}</Text>
                  <Text class="text-[12px] text-ink-muted">{c().revision(row.revision)}</Text>
                </View>
              ))
            )
          }
        </View>
      </If>
    </View>
  );
}
