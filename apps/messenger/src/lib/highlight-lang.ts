import { extensionOf } from "./overlays/artifacts.ts";

/** Shiki language ids we ship (fine-grained core, not the web bundle). */
export type HighlightLang =
  | "typescript"
  | "javascript"
  | "tsx"
  | "jsx"
  | "json"
  | "html"
  | "css"
  | "scss"
  | "less"
  | "markdown"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "kotlin"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "ruby"
  | "swift"
  | "dart"
  | "scala"
  | "lua"
  | "r"
  | "perl"
  | "haskell"
  | "elixir"
  | "erlang"
  | "clojure"
  | "zig"
  | "nim"
  | "shellscript"
  | "powershell"
  | "bat"
  | "yaml"
  | "toml"
  | "xml"
  | "sql"
  | "graphql"
  | "proto"
  | "diff"
  | "dockerfile"
  | "makefile"
  | "ini"
  | "properties"
  | "nginx"
  | "terraform"
  | "svelte"
  | "vue"
  | "plaintext";

const ALIAS: Record<string, HighlightLang> = {
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  python: "python",
  pyi: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  kotlin: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  "c++": "cpp",
  cs: "csharp",
  csharp: "csharp",
  php: "php",
  rb: "ruby",
  ruby: "ruby",
  swift: "swift",
  dart: "dart",
  scala: "scala",
  sc: "scala",
  lua: "lua",
  r: "r",
  pl: "perl",
  pm: "perl",
  perl: "perl",
  hs: "haskell",
  haskell: "haskell",
  ex: "elixir",
  exs: "elixir",
  elixir: "elixir",
  erl: "erlang",
  hrl: "erlang",
  erlang: "erlang",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  clojure: "clojure",
  zig: "zig",
  nim: "nim",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  powershell: "powershell",
  pwsh: "powershell",
  bat: "bat",
  cmd: "bat",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  protobuf: "proto",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  makefile: "makefile",
  make: "makefile",
  mk: "makefile",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  properties: "properties",
  nginx: "nginx",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
  terraform: "terraform",
  svelte: "svelte",
  vue: "vue",
  txt: "plaintext",
  log: "plaintext",
  csv: "plaintext",
  tsv: "plaintext",
};

export function normalizeHighlightLang(raw: string | undefined | null): HighlightLang | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return ALIAS[key] ?? null;
}

/** Fence class `language-ts` / `lang-js` → shipped id, or null if unknown. */
export function highlightLangFromClass(className: string | undefined | null): HighlightLang | null {
  if (!className) return null;
  const match = className.match(/(?:^|\s)(?:language|lang)-([a-zA-Z0-9_+-]+)/);
  return normalizeHighlightLang(match?.[1] ?? null);
}

export function highlightLangFromPath(path: string): HighlightLang {
  const base = path.split(/[\\/]/).pop() ?? path;
  if (/^(dockerfile|makefile|makefile\..+)$/i.test(base)) {
    return /^docker/i.test(base) ? "dockerfile" : "makefile";
  }
  const ext = extensionOf(path);
  return normalizeHighlightLang(ext) ?? "plaintext";
}

export function highlightLangLabel(lang: HighlightLang): string {
  switch (lang) {
    case "typescript":
      return "TS";
    case "javascript":
      return "JS";
    case "tsx":
      return "TSX";
    case "jsx":
      return "JSX";
    case "shellscript":
      return "SH";
    case "powershell":
      return "PS";
    case "markdown":
      return "MD";
    case "csharp":
      return "C#";
    case "cpp":
      return "C++";
    case "plaintext":
      return "TEXT";
    case "dockerfile":
      return "DOCKER";
    case "makefile":
      return "MAKE";
    case "graphql":
      return "GQL";
    case "terraform":
      return "TF";
    case "properties":
      return "PROPS";
    default:
      return lang.toUpperCase();
  }
}
