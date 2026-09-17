import type { HighlightLang } from "./highlight-lang.ts";
import { highlightLangFromPath } from "./highlight-lang.ts";
import { HIGHLIGHT_CHAR_LIMIT } from "./highlight-mount.ts";
import { ensureHighlightLang, getShikiHighlighter, MONACO_SHIKI_THEMES } from "./shiki-highlighter.ts";
import type { ResolvedTheme } from "./theme.ts";

export const MONACO_THEME = {
  light: MONACO_SHIKI_THEMES.light,
  dark: MONACO_SHIKI_THEMES.dark,
} as const;

export function monacoThemeName(resolved: ResolvedTheme): string {
  return resolved === "dark" ? MONACO_THEME.dark : MONACO_THEME.light;
}

export function monacoLanguageFromPath(path: string): HighlightLang {
  return highlightLangFromPath(path);
}

export function shouldHighlightMonaco(source: string, lang: HighlightLang): boolean {
  if (lang === "plaintext") return false;
  if (source.length === 0 || source.length > HIGHLIGHT_CHAR_LIMIT) return false;
  return true;
}

let monacoReady: Promise<typeof import("monaco-editor/esm/vs/editor/editor.api")> | null = null;

function installMonacoWorker(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    MonacoEnvironment?: { getWorker: () => Worker };
  };
  if (w.MonacoEnvironment) return;
  w.MonacoEnvironment = {
    getWorker() {
      const WorkerCtor = (
        globalThis as unknown as { __RB_MONACO_WORKER__?: new () => Worker }
      ).__RB_MONACO_WORKER__;
      if (WorkerCtor) return new WorkerCtor();
      throw new Error("Monaco editor worker is not installed");
    },
  };
}

async function loadMonacoWorker(): Promise<void> {
  if (typeof window === "undefined") return;
  const g = globalThis as unknown as { __RB_MONACO_WORKER__?: new () => Worker };
  if (g.__RB_MONACO_WORKER__) return;
  const mod = await import("./monaco.worker.ts?worker");
  g.__RB_MONACO_WORKER__ = mod.default as unknown as new () => Worker;
}

export async function ensureMonaco(): Promise<typeof import("monaco-editor/esm/vs/editor/editor.api")> {
  monacoReady ??= (async () => {
    await loadMonacoWorker();
    installMonacoWorker();
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
    const highlighter = await getShikiHighlighter();
    const { shikiToMonaco } = await import("@shikijs/monaco");
    shikiToMonaco(highlighter, monaco);
    return monaco;
  })();
  return monacoReady;
}

export async function prepareMonacoLanguage(lang: HighlightLang): Promise<void> {
  if (lang === "plaintext") return;
  await ensureHighlightLang(lang);
  const monaco = await ensureMonaco();
  if (!monaco.languages.getLanguages().some((row) => row.id === lang)) {
    monaco.languages.register({ id: lang });
  }
  const highlighter = await getShikiHighlighter();
  const { shikiToMonaco } = await import("@shikijs/monaco");
  shikiToMonaco(highlighter, monaco);
}
