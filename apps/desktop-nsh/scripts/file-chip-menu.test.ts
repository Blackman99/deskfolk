/**
 * A right click on a file a Bot's or a project agent's line names opens the file's menu (open it,
 * show it in Finder, copy its path; `FileChipMenu`), not the line's. Two things make it, and the
 * headless `rightClick` sees neither: it goes straight to the nearest listener and ignores
 * selections, and `onThisComputer()` is false where no shell hosts the app, as in screen tests.
 * So this check reads the source:
 *
 * - every conversation's `MarkdownBody` (everything under `ui/chat`) says where its files are on
 *   this computer (`files`), or a chip in it has no menu of its own;
 * - every text of a file's chip listens to `onContextMenu` itself: NSH sends a right click to the
 *   nearest listener around the pointer, but selectable text met first shows its own Copy / Select
 *   All instead (ADR 0107 addenda 32 and 35).
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const ui = resolve(import.meta.dir, "../app/src/ui");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function elements(sf: ts.Node, visit: (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => void): void {
  const walk = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) visit(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

const hasAttr = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, sf: ts.SourceFile, prop: string) =>
  node.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === prop);

test("every conversation's Markdown says where its files are", () => {
  const missing: string[] = [];
  let seen = 0;
  for (const name of readdirSync(join(ui, "chat")).filter((n) => n.endsWith(".tsx"))) {
    const sf = parse(join(ui, "chat", name));
    elements(sf, (node) => {
      if (node.tagName.getText(sf) !== "MarkdownBody") return;
      seen++;
      if (!hasAttr(node, sf, "files")) missing.push(`${name}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    });
  }
  expect(seen).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});

test("a file chip's texts hear the right click before any selection", () => {
  const sf = parse(join(ui, "MarkdownBody.tsx"));
  const chip = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "ArtifactChip");
  expect(chip).toBeDefined();
  const deaf: string[] = [];
  let links = 0;
  elements(chip!, (node) => {
    const tag = node.tagName.getText(sf);
    const link = tag === "View" && node.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "role" && a.initializer?.getText(sf) === '"link"');
    if (link) links++;
    if ((tag === "Text" || link) && !hasAttr(node, sf, "onContextMenu")) deaf.push(`line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} <${tag}>`);
  });
  expect(links).toBe(2);
  expect(deaf).toEqual([]);
});
