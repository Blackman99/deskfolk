/**
 * The bar under a file that holds drafts (`AnnotationSendBar.svelte`): how many are waiting, where
 * they go, a line of summary, send and clear (clear asks once).
 */
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { ANNOTATION_BATCH_MAX } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { narrowWindow } from "../Modal";

export function AnnotationSendBar(props: {
  count: number;
  /** `将发到你和 X 的私聊`, or null when the batch goes to the session on screen. */
  destination: string | null;
  sending: boolean;
  error: string | null;
  /**
   * Send the batch — the oldest `ANNOTATION_BATCH_MAX` drafts when there are more — and say
   * whether it went out. The summary stays until it has.
   */
  onSend: (summary: string) => Promise<boolean>;
  onClear: () => void;
}) {
  const summary = signal("");
  const confirmClear = signal(false);
  /** The daemon takes at most this many at once; the rest wait for the next send. */
  const capped = () => props.count > ANNOTATION_BATCH_MAX;
  const size = () => (narrowWindow() ? "lg" : "md");

  async function send(): Promise<void> {
    if (props.sending || props.count === 0) return;
    const sent = summary();
    // A failed send (the daemon draining, a network drop) keeps what was typed for the retry.
    if ((await props.onSend(sent.trim())) && summary() === sent) summary.set("");
  }

  return (
    <View testID="annotation-send-bar" class="gap-[6px] px-3 py-2 border-t border-line bg-pane">
      <View class="flex-row items-center gap-2 flex-wrap">
        <Text class="text-[12px] font-semibold text-ink">{copy().stream.annotationSendPending(props.count)}</Text>
        <If when={props.destination}>
          {(dest: () => string) => <Text testID="annotation-send-dest" class="text-[11px] text-ink-muted">{dest()}</Text>}
        </If>
      </View>
      <View class={`flex-row items-center gap-[6px] ${narrowWindow() ? "flex-wrap" : ""}`}>
        <Input
          testID="annotation-send-summary"
          value={summary()}
          onChange={(e) => summary.set(e.value)}
          onSubmit={() => void send()}
          submitBehavior="submit"
          readonly={props.sending}
          placeholder={copy().stream.annotationSendSummary}
          accessibilityLabel={copy().stream.annotationSendSummary}
          class={`min-w-0 px-[10px] py-1 border border-line rounded-(--radius-md) bg-input-bg text-[13px] text-ink focus:border-field-focus-border ${narrowWindow() ? "w-full min-h-[40px]" : "flex-1 min-h-[32px]"}`}
        />
        <Button testID="annotation-send" variant="primary" size={size()} disabled={props.sending || props.count === 0} onPress={() => void send()}>
          {props.sending ? copy().stream.annotationSending : copy().stream.annotationSend}
        </Button>
        <If
          when={confirmClear()}
          else={
            <Button testID="annotation-clear" size={size()} disabled={props.sending} onPress={() => confirmClear.set(true)}>
              {copy().stream.annotationClear}
            </Button>
          }
        >
          <Text class="text-[11px] text-ink">{copy().stream.annotationClearConfirm}</Text>
          <Button
            testID="annotation-clear-yes"
            variant="danger-soft"
            size={size()}
            disabled={props.sending}
            onPress={() => {
              confirmClear.set(false);
              props.onClear();
            }}
          >
            {copy().stream.annotationClearYes}
          </Button>
          <Button testID="annotation-clear-no" size={size()} onPress={() => confirmClear.set(false)}>
            {copy().stream.annotationCancel}
          </Button>
        </If>
      </View>
      <If when={capped()}>
        <Text testID="annotation-send-cap" class="text-[11px] text-ink-muted">{copy().stream.annotationSendCapped(ANNOTATION_BATCH_MAX)}</Text>
      </If>
      <If when={props.error}>
        {(message: () => string) => <Text testID="annotation-send-error" class="text-[11px] text-danger-text">{message()}</Text>}
      </If>
    </View>
  );
}
