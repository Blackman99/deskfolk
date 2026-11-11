/**
 * A job's question for you, in the transcript (`WorkQuestionCard.svelte`): what it asks, a box for
 * the answer while it can still be answered, and the answer kept on the card once it is saved. A
 * job that went on without an answer says so and takes none.
 */
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { WorkAnswerResult, WorkQuestionControl } from "@real-bot/protocol";
import { ApiError } from "../../m/api.ts";
import { formatFullTimestamp } from "../../m/chat/chat-view.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";

export function WorkQuestionCard(props: {
  control: WorkQuestionControl;
  botName: string;
  planName: string;
  ticketName: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  onAnswer: (body: string) => Promise<WorkAnswerResult | ApiError>;
}) {
  const draft = signal("");
  const pending = signal(false);
  const error = signal<"failed" | "unknown" | null>(null);
  // Receipt feedback only: the persisted message, not this result, owns the answer/body/time.
  const held = signal(false);
  const t = () => copy().workQuestion;
  const lapsed = () => !props.control.answer && Boolean(props.control.superseded_at);
  // A ticket named as its job is (the one a new job opens with) is not said twice, as on the line's job chip.
  const ticketShown = () => (props.ticketName && props.ticketName.trim() !== props.planName.trim() ? props.ticketName : null);

  async function submit(): Promise<void> {
    if (pending() || props.disabled || props.readOnly || props.control.answer || lapsed() || !draft().trim()) return;
    pending.set(true);
    error.set(null);
    try {
      const result = await props.onAnswer(draft());
      if (result instanceof ApiError) {
        error.set(["request_unknown", "request_pending"].includes(result.code) ? "unknown" : "failed");
      } else {
        held.set(result.inbox_state === "held");
      }
    } catch {
      error.set("failed");
    } finally {
      pending.set(false);
    }
  }

  return (
    <View testID="work-question-card" selectable accessibilityLabel={lapsed() ? t().lapsedTitle : t().title} class="w-full min-w-0 gap-[8px]">
      <Text class={`text-[14px] font-semibold ${lapsed() ? "text-ink-secondary" : "text-ink"}`}>{lapsed() ? t().lapsedTitle : t().title}</Text>
      <Text class="text-[12px] text-ink-muted">{t().context(props.botName, props.planName, ticketShown())}</Text>
      <Text testID="work-question-text" class={`text-[14px] leading-[1.6] ${lapsed() ? "text-ink-secondary" : "text-ink"}`}>{props.control.question}</Text>
      <If
        when={props.control.answer}
        else={
          <If
            when={lapsed()}
            else={
              <If
                when={props.readOnly}
                else={
                  <>
                    <Text class="text-[12px] leading-[1.5] text-ink-muted">{t().hint}</Text>
                    <View class="gap-[6px]">
                      <Text class="text-[12px] text-ink-secondary">{t().answer}</Text>
                      <Input
                        testID="work-question-input"
                        multiline
                        value={draft()}
                        accessibilityLabel={t().answer}
                        readonly={props.disabled === true || pending()}
                        onChange={(e) => draft.set(e.value)}
                        class="w-full min-h-[72px] px-[10px] py-[8px] rounded-(--radius-sm) border border-line bg-pane text-[14px] text-ink"
                      />
                    </View>
                    <Button
                      testID="work-question-submit"
                      size="md"
                      variant="secondary"
                      class="self-start"
                      disabled={props.disabled === true || pending() || !draft().trim()}
                      onPress={() => void submit()}
                    >
                      {pending() ? t().saving : t().submit}
                    </Button>
                    <If when={error()}>
                      {(which: () => "failed" | "unknown") => (
                        <Text testID="work-question-error" class="text-[12px] leading-[1.5] text-danger-text">{which() === "unknown" ? t().unknown : t().failed}</Text>
                      )}
                    </If>
                  </>
                }
              >
                <Text class="text-[12px] leading-[1.5] text-ink-muted">{t().readOnly}</Text>
              </If>
            }
          >
            <Text testID="work-question-note" class="text-[12px] leading-[1.5] text-ink-muted">{t().lapsed}</Text>
          </If>
        }
      >
        {(answer: () => NonNullable<WorkQuestionControl["answer"]>) => (
          <View class="gap-[6px] border-t border-line pt-[10px]">
            <Text class="text-[12px] text-ink-secondary">{t().answer}</Text>
            <Text testID="work-question-answer" class="text-[14px] leading-[1.6] text-ink">{answer().body}</Text>
            <Text class="text-[12px] text-ink-muted">{formatFullTimestamp(answer().at)}</Text>
            <Text testID="work-question-note" class="text-[12px] leading-[1.5] text-ink-muted">{held() ? t().held : t().saved}</Text>
          </View>
        )}
      </If>
    </View>
  );
}
