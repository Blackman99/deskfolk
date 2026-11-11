/**
 * A `List` takes its content's padding and gaps from `contentStyle` or from `contentClass`, never
 * both: as soon as `contentStyle` holds anything, NSH drops `contentClass`'s values whole
 * (`nsh-core` `ListState::apply_content`). Both transcripts once had `contentClass="py-5 gap-4"` beside a
 * `contentStyle` for the side padding, so their rows touched. This check reads the app's source for a
 * `List` that names both; write everything in `contentStyle`.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const app = resolve(import.meta.dir, "../app");

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".nsh" || name === "node_modules" || name === "target") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".tsx")) out.push(path);
    }
  };
  walk(app);
  return out;
}

test("no List names both contentClass and contentStyle", () => {
  const both: string[] = [];
  for (const path of sources()) {
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === "List") {
        const names = node.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText(sf));
        if (names.includes("contentClass") && names.includes("contentStyle")) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          both.push(`${relative(app, path)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  expect(both).toEqual([]);
});
