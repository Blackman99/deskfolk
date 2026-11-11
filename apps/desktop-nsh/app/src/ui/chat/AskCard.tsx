/**
 * What sits under a Bot's question (`AskCard.svelte`): the choices it offered, a line for your own
 * answer, and, once you answered, what you chose and wrote, kept on the card. The answer is never
 * posted as a message of yours; this card is where it stays. The card is the `ask-card` hook, and
 * while it waits on you its choices and its Reply are of the floor (ADR 0108).
 */
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Message } from "@real-bot/protocol";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import {
  COMPOSER_IME_IDLE,
  composerImeKeyAction,
  composerImeOnEnd,
  composerImeOnStart,
} from "../../m/chat/composer-ime.ts";
import { toggleAskChoice } from "../../m/notifications/ask-state.ts";
import type { AskDraftRecord } from "../../m/notifications/types.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { floor } from "../interface/floor";
import { ui } from "../interface/hooks";
import { tip } from "../tip";

export function AskCard(props: {
  message: Message;
  /** The turn is waiting on this very question, and this conversation lets you answer. */
  answerable: boolean;
  draft?: AskDraftRecord;
  sending?: boolean;
  onDraft: (body: string) => void;
  onSelect: (selected: string[]) => void;
  onSubmit: () => void;
}) {
  const t = () => copy();
  const options = () => props.message.ask?.options ?? [];
  const multi = () => Boolean(props.message.ask?.multi_select);
  const answer = () => props.message.ask_answer ?? null;
  const open = () => !answer() && props.answerable;
  const selected = () => (answer() ? answer()!.selected : (props.draft?.selected ?? []));
  const body = () => props.draft?.body ?? "";
  const canSubmit = () => open() && !props.sending && (selected().length > 0 || body().trim().length > 0);

  let ime = COMPOSER_IME_IDLE;

  function toggle(label: string): void {
    if (!open()) return;
    props.onSelect(toggleAskChoice(options(), multi(), selected(), label));
  }

  function submit(): void {
    if (canSubmit()) props.onSubmit();
  }

  // Enter that confirms an IME candidate must not send.
  function onEnter(): void {
    const action = composerImeKeyAction({ isComposing: false, key: "Enter", keyCode: 13 }, ime, Date.now());
    if (action === "pass") submit();
  }

  return (
    <View testID="ask-card" class={ui("ask-card", "gap-[8px] mt-[10px]")}>
      <If when={options().length > 0}>
        <If when={open()}>
          <Text testID="ask-mode" class="text-[12px] font-semibold text-ink-muted">{multi() ? t().stream.askPickAny : t().stream.askPickOne}</Text>
        </If>
        <View role={multi() ? "group" : "radiogroup"} accessibilityLabel={props.message.body} class="gap-[6px]">
          <Each of={options()} key={(option) => option.label}>
            {(option) => {
              const on = () => selected().includes(option().label);
              return (
                <View
                  role={multi() ? "checkbox" : "radio"}
                  ref={floor("ask", () => (open() ? { ink: "ink", ground: ["pane", on() ? "accent-tint" : "chip"] } : null))}
                  testID="ask-option"
                  accessibilityLabel={option().label}
                  accessibilityState={{ checked: on(), disabled: !open() }}
                  disabled={!open()}
                  onPress={() => toggle(option().label)}
                  class={`cursor-pointer select-none disabled:cursor-default flex-row items-start gap-[10px] w-full min-h-[38px] px-[11px] py-[8px] border rounded-(--radius-sm) ${
                    on() ? "border-brand bg-accent-tint" : `border-line bg-chip ${open() ? "hover:border-accent-border hover:bg-input-bg" : ""}`
                  } ${!open() && !on() ? "opacity-[0.55]" : ""}`}
                >
                  <View
                    class={`w-[16px] h-[16px] mt-[1px] items-center justify-center border-[1.5px] shrink-0 ${multi() ? "rounded-(--radius-xs)" : "rounded-full"} ${
                      on() ? (multi() ? "border-brand bg-brand" : "border-brand bg-pane") : "border-line-hover bg-pane"
                    }`}
                  >
                    <If when={on()}>
                      <If when={multi()} else={<View class="w-[8px] h-[8px] rounded-full bg-brand" />}>
                        <Icon name="check" size={12} class="tint-on-accent" />
                      </If>
                    </If>
                  </View>
                  <View class="flex-1 min-w-0 gap-[2px]">
                    <Text class="text-[13px] font-semibold leading-[1.35] text-ink">{option().label}</Text>
                    <If when={option().description}>
                      <Text class="text-[12px] leading-[1.4] text-ink-secondary">{option().description}</Text>
                    </If>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </If>

      <If
        when={answer()}
        else={
          <If when={open()} else={<Text testID="ask-ended" class="text-[12px] text-ink-muted">{t().notifications.askEndedReadOnly}</Text>}>
            <View class="flex-row gap-[8px] mt-[2px]">
              <Input
                testID="ask-input"
                placeholder={options().length > 0 ? t().stream.askWriteOwn : t().stream.reply}
                accessibilityLabel={options().length > 0 ? t().stream.askWriteOwn : t().stream.reply}
                value={body()}
                onChange={(e) => props.onDraft(e.value)}
                onCompositionChange={(e) => {
                  ime = e.composing ? composerImeOnStart() : composerImeOnEnd(Date.now());
                }}
                onSubmit={onEnter}
                class="flex-1 min-w-0 px-[11px] py-[7px] border border-line rounded-(--radius-sm) bg-chip text-[13px] text-ink focus:bg-input-bg focus:border-field-focus-border"
              />
              <View
                role="button"
                ref={floor("ask", { ink: "on-accent", ground: ["pane", "brand"] })}
                testID="ask-send"
                disabled={!canSubmit()}
                onPress={submit}
                class="cursor-pointer select-none disabled:cursor-default shrink-0 px-[13px] py-[7px] rounded-(--radius-sm) bg-brand hover:bg-accent-hover disabled:opacity-[0.45] items-center justify-center"
              >
                <Text class="text-[13px] font-semibold text-on-accent">{t().stream.reply}</Text>
              </View>
            </View>
            <If when={props.draft?.error}>
              <Text testID="ask-error" class="text-[12px] text-danger-text">{props.draft?.error}</Text>
            </If>
          </If>
        }
      >
        {(given: () => NonNullable<Message["ask_answer"]>) => (
          <>
            <If when={given().custom}>
              <View class="flex-row justify-end">
                <View class="max-w-[88%] px-[11px] py-[7px] bg-you rounded-tl-(--radius-md) rounded-tr-(--radius-md) rounded-bl-(--radius-md) rounded-br-(--radius-xs)">
                  <Text testID="ask-own" accessibilityLabel={t().stream.askYourAnswer} class="text-[13px] leading-[1.45] text-you-text">{given().custom}</Text>
                </View>
              </View>
            </If>
            <View class="self-end" tooltip={tip(formatFullTimestamp(given().answered_at))}>
              <Text testID="ask-answered" class="text-[12px] text-ink-muted">{`${t().stream.askAnswered} · ${formatMessageTime(given().answered_at)}`}</Text>
            </View>
          </>
        )}
      </If>
    </View>
  );
}
