import { highlightLangFromPath, type HighlightLang } from "../highlight-lang.ts";
import { commandLine } from "./command-line.ts";

/** What a command's output is painted as: a grammar, or Shiki's own reading of colour codes. */
export type OutputLang = HighlightLang | "ansi";

/** Commands whose output is a file's own text: that file's name says how to read it. */
const VIEWERS = new Set(["cat", "head", "tail", "bat", "less", "more", "nl", "sed"]);

/** The file a viewing command prints, if its first stage is one: `cat a.py | grep x` still prints Python. */
export function viewedFile(command: string): string | null {
  const first = commandLine(command).split(/\s*(?:\||&&|;)\s*/)[0] ?? "";
  const words = first.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const program = (words[0] ?? "").split("/").pop() ?? "";
  if (!VIEWERS.has(program)) return null;
  for (let i = words.length - 1; i > 0; i--) {
    const word = words[i]!.replace(/^["']|["']$/g, "");
    if (word.startsWith("-")) continue;
    if (/\.[A-Za-z0-9]+$/.test(word)) return word;
  }
  return null;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/;

/**
 * Without the indent every line shares: a slice of a file printed from inside a function started
 * each line a dozen spaces in. The lines keep their indents relative to each other.
 */
export function dedent(text: string): string {
  let common = Infinity;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    common = Math.min(common, line.length - line.trimStart().length);
    if (common === 0) return text;
  }
  if (!Number.isFinite(common)) return text;
  return text.split("\n").map((line) => line.slice(Math.min(common, line.length - line.trimStart().length))).join("\n");
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    // One object a line (JSONL), or a document whose start the 8 KB tail cut off from its end.
    const firstLine = text.split("\n", 1)[0]!;
    try {
      JSON.parse(firstLine);
      return firstLine.trim().startsWith("{");
    } catch {
      return false;
    }
  }
}

/**
 * How to paint what a command printed: colour codes as they are; a viewed file by its name; JSON
 * and diffs by their look; anything else as a log, which picks out dates, levels, numbers and
 * strings without pretending to know the language.
 */
export function outputLang(command: string | null, text: string): OutputLang {
  if (ANSI.test(text)) return "ansi";
  const file = command ? viewedFile(command) : null;
  if (file) {
    const lang = highlightLangFromPath(file);
    if (lang !== "plaintext") return lang;
  }
  const head = text.trimStart();
  if ((head.startsWith("{") || head.startsWith("[")) && isJson(head)) return "json";
  if (/^(?:diff --git |@@ -\d)/m.test(text)) return "diff";
  return "log";
}
