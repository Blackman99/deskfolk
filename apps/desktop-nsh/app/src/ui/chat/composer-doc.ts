/**
 * The composer's document, as the pure parts of the chip editor (`ComposerEditor.tsx`): the draft is
 * a string (`@Name` for a chip, a line break between paragraphs), the editor holds a ProseMirror
 * document of paragraphs whose inline content is text and `mention` atoms. These functions turn one
 * into the other and map between the two coordinate systems: a draft's text offsets (what the @ list
 * and the owner's handle speak) and the document's positions (what the editor speaks). A chip is one
 * position and `@Name` in the text, as `mention-chips.ts` serialises the Svelte editor's chips.
 */
import { parseMentions } from "@real-bot/protocol";

/** The node type's name of a chip. */
export const MENTION = "mention";

/** What a chip carries: the member's id (`everyone` for the whole group) and the name it is drawn and sent with. */
export type ChipAttrs = { id: string; label: string };

export type DocNode = { type: string; text?: string; attrs?: Record<string, unknown>; content?: DocNode[] };

/** A chip as a document node. */
export function chipNode(attrs: ChipAttrs): DocNode {
  return { type: MENTION, attrs: { id: attrs.id, label: attrs.label, mentionSuggestionChar: "@" } };
}

/**
 * The paragraphs of `text`: one per line, a chip for each `@Name` the roster names exactly (and
 * `@everyone`). The text around a chip is kept as it is, so the document reads back as `text`.
 * Lenient spellings stay plain text: a draft must not change under the owner.
 */
export function docFromText(text: string, roster: readonly { id: string; name: string }[]): DocNode[] {
  const byName = new Map(roster.map((member) => [member.name, member] as const));
  const names = [...byName.keys()];
  const paragraphs: DocNode[] = [];
  for (const line of text.split("\n")) {
    const content: DocNode[] = [];
    const pushText = (value: string) => {
      if (value) content.push({ type: "text", text: value });
    };
    let last = 0;
    if (line.includes("@")) {
      for (const span of parseMentions(line, names).spans) {
        const member = span.kind === "everyone" ? { id: "everyone", name: "everyone" } : span.kind === "name" && span.name ? byName.get(span.name) : undefined;
        if (!member) continue;
        pushText(line.slice(last, span.start));
        content.push(chipNode({ id: member.id, label: member.name }));
        last = span.end;
      }
    }
    pushText(line.slice(last));
    paragraphs.push(content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" });
  }
  return paragraphs;
}

type Doc = { content?: DocNode[] };

const labelOf = (node: DocNode): string => String(node.attrs?.label ?? "");
/** How many characters a node adds to the draft. */
const textLength = (node: DocNode): number => (node.type === "text" ? (node.text ?? "").length : labelOf(node).length + 1);
/** How many positions a node takes in the document. */
const sizeOf = (node: DocNode): number => (node.type === "text" ? (node.text ?? "").length : 1);

/** The draft the document reads as: paragraphs joined by a line break, a chip as `@Name`. */
export function textOfDoc(doc: Doc): string {
  return (doc.content ?? [])
    .map((paragraph) => (paragraph.content ?? []).map((node) => (node.type === "text" ? (node.text ?? "") : `@${labelOf(node)}`)).join(""))
    .join("\n");
}

/** The document position of a draft offset; inside a chip it is after the chip. Past the end: the end of the last paragraph. */
export function offsetToPos(doc: Doc, offset: number): number {
  let pos = 0;
  let base = 0;
  const paragraphs = doc.content ?? [];
  for (let i = 0; i < paragraphs.length; i++) {
    pos += 1;
    let at = base;
    if (offset <= at) return pos;
    for (const node of paragraphs[i]!.content ?? []) {
      const length = textLength(node);
      if (node.type === "text") {
        if (offset <= at + length) return pos + (offset - at);
      } else if (offset < at + length) {
        // Inside the chip's `@Name`: the caret goes after it.
        return pos + 1;
      } else if (offset === at + length) {
        return pos + 1;
      }
      at += length;
      pos += sizeOf(node);
    }
    pos += 1;
    base = at + 1;
  }
  return Math.max(1, pos - 1);
}

/** The draft offset of a document position (a position between paragraphs counts as the start of the next). */
export function posToOffset(doc: Doc, position: number): number {
  let pos = 0;
  let base = 0;
  const paragraphs = doc.content ?? [];
  for (let i = 0; i < paragraphs.length; i++) {
    pos += 1;
    let at = base;
    if (position <= pos) return at;
    for (const node of paragraphs[i]!.content ?? []) {
      const size = sizeOf(node);
      if (position <= pos + size) {
        return node.type === "text" ? at + (position - pos) : position === pos ? at : at + textLength(node);
      }
      at += textLength(node);
      pos += size;
    }
    if (position <= pos) return at;
    pos += 1;
    base = at + 1;
  }
  return base > 0 ? base - 1 : 0;
}

/** A chip in the document: where it sits and what it is. */
export type ChipAt = { from: number; to: number; id: string; label: string; followedBySpace: boolean };

/** Every chip, in order, with the positions it takes. */
export function chipsOf(doc: Doc): ChipAt[] {
  const out: ChipAt[] = [];
  let pos = 0;
  for (const paragraph of doc.content ?? []) {
    pos += 1;
    const children = paragraph.content ?? [];
    children.forEach((node, index) => {
      if (node.type !== "text") {
        const next = children[index + 1];
        out.push({ from: pos, to: pos + 1, id: String(node.attrs?.id ?? ""), label: labelOf(node), followedBySpace: next?.type === "text" && /^[  ]/.test(next.text ?? "") });
      }
      pos += sizeOf(node);
    });
    pos += 1;
  }
  return out;
}

/**
 * The range a Backspace at `caret` takes away as one unit, as `handleEditorBackspace` does: the chip
 * the caret stands right after, or right after the single space that follows a chip; the space goes
 * with it. `null`: nothing atomic here, the editor deletes as it always does.
 */
export function backspaceRange(doc: Doc, caret: number): { from: number; to: number } | null {
  for (const chip of chipsOf(doc)) {
    const end = chip.to + (chip.followedBySpace ? 1 : 0);
    if (caret === chip.to || (chip.followedBySpace && caret === end)) return { from: chip.from, to: end };
  }
  return null;
}

/** The range a forward Delete at `caret` takes away: the chip right after the caret (and the space after it). */
export function deleteRange(doc: Doc, caret: number): { from: number; to: number } | null {
  for (const chip of chipsOf(doc)) {
    if (caret === chip.from) return { from: chip.from, to: chip.to + (chip.followedBySpace ? 1 : 0) };
  }
  return null;
}
