/**
 * The box a new annotation's remark is written in (`AnnotationComposer.svelte`): where it sits, a
 * field, the save and cancel buttons. Escape cancels, Cmd/Ctrl+Enter saves a draft.
 */
import { keymap, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { ANNOTATION_BODY_MAX } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";

export function AnnotationComposer(props: {
  /** Where the new annotation sits, as the card will say it: `第 12–18 行`. */
  position: string;
  busy: boolean;
  error: string | null;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const body = signal("");

  function save(): void {
    const text = body().trim();
    if (!text || props.busy) return;
    props.onSave(text);
  }

  keymap.bind("escape", () => props.onCancel(), { when: "always" });
  keymap.bind("mod+enter", save, { when: "always" });

  return (
    <View
      testID="annotation-composer"
      accessibilityLabel={copy().stream.annotationAdd}
      class="gap-[6px] p-2 border border-line rounded-(--radius-md) bg-pane"
      style={{ width: narrowWindow() ? "100%" : 360, maxWidth: "100%", boxShadow: shadow("md") }}
    >
      <Text class="font-mono text-[11px] text-ink-muted">{props.position}</Text>
      <Input
        testID="annotation-composer-input"
        value={body()}
        onChange={(e) => body.set(e.value)}
        multiline
        maxLength={ANNOTATION_BODY_MAX}
        autoFocus
        readonly={props.busy}
        placeholder={copy().stream.annotationPlaceholder}
        accessibilityLabel={copy().stream.annotationPlaceholder}
        class="min-h-[64px] max-h-[160px] px-2 py-[6px] border border-line rounded-(--radius-sm) bg-input-bg text-[13px] text-ink focus:border-field-focus-border"
      />
      <If when={props.error}>
        {(message: () => string) => <Text testID="annotation-composer-error" class="text-[11px] text-danger-text">{message()}</Text>}
      </If>
      <View class="flex-row gap-[6px] justify-end">
        <Button testID="annotation-composer-cancel" size={narrowWindow() ? "lg" : "sm"} disabled={props.busy} onPress={props.onCancel}>
          {copy().stream.annotationCancel}
        </Button>
        <Button
          testID="annotation-composer-save"
          variant="primary"
          size={narrowWindow() ? "lg" : "sm"}
          disabled={props.busy || !body().trim()}
          onPress={save}
        >
          {copy().stream.annotationSaveDraft}
        </Button>
      </View>
    </View>
  );
}
