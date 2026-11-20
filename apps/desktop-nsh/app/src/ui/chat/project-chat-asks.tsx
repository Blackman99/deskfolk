/**
 * The questions a project session's agent asks you (ADR 0095 addendum 2026-11-17), one card however
 * many it asked at once. Those its run waits on are asked at the run's end, under what it said
 * before them and the commands it ran (`ProjectWorking`), where the conversation ends; once the run
 * waits on none of them they go back among the lines (`ProjectAskGroup`).
 *
 * One question is its words and its card (`AskCard`), as the agent's line shows one. Several are one
 * at a time: a numbered step for each along the top, filled once it has an answer, the question and
 * its card under them. The card's button goes on to the next question without an answer, and once
 * each has one it sends them all, oldest first: the agent goes on only when it has every answer of
 * its call, so a question answered early would only wait. One refused shows its step, saying why.
 */
import { signal, Text, View } from "nsh";
import type { Message } from "@real-bot/protocol";
import { snapshot } from "../../lib/reactive";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { MarkdownBody } from "../lazy-views";
import { shadow } from "../styles";
import { AskCard } from "./AskCard";
import type { ProjectState } from "./project-chat-state";

/** A question, its words and its card, as the agent's line shows one. */
function Question(props: { message: Message; state: ProjectState; sending: boolean; submitLabel?: string; onSubmit: () => void }) {
  const t = () => copy();
  const s = () => props.state;
  const msg = () => props.message;
  return (
    <View class="w-full items-start">
      <MarkdownBody class="self-stretch" selectable={false} source={msg().body} copyLabel={t().chat.copyCode} copiedLabel={t().chat.copied} onOpenArtifact={(path) => s().openCited(path, msg().id)} files={s().files()} />
      <View class="self-stretch mt-[8px] max-w-[440px]">
        {/* A plain copy: the store's deep proxy arrays draw nothing in the card's `Each` (PORTING.md). */}
        <AskCard
          message={snapshot(msg())}
          answerable={s().awaitsAsk(msg().id) && s().connected()}
          draft={runtime.getAskDraft(msg().id)}
          sending={props.sending}
          onDraft={(body) => runtime.setAskDraft(msg().id, body)}
          onSelect={(picks) => runtime.setAskSelection(msg().id, picks)}
          onSubmit={props.onSubmit}
          submitLabel={props.submitLabel}
        />
      </View>
    </View>
  );
}

export function ProjectAsks(props: { asks: Message[]; state: ProjectState; testID?: string }) {
  const t = () => copy();
  const s = () => props.state;
  const many = () => props.asks.length > 1;
  /** The question on show, by id: answers and another call change the list under it. */
  const picked = signal<string | null>(null);
  const sendingAll = signal(false);
  const waits = (ask: Message) => !ask.ask_answer && s().awaitsAsk(ask.id);
  /** Answered, or still waiting with an answer ready to go: a choice ticked or words written. */
  const hasAnswer = (ask: Message) => {
    if (ask.ask_answer) return true;
    // One no longer waited on (Stop) took nothing: what was ticked never went.
    if (!waits(ask)) return false;
    const draft = runtime.getAskDraft(ask.id);
    return Boolean(draft && (draft.selected.length > 0 || draft.body.trim().length > 0));
  };
  /**
   * The one picked; or else the first still waiting, or the first of all. Not by what you have
   * ticked: a choice on the question on show would move you off it.
   */
  const at = () => {
    const list = props.asks;
    const chosen = list.findIndex((ask) => ask.id === picked());
    if (chosen >= 0) return chosen;
    const first = list.findIndex(waits);
    return first >= 0 ? first : 0;
  };
  const shown = () => props.asks[at()]!;
  /** The others still waiting with no answer yet, from the one after the one on show, round. */
  const missing = () => {
    const list = props.asks;
    const from = at();
    return [...list.slice(from + 1), ...list.slice(0, from)].filter((ask) => waits(ask) && !hasAnswer(ask));
  };
  const live = () => props.asks.some(waits);
  const title = () => (live() ? t().project.askingMany(s().agentName(), props.asks.length) : t().project.askedMany(s().agentName(), props.asks.length));

  async function submit(): Promise<void> {
    if (!many()) {
      await s().answerAsk(shown().id);
      return;
    }
    const next = missing()[0];
    if (next) {
      picked.set(next.id);
      return;
    }
    if (sendingAll()) return;
    sendingAll.set(true);
    try {
      for (const ask of props.asks.filter(waits)) {
        if (await s().answerAsk(ask.id)) continue;
        picked.set(ask.id);
        return;
      }
    } finally {
      sendingAll.set(false);
    }
  }

  return (
    <If
      when={many()}
      else={
        <View testID={props.testID} class="w-full">
          <Question message={shown()} state={s()} sending={s().view().sending} onSubmit={() => void submit()} />
        </View>
      }
    >
      <View
        testID={props.testID}
        role="region"
        accessibilityLabel={title()}
        class="w-full max-w-[560px] overflow-hidden border border-line rounded-(--radius-lg) bg-pane"
        style={live() ? { boxShadow: shadow("sm") } : undefined}
      >
        <View class="flex-row items-center gap-[8px] px-4 py-[9px] border-b border-line">
          <Icon name="help-circle" size={12} class="shrink-0 tint-brand" />
          <Text class="shrink min-w-0 text-[12px] font-bold text-ink line-clamp-1">{title()}</Text>
          <View role="tablist" class="flex-row items-center gap-[4px] ml-auto shrink-0">
            <Each of={props.asks} key={(ask: Message) => ask.id}>
              {(ask: () => Message, index: () => number) => {
                const on = () => ask().id === shown().id;
                const done = () => hasAnswer(ask());
                return (
                  <View
                    role="tab"
                    testID={`ask-step-${index() + 1}`}
                    accessibilityLabel={t().project.askStep(index() + 1, done())}
                    accessibilityState={{ selected: on() }}
                    onPress={() => picked.set(ask().id)}
                    class={`cursor-pointer select-none w-[22px] h-[22px] items-center justify-center rounded-full border ${
                      on() ? "border-brand bg-brand" : done() ? "border-brand bg-accent-tint hover:bg-input-bg" : "border-line bg-chip hover:border-accent-border"
                    }`}
                  >
                    <Text class={`text-[11px] font-semibold ${on() ? "text-on-accent" : done() ? "text-brand" : "text-ink-muted"}`} style={{ fontVariant: ["tabular-nums"] }}>
                      {String(index() + 1)}
                    </Text>
                  </View>
                );
              }}
            </Each>
          </View>
        </View>
        <View class="px-4 pt-[10px] pb-[14px]">
          {/* A card of its own for each question: what is typed in one does not carry into the next. */}
          <Each of={[shown().id]} key={(id: string) => id}>
            {() => (
              <Question
                message={shown()}
                state={s()}
                sending={s().view().sending || sendingAll()}
                submitLabel={missing().length > 0 ? t().project.askNext : t().project.askSubmit}
                onSubmit={() => void submit()}
              />
            )}
          </Each>
        </View>
      </View>
    </If>
  );
}
