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

export async function ensureHighlightLang(lang: HighlightLang): Promise<void> {
  if (lang === "plaintext") return;
  const highlighter = await getShikiHighlighter();
  if (highlighter.getLoadedLanguages().includes(lang)) return;
  const loaded = unwrapDefault(await LANG_LOADERS[lang]());
  if (Array.isArray(loaded)) {
    await highlighter.loadLanguage(...(loaded as LanguageInput[]));
  } else {
    await highlighter.loadLanguage(loaded as LanguageInput);
  }
}


