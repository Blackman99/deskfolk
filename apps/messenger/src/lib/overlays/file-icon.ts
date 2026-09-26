import { artifactKind, extensionOf, type ArtifactKind } from "./artifacts.ts";

export type FileIconShape =
  | "folder"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "html"
  | "markdown"
  | "code"
  | "file";

export type FileIcon = {
  shape: FileIconShape;
  tint: string;
  letter: string | null;
};

const CODE_BADGE: Record<string, { letter: string; tint: string }> = {
  ts: { letter: "TS", tint: "#3178c6" },
  mts: { letter: "TS", tint: "#3178c6" },
  cts: { letter: "TS", tint: "#3178c6" },
  tsx: { letter: "TX", tint: "#3178c6" },
  js: { letter: "JS", tint: "#c29200" },
  mjs: { letter: "JS", tint: "#c29200" },
  cjs: { letter: "JS", tint: "#c29200" },
  jsx: { letter: "JX", tint: "#c29200" },
  json: { letter: "{}", tint: "#b45309" },
  jsonc: { letter: "{}", tint: "#b45309" },
  json5: { letter: "{}", tint: "#b45309" },
  jsonl: { letter: "{}", tint: "#b45309" },
  css: { letter: "#", tint: "#2563eb" },
  scss: { letter: "#", tint: "#c13b8a" },
  less: { letter: "#", tint: "#1d4ed8" },
  py: { letter: "PY", tint: "#3572a5" },
  pyi: { letter: "PY", tint: "#3572a5" },
  rs: { letter: "RS", tint: "#b45309" },
  go: { letter: "GO", tint: "#00add8" },
  java: { letter: "JA", tint: "#b07219" },
  kt: { letter: "KT", tint: "#7f52ff" },
  kts: { letter: "KT", tint: "#7f52ff" },
  c: { letter: "C", tint: "#555555" },
  h: { letter: "H", tint: "#555555" },
  cpp: { letter: "C+", tint: "#00599c" },
  cc: { letter: "C+", tint: "#00599c" },
  cxx: { letter: "C+", tint: "#00599c" },
  hpp: { letter: "H+", tint: "#00599c" },
  php: { letter: "PHP", tint: "#4f5d95" },
  rb: { letter: "RB", tint: "#a11d21" },
  sql: { letter: "SQL", tint: "#336791" },
  yml: { letter: "YML", tint: "#cb171e" },
  yaml: { letter: "YML", tint: "#cb171e" },
  xml: { letter: "XML", tint: "#e44d26" },
  vue: { letter: "V", tint: "#42b883" },
  svelte: { letter: "SV", tint: "#ff3e00" },
  toml: { letter: "TM", tint: "#9c4221" },
  sh: { letter: "SH", tint: "#4eaa25" },
  bash: { letter: "SH", tint: "#4eaa25" },
  zsh: { letter: "SH", tint: "#4eaa25" },
};

const KIND_ICON: Record<ArtifactKind, FileIcon> = {
  directory: { shape: "folder", tint: "#64748b", letter: null },
  image: { shape: "image", tint: "#0f7a4f", letter: null },
  svg: { shape: "image", tint: "#0f7a4f", letter: null },
  audio: { shape: "audio", tint: "#7c3aed", letter: null },
  video: { shape: "video", tint: "#b45309", letter: null },
  pdf: { shape: "pdf", tint: "#dc2626", letter: null },
  word: { shape: "file", tint: "#2563eb", letter: "W" },
  spreadsheet: { shape: "file", tint: "#15803d", letter: "X" },
  presentation: { shape: "file", tint: "#c2410c", letter: "P" },
  html: { shape: "html", tint: "#e44d26", letter: null },
  markdown: { shape: "markdown", tint: "#334155", letter: null },
  text: { shape: "code", tint: "#64748b", letter: null },
  file: { shape: "file", tint: "#64748b", letter: null },
};

export function fileIconFor(path: string, opts: { isDir?: boolean } = {}): FileIcon {
  const kind = artifactKind(path, opts);
  if (kind === "text") {
    const ext = extensionOf(path);
    const badge = CODE_BADGE[ext];
    if (badge) return { shape: "code", tint: badge.tint, letter: badge.letter };
  }
  return KIND_ICON[kind];
}
