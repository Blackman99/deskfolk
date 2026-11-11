/**
 * What the native module reads back from a document, for `PdfViewer`: a page's text runs (the
 * messenger's `TextRun`, so find, quote and highlight use `pdf-region.ts` unchanged), the text as
 * find sees it, a page's links, and the crop an annotation carries. Parsed once per page and kept
 * until the document is let go of.
 */
import { Documents } from "deskfolk/native";
import {
  matchSegments,
  pageTextIndex,
  type PageText,
  type PdfMatch,
  type TextRun,
} from "../../m/annotations/pdf-region.ts";
import {
  CROP_BYTES_MAX,
  SHRINK_LONG_SIDES,
  base64ByteLength,
  cropRect,
  scaledSize,
  type EncodedCrop,
  type NormBox,
  type Size,
} from "../../m/annotations/region-box.ts";

/** A crop is cut from the page drawn at twice its 100% size (the Svelte's `CROP_SCALE`). */
const CROP_SCALE = 2;

/** A link inside a page: its box and where it goes (a web address, or a page number from 1). */
export type PdfLink = { rect: NormBox; url?: string; page?: number };

/** A page's text, ready for find: the runs, and the joined text with where each run starts. */
export type PdfPageText = { runs: TextRun[]; index: PageText };

type RawRun = { s: string; x: number; y: number; w: number; h: number; a: 0 | 90 | 180 | 270 | null; e: boolean };
type RawLink = { x: number; y: number; w: number; h: number; uri?: string; page?: number };

/** Only these may be opened outside the app. */
export const LINK_SCHEMES = /^(https?|mailto):/i;

export function createPdfText(host: { docId: () => string; sizes: () => Size[] }) {
  const texts = new Map<number, PdfPageText>();
  const links = new Map<number, PdfLink[]>();

  /** The text of page `n` (from 1); an empty page when it cannot be read. */
  function textOf(n: number): PdfPageText {
    const had = texts.get(n);
    if (had) return had;
    let runs: TextRun[] = [];
    try {
      const raw = JSON.parse(Documents.pdfPageText(host.docId(), n - 1)) as RawRun[];
      runs = raw.map((r) => ({ text: r.s, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, angle: r.a, eol: r.e }));
    } catch {
      runs = [];
    }
    const found = { runs, index: pageTextIndex(runs.map((r) => ({ str: r.text, eol: r.eol }))) };
    texts.set(n, found);
    return found;
  }

  /** Page `n`'s links, read when first asked for. */
  function linksOf(n: number): PdfLink[] {
    const had = links.get(n);
    if (had) return had;
    let found: PdfLink[] = [];
    try {
      const raw = JSON.parse(Documents.pdfPageLinks(host.docId(), n - 1)) as RawLink[];
      found = raw.map((l) => ({ rect: { x: l.x, y: l.y, w: l.w, h: l.h }, ...(l.uri ? { url: l.uri } : {}), ...(l.page ? { page: l.page } : {}) }));
    } catch {
      found = [];
    }
    links.set(n, found);
    return found;
  }

  /**
   * The crop for a box on page `n`: the page at twice its 100% size, the box cut out with a 10%
   * margin, its long side at most 1024; PNG, stepped down in size until it fits in a megabyte. Null
   * when nothing fits or the page cannot be drawn (no JPEG here: the module has no encoder).
   */
  function crop(n: number, box: NormBox): EncodedCrop | null {
    const id = host.docId();
    const size = host.sizes()[n - 1];
    if (!id || !size) return null;
    const natural = { width: size.width * CROP_SCALE, height: size.height * CROP_SCALE };
    const rect = cropRect(box, natural);
    const first = scaledSize(rect.sw, rect.sh);
    const long = Math.max(first.width, first.height);
    for (const side of [long, ...SHRINK_LONG_SIDES.filter((s) => s < long)]) {
      const out = scaledSize(rect.sw, rect.sh, side);
      try {
        const base64 = Documents.cropPdfRegion(id, n - 1, natural.width, rect.sx, rect.sy, rect.sw, rect.sh, out.width, out.height);
        if (base64ByteLength(base64) <= CROP_BYTES_MAX) return { mime: "image/png", base64 };
      } catch {
        return null;
      }
    }
    return null;
  }

  return { textOf, linksOf, crop, clear: () => (texts.clear(), links.clear()) };
}

export type PdfTextReader = ReturnType<typeof createPdfText>;

/** Where one find match lies on its page: a box, cut along the run's reading direction. */
export type FindBox = { box: NormBox; current: boolean };

/** The boxes of every match, by page (from 1): a match over several runs gives a box per run. */
export function findBoxes(matches: readonly PdfMatch[], current: number, textOf: (n: number) => PdfPageText): Map<number, FindBox[]> {
  const byPage = new Map<number, FindBox[]>();
  matches.forEach((m, i) => {
    const text = textOf(m.page);
    for (const seg of matchSegments(text.index, m)) {
      const run = text.runs[seg.item];
      if (!run) continue;
      const length = Math.max(1, text.index.lengths[seg.item]!);
      const from = seg.start / length;
      const to = seg.end / length;
      const { x, y, w, h } = run.rect;
      let box: NormBox;
      switch (run.angle) {
        case 0:
        case undefined:
          box = { x: x + w * from, y, w: w * (to - from), h };
          break;
        case 180:
          box = { x: x + w * (1 - to), y, w: w * (to - from), h };
          break;
        case 90:
          box = { x, y: y + h * from, w, h: h * (to - from) };
          break;
        case 270:
          box = { x, y: y + h * (1 - to), w, h: h * (to - from) };
          break;
        default:
          box = run.rect;
      }
      const list = byPage.get(m.page);
      const entry = { box, current: i === current };
      if (list) list.push(entry);
      else byPage.set(m.page, [entry]);
    }
  });
  return byPage;
}
