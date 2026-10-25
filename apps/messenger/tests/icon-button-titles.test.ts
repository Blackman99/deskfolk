import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "svelte/compiler";

/**
 * Every button that shows only an icon has a tooltip.
 *
 * A button with no words on it says what it does only in its `aria-label`, which a screen reader
 * hears and the pointer never sees. `IconButton.svelte` puts the label in `title` too, but most
 * icon buttons in the app are written by hand (`<button class="modal-back"><Icon …/></button>`),
 * and those kept getting the `aria-label` alone: back chevrons, ✕ closes, ⋯ menus.
 *
 * Lives in `tests/`, not `src/`: `svelte/compiler` is a build-time package, and
 * `src/lib/build-imports.test.ts` keeps those out of the client module graph.
 *
 * What counts as icon-only: an `Icon`, `<svg>`, `<img>`, a component named like an icon, or text
 * with no letter or digit in it (✕ ‹ › + ↑). A button that also holds words, an expression or any
 * other component is left alone; so is an empty one, which is a drag handle or a backdrop. A button
 * that shows something of its own when the pointer comes onto it (`onpointerenter` /
 * `onmouseenter`) is left alone too: a native tooltip would sit over its own.
 */
const SRC = join(import.meta.dir, "../src");

/** Icon-only, and deliberately without a tooltip. */
const EXEMPT: { file: string; className: string; why: string }[] = [
  {
    file: "lib/annotations/ImageAnnotator.svelte",
    className: "artifact-img-open",
    why: "the whole picture is the button; a tooltip would follow the pointer across it",
  },
];

const ICON_COMPONENT = /^(Icon|.+Icon|.+Glyph|.+Logo|.+Avatar)$/;

type Node = { type: string; name?: string; start: number; end: number; [key: string]: unknown };
type Attribute = { type: string; name: string; value: unknown };
type Seen = { words: boolean; icon: boolean };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (path.endsWith(".svelte")) out.push(path);
  }
  return out;
}

function attributes(node: Node): Attribute[] {
  return ((node.attributes as Attribute[] | undefined) ?? []).filter((a) => a.type === "Attribute");
}

function staticClass(node: Node): string {
  const value = attributes(node).find((a) => a.name === "class")?.value;
  if (!Array.isArray(value)) return "";
  return value.map((part: { type: string; data?: string }) => (part.type === "Text" ? part.data : " ")).join("");
}

function children(fragment: unknown): Node[] {
  return ((fragment as { nodes?: Node[] } | undefined)?.nodes) ?? [];
}

/** What a button's content shows. Both branches of an `{#if}` count. */
function seen(nodes: Node[], source: string): Seen {
  const out: Seen = { words: false, icon: false };
  const add = (inner: Seen) => {
    out.words ||= inner.words;
    out.icon ||= inner.icon;
  };
  for (const node of nodes) {
    switch (node.type) {
      case "Text": {
        const text = String(node.data).replace(/\s+/g, "");
        if (/[\p{L}\p{N}]/u.test(text)) out.words = true;
        else if (text) out.icon = true;
        break;
      }
      case "ExpressionTag": {
        // `{dir === 'asc' ? '↑' : '↓'}` is a glyph; anything else may be words.
        const code = source.slice(node.start, node.end);
        const glyph = /\?\s*(['"])[^\p{L}\p{N}'"]*\1\s*:\s*(['"])[^\p{L}\p{N}'"]*\2\s*\}$/u.test(code)
          || /^\{\s*(['"])[^\p{L}\p{N}'"]*\1\s*\}$/u.test(code);
        if (glyph) out.icon = true;
        else out.words = true;
        break;
      }
      case "RegularElement":
        if (node.name === "svg" || node.name === "img") out.icon = true;
        // Words only a screen reader gets are not on the button.
        else if (!staticClass(node).split(/\s+/).includes("sr-only")) add(seen(children(node.fragment), source));
        break;
      case "Component":
        if (ICON_COMPONENT.test(String(node.name))) out.icon = true;
        else out.words = true;
        break;
      case "IfBlock":
        add(seen(children(node.consequent), source));
        add(seen(children(node.alternate), source));
        break;
      case "EachBlock":
        add(seen(children(node.body), source));
        break;
      case "KeyBlock":
        add(seen(children(node.fragment), source));
        break;
      case "RenderTag":
      case "HtmlTag":
        out.words = true;
        break;
    }
  }
  return out;
}

test("every icon-only button has a tooltip", () => {
  const missing: string[] = [];
  const exemptHits = new Set<string>();
  for (const path of walk(SRC)) {
    const source = readFileSync(path, "utf8");
    // Forward slashes, as in EXEMPT: on Windows `relative` gives backslashes.
    const file = relative(SRC, path).split(sep).join("/");
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const node = value as Node;
      if (node.type === "RegularElement" && node.name === "button") {
        const content = seen(children(node.fragment), source);
        const names = new Set(attributes(node).map((a) => a.name));
        const hoverOfItsOwn = names.has("onpointerenter") || names.has("onmouseenter");
        if (content.icon && !content.words && !names.has("title") && !hoverOfItsOwn) {
          const classes = staticClass(node).split(/\s+/);
          const exempt = EXEMPT.find((e) => e.file === file && classes.includes(e.className));
          if (exempt) exemptHits.add(`${exempt.file} .${exempt.className}`);
          else missing.push(`${file}:${source.slice(0, node.start).split("\n").length}`);
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (key !== "parent" && key !== "metadata") visit(child);
      }
    };
    visit(parse(source, { modern: true }).fragment);
  }
  // Give it a `title` that says the same as its `aria-label`.
  expect(missing).toEqual([]);
  // An exemption whose button is gone, or got its tooltip, comes off the list.
  expect([...exemptHits].sort()).toEqual(EXEMPT.map((e) => `${e.file} .${e.className}`).sort());
});
