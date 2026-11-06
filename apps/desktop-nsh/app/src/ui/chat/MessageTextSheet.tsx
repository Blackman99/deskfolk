/**
 * A message's text on a page of its own, to copy part of it (`MessageTextSheet.svelte`). On a
 * touch screen a long press on a message opens its menu, so the bubble never selects and the
 * menu's copy takes the message whole. Here nothing claims the press: the text is selectable and
 * the phone's own selection does the rest.
 *
 * A dialog on a desktop, the whole page in a narrow window (`Modal`'s `pageOnPhone`), with the
 * phone's Back closing it first (`holdBack`) so the conversation under it stays open.
 */
import { cleanup, Text, View, type JSX } from "nsh";
import { holdBack } from "../../m/chat/message-text-pages.ts";
import { copy } from "../../runtime";
import { Modal } from "../Modal";

export function MessageTextSheet(props: {
  /** Whose line it is and when, under the title on a phone. */
  subject: string;
  onClose: () => void;
  /** The text, drawn as the conversation draws it. */
  children?: JSX.Element;
}) {
  // The page is in no URL: the phone's Back closes it and leaves the conversation open.
  cleanup(holdBack(() => props.onClose()));
  return (
    <Modal
      testID="message-text-sheet"
      title={copy().chat.selectText}
      closeLabel={copy().common.close}
      backLabel={copy().common.back}
      onClose={props.onClose}
      pageOnPhone
      width={560}
      bodyClass="px-5 py-[18px] gap-[10px]"
      subject={
        <Text testID="message-text-subject" class="text-[13px] font-medium leading-[1.3] text-ink-muted line-clamp-1">
          {props.subject}
        </Text>
      }
    >
      <Text testID="message-text-hint" class="text-[12px] leading-[1.5] text-ink-muted">
        {copy().chat.selectTextHint}
      </Text>
      <View testID="message-text" selectable class="text-[14px] leading-[1.55] text-ink">
        {props.children}
      </View>
    </Modal>
  );
}
