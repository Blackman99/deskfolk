import { marked } from 'marked';
import { classify, mustCap, TEXT_CAP, type Kind } from '../../file-kind';

/**
 * A file the reader dropped, made ready to show. Media and PDFs get a blob URL; text, Markdown and
 * HTML are read (the first TEXT_CAP bytes only) and become either text for a <pre> or a document for
 * an iframe with `sandbox=""`. Nothing here is ever placed in the page as HTML.
 */
export type Shown = {
  name: string;
  kind: Kind;
  ext: string;
  /** Blob URL for image, video, audio and PDF; revoke it when this is replaced. */
  url: string | null;
  /** Text for a <pre>. */
  text: string | null;
  /** A whole document for `<iframe sandbox="" srcdoc>`. */
  srcdoc: string | null;
  truncated: boolean;
};

/** Stops a dropped page or Markdown from fetching anything: it can only draw itself. */
const LOCK =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">';

const MARKDOWN_STYLE = `<style>
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;color:#121c20;background:#fff;margin:16px;max-width:46em}
  h1,h2,h3{line-height:1.25} h1{font-size:1.5em} h2{font-size:1.25em}
  code,pre{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:#eef1f2;border-radius:4px}
  code{padding:.1em .3em} pre{padding:10px;overflow:auto} pre code{padding:0}
  blockquote{margin:0;padding-left:12px;border-left:3px solid #b9d6dc;color:#465459}
  table{border-collapse:collapse} td,th{border:1px solid #d8e0e2;padding:4px 8px} img{max-width:100%}
  a{color:#146a7c}
</style>`;

export function markdownDoc(text: string): string {
  const body = marked.parse(text, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8">${LOCK}${MARKDOWN_STYLE}</head><body>${body}</body></html>`;
}

export function htmlDoc(text: string): string {
  return `${LOCK}${text}`;
}

/** A blob URL the browser will render: a PDF or SVG with no type of its own is given one. */
function urlFor(file: File, kind: Kind, ext: string): string {
  const need =
    kind === 'pdf' && file.type !== 'application/pdf'
      ? 'application/pdf'
      : ext === 'svg' && file.type !== 'image/svg+xml'
        ? 'image/svg+xml'
        : null;
  return URL.createObjectURL(need ? new Blob([file], { type: need }) : file);
}

export async function openFile(file: File): Promise<Shown> {
  const { kind, ext } = classify(file.name, file.type);
  const shown: Shown = { name: file.name, kind, ext, url: null, text: null, srcdoc: null, truncated: false };
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
    shown.url = urlFor(file, kind, ext);
  } else if (kind === 'text' || kind === 'markdown' || kind === 'html') {
    shown.truncated = mustCap(kind, file.size);
    const text = await file.slice(0, TEXT_CAP).text();
    if (kind === 'markdown') shown.srcdoc = markdownDoc(text);
    else if (kind === 'html') shown.srcdoc = htmlDoc(text);
    else shown.text = text;
  }
  return shown;
}
