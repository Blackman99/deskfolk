/**
 * A Bot's change to a built-in prompt waiting on a card (ADR 0064, `PromptEditCard.svelte`): what
 * changes, line by line, and once allowed, its Undo and a way to the prompt's history in Settings.
 * Past twelve changed lines the card shows the first few until you ask for all.
 */
import { effect, signal, Text, View } from "nsh";
import type { Approval, PromptRevisionRef } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { parsePromptCard, promptCardTarget, type PromptTarget } from "../../m/settings/prompts-view.ts";
import { copy } from "../../runtime";

/** Past this many changed lines the card shows the first few until you ask for all. */
const SHORT = 12;

function Link(props: { testID?: string; disabled?: boolean; onPress: () => void; children: string }) {
  return (
    <View role="button" testID={props.testID} disabled={props.disabled} onPress={props.onPress} class="cursor-pointer select-none disabled:cursor-default self-start disabled:opacity-[0.6]">
      <Text class="text-[12px] text-brand">{props.children}</Text>
    </View>
  );
}

export function PromptEditCard(props: {
  /** The card's text: what changes, as the daemon wrote it (prompt-tools.ts). */
  body: string;
  approval: Approval | null;
  api: MessengerApi | null;
  /** Settings at this prompt's history, at the change the card let through; null when the card names none. */
  onOpenSettings: (target: PromptTarget | null) => void;
}) {
  const c = () => copy().prompts.card;
  const card = () => parsePromptCard(props.body);
  const lineCount = () => card().hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0);
  const expanded = signal(false);

  const revision = signal<PromptRevisionRef | null>(null);
  const undone = signal(false);
  const undoFailed = signal(false);
  const busy = signal(false);

  // Once you allow it, the change it made, for its Undo.
  effect(() => {
    const allowed = props.approval?.status === "allowed_once" ? props.approval.id : null;
    const api = props.api;
    if (!allowed || !api) return;
    void api.promptRevisionForApproval(allowed).then(
      (found) => revision.set(found),
      () => {},
    );
  });

  async function undo(): Promise<void> {
    const found = revision();
    if (!props.api || !found || busy()) return;
    busy.set(true);
    try {
      await props.api.undoPromptRevision(found.id);
      undone.set(true);
    } catch {
      undoFailed.set(true);
    } finally {
      busy.set(false);
    }
  }

  function openInSettings(): void {
    const found = revision();
    const prompt = found ? { id: found.prompt_id, locale: found.locale } : promptCardTarget(props.approval?.target);
    props.onOpenSettings(prompt ? { ...prompt, revisionId: found?.id ?? null } : null);
  }

  const shownHunks = () => {
    const hunks = card().hunks;
    if (expanded() || lineCount() <= SHORT) return hunks;
    const out: typeof hunks = [];
    let left = SHORT;
    for (const hunk of hunks) {
      if (left <= 0) break;
      out.push({ title: hunk.title, lines: hunk.lines.slice(0, Math.max(0, left - 1)) });
      left -= hunk.lines.length + 1;
    }
    return out;
  };

  return (
    <View testID="prompt-card" selectable class="min-w-0 gap-[6px]">
      <Text class="text-[13px] font-semibold text-ink">{card().head}</Text>
      <If when={card().reach}>
        <Text class="text-[12px] text-ink">{card().reach}</Text>
      </If>
      <If when={card().reason}>
        <Text class="text-[12px] text-ink-secondary">{card().reason}</Text>
      </If>
      <Each of={shownHunks()} key="index">
        {(hunk) => (
          <View class="gap-[2px]">
            <Text class="text-[11px] font-semibold text-ink-muted">{hunk().title}</Text>
            <View class="px-[6px] py-[4px] border border-line rounded-(--radius-sm)">
              <Each of={hunk().lines} key="index">
                {(line) => (
                  <View class={`flex-row ${line().kind === "del" ? "bg-danger-bg" : "bg-ok-bg"}`}>
                    <Text class={`w-[14px] text-[12px] font-mono ${line().kind === "del" ? "text-danger-text" : "text-ok-text"}`}>
                      {line().kind === "del" ? "−" : "+"}
                    </Text>
                    <Text class={`flex-1 min-w-0 text-[12px] leading-[1.5] font-mono ${line().kind === "del" ? "text-danger-text" : "text-ok-text"}`}>
                      {line().text || " "}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </View>
        )}
      </Each>
      <If when={card().more}>
        <Text class="text-[12px] text-ink-secondary">{card().more}</Text>
      </If>
      <If when={lineCount() > SHORT}>
        <Link testID="prompt-expand" onPress={() => expanded.set(!expanded())}>
          {expanded() ? c().collapse : c().expand}
        </Link>
      </If>
      <If when={props.approval?.status === "allowed_once"}>
        <View class="flex-row flex-wrap gap-[10px] mt-[2px]">
          <If
            when={undone()}
            else={
              <If
                when={undoFailed()}
                else={
                  <If when={revision()?.undoable}>
                    <Link testID="prompt-undo" disabled={busy()} onPress={() => void undo()}>
                      {c().undo}
                    </Link>
                  </If>
                }
              >
                <Text class="text-[12px] text-ink-secondary">{c().undoFailed}</Text>
              </If>
            }
          >
            <Text class="text-[12px] text-ink-secondary">{c().undone}</Text>
          </If>
          <Link testID="prompt-open-settings" onPress={openInSettings}>
            {c().openSettings}
          </Link>
        </View>
      </If>
    </View>
  );
}
