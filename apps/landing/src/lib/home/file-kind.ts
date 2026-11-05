/**
 * What kind of thing a dropped file is, decided by its extension first (a `.ts` file is often
 * labelled `video/mp2t`) and by its MIME type when the extension says nothing. The preview scene
 * opens each kind its own way and never puts a dropped file's content into the page itself.
 */

export type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'html' | 'text' | 'office' | 'unknown';

/** The most of a text, Markdown or HTML file the page reads, in bytes. */
export const TEXT_CAP = 200 * 1024;

const BY_EXT: Record<string, Kind> = {};
const put = (kind: Kind, list: string) => {
  for (const ext of list.split(' ')) BY_EXT[ext] = kind;
};
put('image', 'png jpg jpeg gif webp avif bmp svg');
put('video', 'mp4 webm mov m4v');
put('audio', 'mp3 wav m4a aac ogg flac');
put('pdf', 'pdf');
put('markdown', 'md markdown');
put('html', 'html htm');
put(
  'text',
  'txt json yaml yml toml ts tsx js jsx mjs py rs go java kt swift c h cpp hpp cs css scss svelte vue sh zsh rb php sql csv log xml ini env conf'
);
put('office', 'docx xlsx pptx doc xls ppt');

const OFFICE_MIME = /^application\/(msword|vnd\.ms-(excel|powerpoint)|vnd\.openxmlformats-officedocument\.)/;

/** The lower-case extension after the last dot of the file's own name, or '' when it has none. */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function byMime(mime: string): Kind {
  const m = mime.toLowerCase().split(';')[0].trim();
  if (m === 'image/svg+xml' || m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/markdown') return 'markdown';
  if (m === 'text/html' || m === 'application/xhtml+xml') return 'html';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml' || m === 'application/x-yaml') return 'text';
  if (OFFICE_MIME.test(m)) return 'office';
  return 'unknown';
}

export function classify(name: string, mime: string): { kind: Kind; ext: string } {
  const ext = extOf(name);
  const kind = BY_EXT[ext] ?? byMime(mime || '');
  return { kind, ext };
}

/** Kinds the page reads as text, and so reads only the first TEXT_CAP bytes of. */
export function isReadAsText(kind: Kind): boolean {
  return kind === 'text' || kind === 'markdown' || kind === 'html';
}

/** Whether reading this file must stop short: it is read as text and is longer than the cap. */
export function mustCap(kind: Kind, size: number): boolean {
  return isReadAsText(kind) && size > TEXT_CAP;
}
