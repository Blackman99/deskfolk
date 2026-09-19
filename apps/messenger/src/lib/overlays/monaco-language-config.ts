import type { HighlightLang } from "../highlight-lang.ts";

type MonacoApi = typeof import("monaco-editor/esm/vs/editor/editor.api");
type LanguageConfiguration = Parameters<MonacoApi["languages"]["setLanguageConfiguration"]>[1];
type ConfModule = { conf: LanguageConfiguration };

const C_LIKE_CONF: LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  folding: {
    markers: {
      start: /^\s*\/\/\s*#?region\b/,
      end: /^\s*\/\/\s*#?endregion\b/,
    },
  },
};

const HASH_CONF: LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  folding: {
    offSide: true,
    markers: {
      start: /^\s*#region\b/,
      end: /^\s*#endregion\b/,
    },
  },
};

const JSON_CONF: LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
  ],
};

const MARKUP_CONF: LanguageConfiguration = {
  comments: { blockComment: ["<!--", "-->"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "<", close: ">" },
  ],
  folding: {
    markers: {
      start: /^\s*<!--\s*#?region\b.*-->/,
      end: /^\s*<!--\s*#?endregion\b.*-->/,
    },
  },
};

const HASH_BRACKET_CONF: LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

const HASKELL_CONF: LanguageConfiguration = {
  comments: { lineComment: "--", blockComment: ["{-", "-}"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

const LANG_CONF: Partial<Record<HighlightLang, LanguageConfiguration>> = {
  typescript: C_LIKE_CONF,
  javascript: C_LIKE_CONF,
  tsx: C_LIKE_CONF,
  jsx: C_LIKE_CONF,
  json: JSON_CONF,
  html: MARKUP_CONF,
  css: C_LIKE_CONF,
  scss: C_LIKE_CONF,
  less: C_LIKE_CONF,
  markdown: MARKUP_CONF,
  python: HASH_CONF,
  rust: C_LIKE_CONF,
  go: C_LIKE_CONF,
  java: C_LIKE_CONF,
  kotlin: C_LIKE_CONF,
  c: C_LIKE_CONF,
  cpp: C_LIKE_CONF,
  csharp: C_LIKE_CONF,
  php: C_LIKE_CONF,
  ruby: HASH_CONF,
  swift: C_LIKE_CONF,
  dart: C_LIKE_CONF,
  scala: C_LIKE_CONF,
  lua: C_LIKE_CONF,
  r: HASH_CONF,
  perl: HASH_CONF,
  haskell: HASKELL_CONF,
  elixir: HASH_CONF,
  erlang: C_LIKE_CONF,
  clojure: C_LIKE_CONF,
  zig: C_LIKE_CONF,
  nim: HASH_CONF,
  shellscript: HASH_BRACKET_CONF,
  powershell: C_LIKE_CONF,
  bat: C_LIKE_CONF,
  yaml: HASH_CONF,
  toml: HASH_CONF,
  xml: MARKUP_CONF,
  sql: C_LIKE_CONF,
  graphql: C_LIKE_CONF,
  proto: C_LIKE_CONF,
  dockerfile: HASH_BRACKET_CONF,
  makefile: HASH_CONF,
  ini: HASH_BRACKET_CONF,
  properties: HASH_BRACKET_CONF,
  nginx: HASH_CONF,
  terraform: HASH_BRACKET_CONF,
  svelte: MARKUP_CONF,
  vue: MARKUP_CONF,
};

const applied = new Set<string>();

export function languageConfKind(lang: HighlightLang): "static" | "none" {
  return lang in LANG_CONF ? "static" : "none";
}

export function languageConfigurationFromModule(mod: unknown): LanguageConfiguration | null {
  if (!mod || typeof mod !== "object" || !("conf" in mod)) return null;
  const conf = (mod as ConfModule).conf;
  return conf && typeof conf === "object" ? conf : null;
}

export function languageConfigurationFor(lang: HighlightLang): LanguageConfiguration | null {
  return LANG_CONF[lang] ?? (lang === "plaintext" ? null : C_LIKE_CONF);
}

export function ensureMonacoLanguageRegistered(
  monaco: Pick<MonacoApi["languages"], "getLanguages" | "register">,
  lang: HighlightLang,
): boolean {
  if (!lang) return false;
  const existing = monaco.getLanguages().some((row) => row.id === lang);
  if (existing) return false;
  monaco.register({ id: lang });
  return true;
}

export async function applyMonacoLanguageConfiguration(
  monaco: Pick<MonacoApi["languages"], "getLanguages" | "register" | "setLanguageConfiguration">,
  lang: HighlightLang,
): Promise<void> {
  if (lang === "plaintext") return;
  ensureMonacoLanguageRegistered(monaco, lang);
  if (applied.has(lang)) return;
  const conf = languageConfigurationFor(lang);
  if (!conf) return;
  monaco.setLanguageConfiguration(lang, conf);
  applied.add(lang);
}
