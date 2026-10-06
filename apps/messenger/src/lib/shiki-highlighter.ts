import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemeInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { HighlightLang } from "./highlight-lang.ts";

export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;
export const MONACO_SHIKI_THEMES = { light: "vitesse-light", dark: "vitesse-dark" } as const;

let highlighterPromise: Promise<HighlighterCore> | null = null;

const LANG_LOADERS: Record<Exclude<HighlightLang, "plaintext">, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  nim: () => import("shiki/langs/nim.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  properties: () => import("shiki/langs/properties.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  log: () => import("shiki/langs/log.mjs"),
};

function unwrapDefault<T>(mod: { default: T } | T): T {
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default: T }).default;
  }
  return mod as T;
}

async function createHighlighter(): Promise<HighlighterCore> {
  const light = unwrapDefault(await import("shiki/themes/github-light.mjs"));
  const dark = unwrapDefault(await import("shiki/themes/github-dark.mjs"));
  const monacoLight = unwrapDefault(await import("shiki/themes/vitesse-light.mjs"));
  const monacoDark = unwrapDefault(await import("shiki/themes/vitesse-dark.mjs"));
  return createHighlighterCore({
    langs: [],
    // Vitesse first: @shikijs/monaco setTheme()s highlighter.getLoadedThemes()[0].
    themes: [monacoLight, monacoDark, light, dark] as ThemeInput[],
    engine: createJavaScriptRegexEngine(),
  });
}

export function getShikiHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighter();
  return highlighterPromise;
}

type Grammar = ReturnType<HighlighterCore["getLanguage"]>;

const recovering = new WeakSet<Grammar>();

/**
 * Extra tries a grammar gets in all, for lines that run out while its regexes are still being
 * compiled. Compiling is paid once and kept, so each try gets further; the cold start of HTML's
 * embedded JS takes about six scans that each overrun a small limit, and a machine slow enough to
 * overrun 500 ms needs a few of them. Each try that runs out costs about the limit.
 */
export const WARM_UP_TRIES = 10;

/**
 * Shiki (and `@shikijs/monaco` after it) tokenizes each line under a 500 ms limit and starts the
 * next line from the rule stack wherever a line that ran out stopped, mid-rule. In WebKit the first
 * line after a cold start pays for compiling the grammar's regexes and runs out (a JS file nearly
 * always), and every line after it was read from inside that rule: the editor lost the colours of
 * the whole file, a light-theme code block the colours of its strings. A line that runs out is
 * tried again until it finishes, out of the grammar's warm-up tries; one more try was not enough on
 * a slow machine (CI's macOS runner). A line that still runs out once those are spent is slow on its
 * own, not cold, and hands on the stack it started with, as VS Code does.
 */
export function recoverFromTimeLimit(grammar: Grammar): void {
  if (recovering.has(grammar)) return;
  recovering.add(grammar);
  const tokenizeLine2 = grammar.tokenizeLine2.bind(grammar);
  let triesLeft = WARM_UP_TRIES;
  grammar.tokenizeLine2 = (line, prev, timeLimit) => {
    let result = tokenizeLine2(line, prev, timeLimit);
    while (result.stoppedEarly && triesLeft > 0) {
      triesLeft--;
      result = tokenizeLine2(line, prev, timeLimit);
    }
    return result.stoppedEarly && prev ? { ...result, ruleStack: prev } : result;
  };
}

export async function ensureHighlightLang(lang: HighlightLang): Promise<void> {
  if (lang === "plaintext") return;
  const highlighter = await getShikiHighlighter();
  // Already loaded can mean loaded as another language's embed (HTML brings JS and CSS).
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    const loaded = unwrapDefault(await LANG_LOADERS[lang]());
    if (Array.isArray(loaded)) {
      await highlighter.loadLanguage(...(loaded as LanguageInput[]));
    } else {
      await highlighter.loadLanguage(loaded as LanguageInput);
    }
  }
  recoverFromTimeLimit(highlighter.getLanguage(lang));
}


