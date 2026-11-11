/**
 * The buttons under a line about your stops (`ControlActions.svelte`): your own line the app marked
 * as maybe meaning a stop, or an app's status answer or receipt. What they show is read from the
 * line and the stops in force (`control-actions.ts`); a press goes to the daemon, and the line's own
 * `acted` then says what was done: nothing here remembers it.
 */
import { effect, keymap, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import type { ControlOffer, Hold, MessageControl } from "@real-bot/protocol";
import { controlBar, partialOf, type ControlButton, type RestartPartial } from "../../m/chat/control-actions.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { NewPlanActions } from "./NewPlanActions";

const keyOf = (button: ControlButton | null) => (button ? `${button.action}:${button.taskId ?? ""}` : "");

export function ControlActions(props: {
  control: MessageControl | undefined;
  holds: readonly Hold[];
  botName: (id: string) => string;
  /** Under your own line the row sits on its right, as the line does. */
  align?: "start" | "end";
  disabled?: boolean;
  /**
   * Makes the press. Resolves to a refusal to show, `{ partial }` for a restart notice's continue
   * that a stop of yours kept from some of its turns, or nothing. `note`: what you wrote in the box
   * a button asks it in (send back on a hand-over), when you wrote anything.
   */
  onAct: (action: ControlOffer, taskId?: string, note?: string) => Promise<unknown>;
}) {
  const t = () => copy().control;
  const bar = () => controlBar(props.control, props.holds, { bot: props.botName }, t());
  const pending = signal<ControlButton | null>(null);
  const failed = signal(false);
  /** Some of the notice's turns went on, the rest a stop holds: said until the stops change or the next press. */
  const partial = signal<(RestartPartial & { over: string }) | null>(null);
  const holdsNow = () => props.holds.map((hold) => hold.id).join(" ");
  effect(() => {
    const now = holdsNow();
    const some = untracked(partial);
    if (some && some.over !== now) partial.set(null);
  });

  /** A button that asks what you want changed first (send back on a hand-over): its box under the row. */
  const asking = signal<ControlButton | null>(null);
  const noteText = signal("");
  const off = () => props.disabled === true || pending() !== null;

  function ask(button: ControlButton): void {
    if (pending() || props.disabled) return;
    asking.set(button);
    failed.set(false);
  }

  async function press(button: ControlButton, note?: string): Promise<void> {
    if (pending() || props.disabled) return;
    if (button.note && note === undefined) return ask(button);
    pending.set(button);
    failed.set(false);
    partial.set(null);
    const over = holdsNow();
    try {
      // A refusal comes back as a value; the row stays so it can be pressed again.
      const said = note?.trim();
      const answer = said ? await props.onAct(button.action, button.taskId, said) : await props.onAct(button.action, button.taskId);
      const some = partialOf(answer);
      if (some) partial.set({ ...some, over });
      else failed.set(Boolean(answer));
      if (!failed()) asking.set(null);
    } catch {
      failed.set(true);
    } finally {
      pending.set(null);
    }
  }

  // The note box: Escape closes it, Command or Control with Return sends it; Return alone is a new line.
  effect(() => {
    if (!asking()) return;
    const offs = [
      keymap.bind("escape", () => asking.set(null), { when: "always" }),
      keymap.bind(
        "mod+enter",
        () => {
          const button = untracked(asking);
          if (button) void press(button, untracked(noteText));
        },
        { when: "always" },
      ),
    ];
    return () => offs.forEach((fn) => fn());
  });

  return (
    <If
      when={props.control?.kind === "plan_opened"}
      else={
        <If
          when={bar().state === "ask"}
          else={
            <If when={bar().state === "done"}>
              <View testID="control-done" class={`flex-row flex-wrap items-center gap-[6px] mt-[6px] ${props.align === "end" ? "justify-end" : ""}`}>
                <Text class="text-[12px] text-ink-muted">{(bar() as { note: string }).note}</Text>
              </View>
            </If>
          }
        >
          <View
            testID="control-actions"
            accessibilityLabel={t().menu}
            class={`flex-row flex-wrap items-center gap-[6px] mt-[6px] ${props.align === "end" ? "justify-end" : ""}`}
          >
            <If when={(bar() as { prompt: string | null }).prompt}>
              <Text class="text-[12px] text-ink-muted">{(bar() as { prompt: string | null }).prompt}</Text>
            </If>
            <Each of={(bar() as { buttons: ControlButton[] }).buttons} key={(button) => keyOf(button)}>
              {(button) => (
                <Button
                  testID={`control-${button().action}`}
                  size="sm"
                  variant={button().primary ? "primary" : "secondary"}
                  disabled={off()}
                  onPress={() => void press(button())}
                >
                  {button().label}
                </Button>
              )}
            </Each>
            <If when={asking()}>
              <View testID="control-note-form" class="basis-full max-w-[420px] gap-[6px]">
                <Input
                  testID="control-note"
                  multiline
                  autoFocus
                  maxLength={2000}
                  submitBehavior="newline"
                  placeholder={t().sendBackNote}
                  accessibilityLabel={t().sendBackNote}
                  value={noteText()}
                  readonly={off()}
                  onChange={(e) => noteText.set(e.value)}
                  class="w-full min-h-[52px] px-[8px] py-[6px] text-[12px] text-ink bg-pane border border-line rounded-(--radius-sm) focus:border-field-focus-border"
                />
                <View class="flex-row gap-[6px]">
                  <Button testID="control-note-send" size="sm" variant="primary" disabled={off()} onPress={() => asking() && void press(asking()!, noteText())}>
                    {t().sendBackConfirm}
                  </Button>
                  <Button testID="control-note-cancel" size="sm" disabled={pending() !== null} onPress={() => asking.set(null)}>
                    {t().sendBackCancel}
                  </Button>
                </View>
              </View>
            </If>
            <If
              when={failed()}
              else={
                <If when={partial()}>
                  {(some: () => RestartPartial) => (
                    <Text testID="control-partial" class="text-[12px] text-ink-muted">{t().partlyResumed(some().continued, some().held)}</Text>
                  )}
                </If>
              }
            >
              <Text testID="control-error" class="text-[12px] text-danger-text">{t().failed}</Text>
            </If>
          </View>
        </If>
      }
    >
      <NewPlanActions
        control={props.control as Extract<MessageControl, { kind: "plan_opened" }>}
        disabled={props.disabled}
        onAct={(action, taskId) => props.onAct(action, taskId)}
      />
    </If>
  );
}
