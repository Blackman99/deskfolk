import type { IconName } from "../icons.ts";
import { artifactKind, extensionOf, type ArtifactKind } from "./artifacts.ts";

export type FileIcon = {
  /** The app icon a file of this kind is drawn with, where no letter badge stands in for it. */
  glyph: IconName;
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

const KIND_TINT: Record<ArtifactKind, string> = {
  directory: "#5f6d74",
  image: "#0f7a4f",
  svg: "#0f7a4f",
  audio: "#7c3aed",
  video: "#b45309",
  pdf: "#dc2626",
  word: "#2563eb",
  spreadsheet: "#15803d",
  presentation: "#c2410c",
  html: "#e44d26",
  markdown: "#37444a",
  text: "#5f6d74",
  file: "#5f6d74",
};

const KIND_LETTER: Partial<Record<ArtifactKind, string>> = {
  word: "W",
  spreadsheet: "X",
  presentation: "P",
};

const KIND_GLYPH: Record<ArtifactKind, IconName> = {
  directory: "folder",
  image: "image",
  svg: "image",
  audio: "music",
  video: "video",
  pdf: "file-text",
  word: "file-text",
  spreadsheet: "table",
  presentation: "presentation",
  html: "code",
  markdown: "markdown",
  text: "code",
  file: "file",
};

/** Suffixes that read as something else than their kind: a table, plain prose, an archive. */
const SUFFIX_GLYPH: Record<string, IconName> = {
  csv: "table",
  tsv: "table",
  xls: "table",
  numbers: "table",
  txt: "file-text",
  log: "file-text",
  srt: "file-text",
  vtt: "file-text",
  rtf: "file-text",
  doc: "file-text",
  pages: "file-text",
  ppt: "presentation",
  key: "presentation",
  zip: "archive",
  tar: "archive",
  tgz: "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
};

/** The one-colour icon of a file: a folder, a note for a sound, a frame for a picture, a table for a sheet. */
export function fileGlyph(path: string, opts: { isDir?: boolean } = {}): IconName {
  const kind = artifactKind(path, opts);
  if (kind === "directory") return KIND_GLYPH.directory;
  return SUFFIX_GLYPH[extensionOf(path)] ?? KIND_GLYPH[kind];
}

export function fileIconFor(path: string, opts: { isDir?: boolean } = {}): FileIcon {
  const kind = artifactKind(path, opts);
  const glyph = fileGlyph(path, opts);
  if (kind === "text") {
    const badge = CODE_BADGE[extensionOf(path)];
    if (badge) return { glyph, tint: badge.tint, letter: badge.letter };
  }
  return { glyph, tint: KIND_TINT[kind], letter: KIND_LETTER[kind] ?? null };
}
