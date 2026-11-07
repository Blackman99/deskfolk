import { isHiddenTranscriptKind, type Message } from "@real-bot/protocol";
import { plainPreview } from "../sidebar/preview-text.ts";
import type { TranscriptItem } from "./transcript.ts";

export type IndexMark = {
  id: string;
  index: number;
  author: string;
  kind: Message["kind"];
  created_at: string;
  preview: string;
};

export const INDEX_MIN_MARKS = 2;

/** One plain line, as the sidebar shows it: markdown taken off and a pasted key masked. */
export function indexPreview(body: string, limit = 180): string {
  const text = plainPreview(body, Number.POSITIVE_INFINITY);
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit).join("")}…`;
}

/** Message identities survive mounting windows and live output updates. */
/**
 * A message's preview, worked out again only when its body or attachments changed: the marks are made
 * again with every streamed token, and the previews were most of their cost. Checked against the
 * body, not only the object: a message can change in place.
 */
const previews = new WeakMap<object, { body: string; files: number; preview: string }>();

function previewOf(message: Extract<TranscriptItem, { type: "message" }>["message"]): string {
  const held = previews.get(message);
  if (held && held.body === message.body && held.files === message.attachments.length) return held.preview;
  const preview = indexPreview(message.body) || message.attachments.map((file) => file.original_filename).join(", ");
  previews.set(message, { body: message.body, files: message.attachments.length, preview });
  return preview;
}

export function messageIndexMarks(items: readonly TranscriptItem[]): IndexMark[] {
  return items.flatMap((item, index) => {
    if (item.type !== "message" || isHiddenTranscriptKind(item.message.kind)) return [];
    const message = item.message;
    return [{
      id: message.id, index, author: message.author, kind: message.kind,
      created_at: message.created_at,
      preview: previewOf(message),
    }];
  });
}

/** Whether two lists of marks say the same, so a list made again from the same messages can keep the old one. */
export function sameIndexMarks(a: readonly IndexMark[], b: readonly IndexMark[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.index !== y.index || x.preview !== y.preview || x.author !== y.author || x.kind !== y.kind || x.created_at !== y.created_at) return false;
  }
  return true;
}

export function activeIndexMark(
  marks: readonly IndexMark[],
  positions: ReadonlyMap<string, number>,
  viewportTop: number,
  atEnd = false,
): string | null {
  if (atEnd) return marks.at(-1)?.id ?? null;
  let active: string | null = null;
  for (const mark of marks) {
    const top = positions.get(mark.id);
    if (top === undefined) continue;
    if (top <= viewportTop + 28) active = mark.id;
    else break;
  }
  return active ?? marks.find((mark) => positions.has(mark.id))?.id ?? null;
}
