/**
 * One built-in prompt's editor as a page over settings (`settings/PromptEditorPage.svelte`): a
 * dialog on a wide window, an inner page with Back on a phone (`Modal` with `pageOnPhone`).
 * Settings › Prompts and the call map (ADR 0082) both open it. Back, ✕, Escape or a press outside
 * all call `onClose`, after what was typed is saved.
 *
 * The Svelte breakpoint here was 720px; the page follows `Modal`'s 680px, so the list behind it
 * and the page agree on what a phone is.
 *
 * Props: `item`; `open` (`{ id, locale }`: what the editor shows); `view` + `onViewChange`;
 * `reveal` (a change to open in the history the first time it shows); `onClose`; `onLocale`;
 * `onOpenMessage`; `onReady(api)` (hands the caller `flush()`, which saves what was typed).
 */
import type { Locale, PromptSummary } from "@real-bot/protocol";
import { Text, View, windowSize } from "nsh";
import { copy, runtime } from "../../runtime";
import type { PromptView } from "../../m/settings/prompts-view.ts";
import { Modal, narrowWindow } from "../Modal";
import { PromptEditor } from "./PromptEditor";

export function PromptEditorPage(props: {
  item: PromptSummary;
  open: { id: string; locale: Locale };
  view: PromptView;
  onViewChange: (view: PromptView) => void;
  reveal?: string | null;
  onClose: () => void;
  onLocale: (locale: Locale) => void;
  onOpenMessage: (sessionId: string, messageId: string) => void;
  onReady?: (api: { flush: () => Promise<void> }) => void;
}) {
  const t = () => copy();
  const ui = (): Locale => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  let flushEditor: () => Promise<void> = async () => {};
  const close = () => {
    void flushEditor().then(() => props.onClose());
  };
  // A page tall enough that a long prompt reads as a document: the dialog's height cap less its head.
  const height = () => (narrowWindow() ? windowSize().height - 52 : Math.min(820, windowSize().height - 48) - 56);
  return (
    <Modal
      testID="prompt-editor-page"
      title={props.item.title[ui()]}
      closeLabel={t().common.close}
      backLabel={t().prompts.back}
      width={860}
      maxHeight={0.97}
      pageOnPhone
      scroll={false}
      bodyClass="p-0 gap-0"
      onClose={close}
      headExtra={
        <If when={!narrowWindow()}>
          <View class="shrink-0 px-[6px] rounded-(--radius-sm) bg-chip">
            <Text testID="prompt-editor-id" class="text-[11px] leading-[1.6] text-ink-muted font-mono">
              {props.item.id}
            </Text>
          </View>
        </If>
      }
    >
      <PromptEditor
        id={props.open.id}
        locale={props.open.locale}
        view={props.view}
        onViewChange={props.onViewChange}
        revealRevision={props.reveal}
        height={height()}
        onLocale={props.onLocale}
        onOpenMessage={props.onOpenMessage}
        onReady={(api) => {
          flushEditor = api.flush;
          props.onReady?.(api);
        }}
      />
    </Modal>
  );
}
