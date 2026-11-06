/**
 * A line of yours, changed in its own bubble (ADR 0063; `MessageEditor.svelte`). Enter keeps the
 * change, Shift+Enter starts a new line, Esc leaves the line as it was; an Enter that only confirms
 * an input method's candidate is not a save. The words are plain text: a name you mention is its
 * `@Name`, as the line itself stores it.
 */
import { keymap, platform, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import {
  COMPOSER_IME_IDLE,
  composerImeKeyAction,
  composerImeOnEnd,
  composerImeOnStart,
  composerImeOnUpdate,
  type ComposerImeState,
} from "../../m/chat/composer-ime";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { narrowWindow } from "../Modal";

/** The tallest the field grows before it scrolls inside. */
const MAX_HEIGHT = 360;
/** The field's own padding, top and bottom (the content size is of the text alone). */
const PAD = 16;

export function MessageEditor(props: {
  value: string;
  saving: boolean;
  /** Why the last save did not land, already in words. */
  error: string | null;
  onInput: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  let ime: ComposerImeState = COMPOSER_IME_IDLE;
  const content = signal(0);
  const height = () => Math.min(MAX_HEIGHT, Math.max(content() + PAD, 38));

  // Before the window's own Escape chain: this one closes the editor, nothing behind it.
  keymap.bind("escape", () => props.onCancel(), { when: "always" });

  return (
    <View role="group" accessibilityLabel={copy().chat.editThisLine} testID="msg-editor" class="w-full min-w-0 gap-[8px]">
      <Input
        testID="msg-editor-field"
        accessibilityLabel={copy().chat.editThisLine}
        multiline
        autoFocus
        submitBehavior="submit"
        value={props.value}
        disabled={props.saving}
        selectedRange={{ start: props.value.length }}
        onChange={(e) => props.onInput(e.value)}
        onContentSizeChange={(e) => content.set(e.size.height)}
        onCompositionChange={(e) => {
          ime = e.composing ? (ime.composing ? composerImeOnUpdate(ime) : composerImeOnStart()) : composerImeOnEnd(Date.now());
        }}
        onSubmit={() => {
          const action = composerImeKeyAction({ isComposing: false, key: "Enter", keyCode: 0 }, ime, Date.now());
          if (action === "pass" && !props.saving) props.onSave();
        }}
        class={`w-full px-[10px] py-[8px] border rounded-(--radius-sm) bg-pane text-ink text-[14px] ${props.error ? "border-danger-line" : "border-accent-border"}`}
        style={{ height: height() }}
      />
      <If when={props.error}>
        {(error) => (
          <Text role="alert" testID="msg-editor-error" class="text-[12px] text-danger-text">{error()}</Text>
        )}
      </If>
      <View class="flex-row flex-wrap items-center justify-between gap-[8px]">
        <If when={platform.desktop}>
          <Text class="text-[12px] text-ink-muted">{copy().chat.editHint}</Text>
        </If>
        <View class="flex-row gap-[8px] ml-auto">
          <Button testID="msg-editor-cancel" size={narrowWindow() ? "lg" : "sm"} disabled={props.saving} onPress={props.onCancel}>
            {copy().chat.editCancel}
          </Button>
          <Button testID="msg-editor-save" variant="primary" size={narrowWindow() ? "lg" : "sm"} disabled={props.saving} onPress={props.onSave}>
            {props.saving ? copy().chat.editSaving : copy().chat.editSave}
          </Button>
        </View>
      </View>
    </View>
  );
}
