/**
 * Code in the colours the messenger's Shiki paints it (ADR 0106), from `deskfolk/native`: giallo
 * reads VS Code's grammars with Shiki's themes, so a token has the colour it had in 0.4.0.
 * Chat's code blocks and a command's output take GitHub's colours, the file editor Vitesse's; a code
 * theme your interface chose (`behaviour.code_theme`) takes all of them, and brings its own surface
 * (`codeSurface`), as `--code-surface` did. On the web the grammars and themes come from the page the
 * first time something shows code (`wantCodeColors`, then `Highlight.ready`): a page that never shows
 * code never downloads or reads them. Until they are there a chat's code blocks are plain, and what
 * shows code draws it again once they are; when the page has none, code keeps NSH's own colours.
 *
 * Text views colour their code blocks themselves, under a `CodeColors` (MarkdownBody); this file is
 * for the editor's decorations and a command's output, which take the colours as data.
 */
import { colorScheme, signal, Text, type JSX } from "nsh";
import type { EditorDecoration } from "nsh/base";
import { Highlight } from "deskfolk/native";
import { interfaceBehaviour } from "../m/interface/behaviour.svelte.ts";

/** The app's own code colours, by where the code is (`SHIKI_THEMES`, `MONACO_SHIKI_THEMES`). */
const OWN = {
  chat: { light: "github-light", dark: "github-dark" },
  editor: { light: "vitesse-light", dark: "vitesse-dark" },
} as const;

export type CodePlace = keyof typeof OWN;

/**
 * Whether code can be coloured: at once on the desktops, on the web once the page's grammars and
 * themes are read. `failed`: they never will be (no native side, or the page has none).
 */
const ready = signal(Boolean(Highlight?.available()));
const failed = signal(!Highlight);

/** Reads the grammars and themes on a thread of the native side's own, so the first code shown does not wait (the desktops). */
export function warmCodeColors(): void {
  Highlight?.warm();
}

let asked = false;

/**
 * Something is about to show code: on the web, fetch the page's grammars and themes and read them,
 * once (it is 1.4 MB, and reading it holds the page for a moment). Nothing on the desktops, where
 * they are always there. What shows code calls it, then reads `codeColorsAvailable`.
 */
