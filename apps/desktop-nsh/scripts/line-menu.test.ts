/**
 * A right click on a line's words opens the line's menu (reply, edit, copy, …), as the Svelte stage
 * did. NSH sends a right click to the nearest view around the pointer that listens to
 * `onContextMenu`, but a selectable view or selectable text met first shows NSH's own Copy / Select
 * All instead, and looks no further. The headless `rightClick` goes straight to the nearest listener
 * and never sees that, so a screen test passes either way; this check reads the source instead:
 *
 * - each transcript row whose line has a menu makes its words a selection with `lineSelection`
 *   (`transcript-parts.tsx`), which listens on the selectable view itself, and no `<View>` in it
 *   says `selectable` on its own;
 * - nothing drawn inside such a row is a selection of its own: Markdown and text views say
 *   `selectable={false}` (they still select, as part of the row's view), no view says `selectable`
 *   and no text says `select-text`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const chat = resolve(import.meta.dir, "../app/src/ui/chat");

/** The rows whose line opens the message's menu. */
const ROWS = ["TranscriptBotGroup.tsx", "TranscriptUserGroup.tsx", "TranscriptSystem.tsx", "TranscriptAsk.tsx"];
/** What those rows draw inside their selectable view. */
const INSIDE = [
  "QuoteRef.tsx",
  "MessageAttachments.tsx",
  "AskCard.tsx",
  "ControlActions.tsx",
  "WorkQuestionCard.tsx",
  "MessageEditor.tsx",
  "../annotations/AnnotationCards.tsx",
];
/** Text components that are a selection of their own unless told otherwise. */
const TEXTS = new Set(["MarkdownBody", "TextView", "TurnStepList"]);

function misses(): string[] {
  const found: string[] = [];
  for (const name of [...ROWS, ...INSIDE]) {
    const file = join(chat, name);
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (ROWS.includes(name) && !/\{\.\.\.lineSelection\(/.test(src)) found.push(`${name}: no lineSelection`);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        const attr = (prop: string) =>
          node.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === prop);
        const at = `${name}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} <${tag}>`;
        const selectable = attr("selectable");
        if (tag === "View" && selectable) found.push(`${at} selectable`);
        if (TEXTS.has(tag) && selectable?.initializer?.getText(sf) !== "{false}") found.push(`${at} without selectable={false}`);
        const look = `${attr("class")?.initializer?.getText(sf) ?? ""} ${attr("style")?.initializer?.getText(sf) ?? ""}`;
        if (/\bselect-text\b|userSelect:\s*"text"/.test(look)) found.push(`${at} selectable text`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test("a right click on a line's words reaches the line's menu", () => {
  expect(misses()).toEqual([]);
});
