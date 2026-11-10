/**
 * Everything the app lets you press says so under the mouse, as the Svelte did with `button { cursor:
 * pointer }`. NSH has no selector that reaches every button: a view shows the hand only when its own
 * class (or style) names a cursor, and nsh/base's widgets leave the cursor to the app. So each one
 * says it, and this check reads the app's source for the ones that don't:
 *
 * - a `<View>` whose `role` can be pressed (button, menuitem, tab, radio, checkbox, option, switch,
 *   link) names a cursor in its `class` or `style`;
 * - a `<View>` that takes presses without such a role names one too, or is on `PLAIN` below (a
 *   backdrop, a press that only stops one, the terminal's focus);
 * - nsh/base's own pressables (`Tab`, `MenuItem`, `Radio`, `Switch`, `Checkbox`, `Toggle`, `Link`)
 *   name one in `class`, and its lists (`Select`, `Combobox`, `DatePicker`) in `itemClass`.
 *
 * A pressable that is not a link also says `select-none`: in a selectable area (a chat bubble) its
 * words are selectable text otherwise, and NSH gives the innermost text's I-beam before any view's
 * cursor around it. A link keeps its words selectable and puts the hand on them instead.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const app = resolve(import.meta.dir, "../app");

const PRESSABLE_ROLES = ["button", "menuitem", "tab", "radio", "checkbox", "option", "switch", "link"];
const PRESS_EVENTS = ["onPress", "onLongPress"];
const BASE_PRESSABLES = new Set(["Tab", "MenuItem", "Radio", "Switch", "Checkbox", "Toggle", "Link"]);
const BASE_LISTS = new Set(["Select", "Combobox", "DatePicker"]);

/** Views that take presses and rightly keep the arrow (file, then its `testID` up to the first `${`). */
const PLAIN = new Map<string, string>([
  ["src/ui/chat/MessageFileOverlay.tsx msg-file-overlay", "the backdrop: a press beside the file closes it"],
  ["src/ui/chat/MessageFileOverlay.tsx msg-file-frame", "stops a press on the file from reaching the backdrop"],
  ["src/ui/chat/MessageImageLightbox.tsx msg-image-stage", "a tap shows or hides the viewer's bars"],
  ["src/ui/overlays/WorkspaceExplorer.tsx workspace-backdrop", "the backdrop"],
  ["src/ui/panels/SessionSettingsDrawer.tsx profile-backdrop", "the backdrop"],
  ["src/ui/workbench/PaneContentHost.tsx pane-side-scrim", "the scrim beside a side pane"],
  ["src/ui/workbench/leaf-strip.tsx wb-strip-", "the strip behind the tabs (its tabs have the hand)"],
  ["src/Terminal.tsx terminal", "puts the keyboard focus in the terminal"],
  // Its style comes from `gripStyle`, which gives each grip its resize cursor.
  ["src/ui/workbench/WorkbenchFloat.tsx wb-grip-", "a resize grip"],
]);

/** A source's path under `app/`, with forward slashes on every platform, as `PLAIN` names it. */
const appPath = (file: string) => relative(app, file).split(sep).join("/");

function sources(): string[] {
  const out = [join(app, "App.tsx"), join(app, "Hosted.tsx")];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".nsh" || name === "node_modules") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".tsx") && !path.endsWith(".test.tsx")) out.push(path);
    }
  };
  walk(join(app, "src"));
  return out;
}

/** What nsh/base's names are called in a file (`Switch as BaseSwitch` → BaseSwitch: Switch). */
function baseImports(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "nsh/base") continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  return names;
}

function misses(): string[] {
  const found: string[] = [];
  for (const file of sources()) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const base = baseImports(sf);
    const rel = appPath(file);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attr = (name: string) =>
          node.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name);
        const text = (name: string) => attr(name)?.initializer?.getText(sf) ?? "";
        const names = (...props: string[]) => props.some((p) => /cursor/.test(text(p)));
        const tag = node.tagName.getText(sf);
        const at = `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} <${tag}>`;
        if (tag === "View") {
          const role = text("role");
          const pressableRole = PRESSABLE_ROLES.some((r) => role.includes(`"${r}"`));
          const takesPresses = PRESS_EVENTS.some((e) => attr(e));
          const id = text("testID").replace(/^[{`"]+/, "").split("${")[0].replace(/["`}]+$/, "");
          if ((pressableRole || takesPresses) && !names("class", "style") && !PLAIN.has(`${rel} ${id}`)) {
            found.push(`${at} ${role ? `role=${role}` : "onPress"} ${id}`);
          }
        } else if (BASE_PRESSABLES.has(base.get(tag) ?? "") && !names("class")) {
          found.push(at);
        } else if (BASE_LISTS.has(base.get(tag) ?? "") && !names("itemClass")) {
          found.push(`${at} itemClass`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test("every pressable view and widget names a cursor", () => {
  expect(misses()).toEqual([]);
});

test("every view on the plain list still exists", () => {
  const ids = new Set<string>();
  for (const file of sources()) {
    const src = readFileSync(file, "utf8");
    for (const key of PLAIN.keys()) {
      const [path, id] = key.split(" ");
      if (appPath(file) === path && src.includes(id)) ids.add(key);
    }
  }
  expect([...PLAIN.keys()].filter((key) => !ids.has(key))).toEqual([]);
});