export function wantCodeColors(): void {
  if (asked || !Highlight || ready()) return;
  asked = true;
  void Highlight.ready().then(
    () => ready.set(true),
    (error: unknown) => {
      failed.set(true);
      console.warn(`[deskfolk] code keeps NSH's colours: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}

/** Whether code can be coloured now (a signal: it turns true on the web once the colours are read). */
export function codeColorsAvailable(): boolean {
  return ready();
}

/**
 * Whether text views take their code blocks' colours from here (`CodeColors`): unless the colours
 * never come, when NSH's own colour them. On the web, until the colours are read, the blocks are
 * plain (`CodeColors` without them), not in NSH's colours for a moment. A signal, like the above.
 */
export function codeColorsComing(): boolean {
  return ready() || !failed();
}

/** The themes code in `place` takes now: the ones your interface chose, else the app's own. */
export function codeThemes(place: CodePlace): { light: string; dark: string } {
  const chosen = interfaceBehaviour().code_theme ?? {};
  return { light: chosen.light ?? OWN[place].light, dark: chosen.dark ?? OWN[place].dark };
}

/** The theme of `place` in the window's appearance now. */
export function codeTheme(place: CodePlace): string {
  const themes = codeThemes(place);
  return colorScheme() === "dark" ? themes.dark : themes.light;
}

const surfaces = new Map<string, { bg: string; fg: string } | null>();

/** The surface code sits on: a chosen theme's own background and text colour; null, the app's own. */
export function codeSurface(): { bg: string; fg: string } | null {
  const look = colorScheme() === "dark" ? "dark" : "light";
  const chosen = interfaceBehaviour().code_theme?.[look];
  if (!chosen || !Highlight || !ready()) return null;
  let surface = surfaces.get(chosen);
  if (surface === undefined) {
    const [bg, fg] = Highlight.surface(chosen).split(" ");
    surface = bg && fg ? { bg, fg } : null;
    surfaces.set(chosen, surface);
  }
  return surface;
}

/** `code`'s colours: per line, four numbers a run (start and end in UTF-16 units, colour index, style bits). */
export type CodeRuns = { fg: string; bg: string; colors: string[]; lines: number[][] };

/**
 * Past this many characters code keeps NSH's colours: the editor colours the whole text again a
 * moment after each edit, where NSH's own highlighting reads only the lines in view.
 */
export const CODE_COLORS_LIMIT = 200_000;
const CACHE = 64;
const cache = new Map<string, CodeRuns | null>();

/**
 * `code` read as `language` (a name, a fence's info string or a file name) in `theme`; null when
 * unknown. `keep`: remember it (a command's output, read again as its list re-renders); the editor's
 * text changes with every edit and is not kept.
 */
export function highlightCode(code: string, language: string, theme: string, keep = true): CodeRuns | null {
  if (!Highlight || !ready() || !code || code.length > CODE_COLORS_LIMIT) return null;
  if (!keep) return parse(Highlight.highlight(code, language, theme));
  const key = `${theme}\u0000${language}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const runs = parse(Highlight.highlight(code, language, theme));
  cache.set(key, runs);
  if (cache.size > CACHE) cache.delete(cache.keys().next().value!);
  return runs;
}

const parse = (json: string): CodeRuns | null => (json ? (JSON.parse(json) as CodeRuns) : null);

type RunStyle = { color: string; fontWeight?: "bold"; fontStyle?: "italic"; textDecorationLine?: "underline" | "line-through" | "underline line-through" };

/** One style object per colour and style, shared by every run that has them. */
function styleTable(runs: CodeRuns): (index: number, bits: number) => RunStyle {
  const made = new Map<number, RunStyle>();
  return (index, bits) => {
    const key = index * 16 + bits;
    let style = made.get(key);
    if (!style) {
      style = { color: runs.colors[index] ?? runs.fg };
      if (bits & 1) style.fontWeight = "bold";
      if (bits & 4) style.fontStyle = "italic";
      const lines = [bits & 2 ? "underline" : "", bits & 8 ? "line-through" : ""].filter(Boolean).join(" ");
      if (lines) style.textDecorationLine = lines as RunStyle["textDecorationLine"];
      made.set(key, style);
    }
    return style;
  };
}

/** The editor's decorations for `runs`: each run's text in its colour (the theme's own text colour is the editor's). */
export function colorDecorations(runs: CodeRuns): EditorDecoration[] {
  const style = styleTable(runs);
  const out: EditorDecoration[] = [];
  for (let line = 0; line < runs.lines.length; line++) {
    const row = runs.lines[line]!;
    for (let i = 0; i + 3 < row.length; i += 4) {
      out.push({ range: { start: { line, column: row[i]! }, end: { line, column: row[i + 1]! } }, style: style(row[i + 2]!, row[i + 3]!) as never });
    }
  }
  return out;
}

/** `text` as spans of a `Text`: each run in its colour, the rest in the text's own. */
export function colorSpans(text: string, runs: CodeRuns): JSX.Element[] {
  const style = styleTable(runs);
  const out: JSX.Element[] = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const row = runs.lines[n] ?? [];
    let at = 0;
    for (let i = 0; i + 3 < row.length; i += 4) {
      const start = row[i]!;
      const end = row[i + 1]!;
      if (start > at) out.push(line.slice(at, start));
      out.push(<Text style={style(row[i + 2]!, row[i + 3]!)}>{line.slice(start, end)}</Text>);
      at = end;
    }
    if (at < line.length) out.push(line.slice(at));
    if (n < lines.length - 1) out.push("\n");
  }
  return out;
}
