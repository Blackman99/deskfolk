/**
 * The row of keys a soft keyboard lacks, and the hidden field that holds the keyboard
 * (`.screen-keys` and `.screen-input` of `RemoteScreenView.svelte`). A modifier is armed with a press
 * and held around the next key, then let go. The field's text is the only honest record of what a
 * soft keyboard did (an input method composes in place), so what it holds is compared with a
 * one-space sentinel and the difference goes to the Mac as keys.
 */
import { keymap, Text, View, cleanup, signal, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { Icon } from "../Icon";
import { copy } from "../../runtime";
import { KEYSYM, SCREEN_KEYS, modifiersFor, press, typeText, type Modifier } from "../../m/overlays/remote-screen-keys.ts";
import type { ScreenController } from "./remote-screen-controller.ts";

const SENTINEL = " ";

/** Keys a tablet's keyboard sends that change nothing in the field. */
const KEYSTROKES: Record<string, number> = {
  up: KEYSYM.up,
  down: KEYSYM.down,
  left: KEYSYM.left,
  right: KEYSYM.right,
  tab: KEYSYM.tab,
  delete: KEYSYM.delete,
};

export function ScreenKeys(props: { screen: ScreenController }) {
  const screen = props.screen;
  const words = () => screen.words;
  const modifiers = () => modifiersFor(screen.host);
  const draft = signal(SENTINEL);
  let composing = false;
  let input: InputRef | undefined;
  let unbind: (() => void) | null = null;
  const send = (keysym: number, down: boolean) => screen.send(keysym, down);
  cleanup(() => unbind?.());

  const toggleKeyboard = () => {
    if (screen.keyboardUp()) input?.blur();
    else input?.focus();
  };

  const bindKeys = () => {
    unbind?.();
    const bindings: Record<string, () => void> = {};
    for (const [keystroke, keysym] of Object.entries(KEYSTROKES)) {
      bindings[keystroke] = () => press(send, keysym, screen.takeArmed());
    }
    unbind = keymap.bind(bindings, { when: "always", repeat: true });
  };

  return (
    <>
      <View
        role="group"
        accessibilityLabel={words().keys}
        testID="screen-keys"
        class="flex-row gap-1 px-2 py-[6px] border-t border-line bg-pane"
      >
        <View
          role="button"
          testID="screen-key-keyboard"
          accessibilityLabel={words().keyboard}
          accessibilityState={{ selected: screen.keyboardUp() }}
          onPress={toggleKeyboard}
          class={`cursor-pointer select-none grow basis-0 min-w-[30px] h-[36px] items-center justify-center rounded-(--radius-sm) border bg-input-bg ${screen.keyboardUp() ? "border-brand" : "border-line"}`}
        >
          <Icon name="keyboard" size={20} class={screen.keyboardUp() ? "tint-brand" : "tint-ink"} />
        </View>
        <Each of={modifiers().slice()} key={(m) => m.id}>
          {(modifier: () => { id: Modifier; label: string; name: string }) => (
            <View
              role="button"
              testID={`screen-key-${modifier().id}`}
              accessibilityLabel={words().modifier(modifier().name)}
              accessibilityState={{ selected: screen.armed().includes(modifier().id) }}
              onPress={() => screen.toggleModifier(modifier().id)}
              class={`cursor-pointer select-none grow basis-0 min-w-[30px] h-[36px] items-center justify-center rounded-(--radius-sm) border bg-input-bg ${screen.armed().includes(modifier().id) ? "border-brand" : "border-line"}`}
            >
              <Text class={`text-[15px] ${screen.armed().includes(modifier().id) ? "text-brand" : "text-ink"}`}>{modifier().label}</Text>
            </View>
          )}
        </Each>
        <Each of={SCREEN_KEYS.slice()} key={(k) => k.id}>
          {(key: () => { id: string; label: string; keysym: number }) => (
            <View
              role="button"
              testID={`screen-key-${key().id}`}
              onPress={() => press(send, key().keysym, screen.takeArmed())}
              class="cursor-pointer select-none grow basis-0 min-w-[30px] h-[36px] items-center justify-center rounded-(--radius-sm) border border-line bg-input-bg"
            >
              <Text class="text-[15px] text-ink">{key().label}</Text>
            </View>
          )}
        </Each>
      </View>
      <Input
        ref={(node) => (input = node)}
        value={draft()}
        testID="screen-input"
        accessibilityLabel={words().keyboard}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="send"
        submitBehavior="submit"
        onFocus={() => {
          screen.keyboardUp.set(true);
          bindKeys();
        }}
        onBlur={() => {
          screen.keyboardUp.set(false);
          unbind?.();
          unbind = null;
        }}
        onCompositionChange={(e) => {
          composing = e.composing;
        }}
        onChange={(e) => {
          draft.set(e.value);
          if (composing) return;
          const next = e.value;
          let common = 0;
          while (common < SENTINEL.length && common < next.length && SENTINEL[common] === next[common]) common++;
          const removed = SENTINEL.length - common;
          const added = next.slice(common);
          // A deletion alone is the Backspace key press, which already went; typing over text sends both.
          if (added) {
            const held = screen.takeArmed();
            for (let i = 0; i < removed; i++) press(send, KEYSYM.backspace, i === 0 ? held : []);
            typeText(send, added, removed ? [] : held);
          }
          setTimeout(() => draft.set(SENTINEL), 0);
        }}
        onKeyPress={(e) => {
          if (e.key === "Enter") press(send, KEYSYM.enter, screen.takeArmed());
          else if (e.key === "Backspace") press(send, KEYSYM.backspace, screen.takeArmed());
          else if (e.key === "Escape") press(send, KEYSYM.escape, screen.takeArmed());
        }}
        style={{ position: "absolute", left: 0, bottom: 0, width: 2, height: 2, opacity: 0 }}
      />
    </>
  );
}
