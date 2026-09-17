const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  log: "text/plain",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  svelte: "text/plain",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  xml: "application/xml",
  css: "text/css",
  sql: "text/plain",
  sh: "text/plain",
  diff: "text/plain",
  patch: "text/plain",
};

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function attachmentMime(filename: string, relpath?: string): string {
  const fromName = MIME_BY_EXT[extensionOf(filename)];
  if (fromName) return fromName;
  if (relpath) {
    const fromPath = MIME_BY_EXT[extensionOf(relpath)];
    if (fromPath) return fromPath;
  }
  return "application/octet-stream";
}
