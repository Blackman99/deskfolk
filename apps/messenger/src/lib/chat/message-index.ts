import { isHiddenTranscriptKind, type Message } from "@real-bot/protocol";
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

export function indexPreview(body: string, limit = 180): string {
  const text = body.replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit).join("")}…`;
}

/** Message identities survive mounting windows and live output updates. */
export function messageIndexMarks(items: readonly TranscriptItem[]): IndexMark[] {
  return items.flatMap((item, index) => {
    if (item.type !== "message" || isHiddenTranscriptKind(item.message.kind)) return [];
    const message = item.message;
    return [{
      id: message.id, index, author: message.author, kind: message.kind,
      created_at: message.created_at,
      preview: indexPreview(message.body) || message.attachments.map((file) => file.original_filename).join(", "),
    }];
  });
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
