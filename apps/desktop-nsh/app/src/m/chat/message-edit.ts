import { USER_MEMBER, type Message } from "@real-bot/protocol";

/**
 * Whether a line can be changed from here (ADR 0063): a plain line of yours — not one the app
 * carried out itself or took as your answer to a question, not one you took back (ADR 0069), not a
 * batch of annotations — while the
 * daemon can take a change, the link is up and the conversation is one you can write in. The
 * daemon decides again when the change arrives; this only decides whether to offer it.
 */
export function canEditMessage(
  message: Message,
  opts: { messageEdits: boolean; connected: boolean; lockedComposer: boolean; annotated: boolean },
): boolean {
  return (
    opts.messageEdits &&
    opts.connected &&
    !opts.lockedComposer &&
    !opts.annotated &&
    message.kind === "user" &&
    message.author === USER_MEMBER &&
    !message.taken_as &&
    !message.withdrawn_at &&
    !message.annotation_source_message_id
  );
}

/** Your newest line, of those given oldest first, that can be changed: what ↑ in an empty composer opens. */
export function lastEditableLine(messages: readonly Message[], editable: (message: Message) => boolean): Message | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (message.kind === "user" && message.author === USER_MEMBER && editable(message)) return message;
  }
  return null;
}
