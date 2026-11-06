/**
 * The document on screen, for `PdfViewer`: opening it in the native module (`Documents`, hayro),
 * laying its pages out, zooming, keeping the reader's place through a zoom, and the page images the
 * rows ask for. The messenger's `pdf-pages.svelte.ts` drew canvases and a text layer with pdf.js;
 * here a page is one PNG the native module renders at the width it is shown (re-rendered once a
 * zoom has settled), and the maths — fits, layout, current page, evictions — is the messenger's
 * `annotations/pdf-region.ts`, unchanged.
 *
 * Not here: the password form (hayro cannot decrypt, so an encrypted file is "broken"), the text
 * layer, links and find (the native module gives no text yet).
 */
import { Documents } from "deskfolk/native";
import { cleanup, computed, effect, pixelRatio, signal, untracked, type ListRef } from "nsh";
import {
  PAGE_GAP,
  PDF_TO_CSS_UNITS,
  clampZoom,
  currentPageAt,
  fitBasis,
  outputScaleFor,
  pageLayout,
  parsePageNumber,
  parseZoomMenuValue,
  pickEvictions,
  resolveZoom,
  scrollTopForPage,
  type PageLayout,
  type ZoomMode,
} from "../../m/annotations/pdf-region.ts";
import type { Size } from "../../m/annotations/region-box.ts";
import { runtime } from "../../runtime";

/** Rendering waits this long after a zoom, so a pinch does not draw every step of the way. */
export const ZOOM_SETTLE_MS = 120;

/** Where a PDF is fetched from: the runtime's file endpoint (or any URL it answers) and its token. A new one opens a new document. */
export type PdfSource = { url: string; token: string };

/** The source of a workspace file, on the runtime this window is connected to; null while it is not connected. */
export function pdfSourceFor(path: string): PdfSource | null {
  const client = runtime.client;
  if (!client || client.kind !== "local") return null;
  const { origin, token } = client.endpoint;
  return { url: `${origin}/v1/workspace/file?path=${encodeURIComponent(path)}`, token };
}

export type PdfStatus = "loading" | "ready" | "broken" | "failed";

type Drawn = { px: number; uri: string; pixels: number; lastUsed: number };

let opened = 0;

export type PdfPages = ReturnType<typeof createPdfPages>;

export function createPdfPages(host: {
  source: () => PdfSource | null;
  /** The document was let go of: whatever the viewer holds for it goes too. */
  onReset: () => void;
}) {
  const status = signal<PdfStatus>("loading");
  /** Pages' sizes at 100%, in CSS px (the native module reports points). */
  const sizes = signal<Size[]>([]);
  const zoomMode = signal<ZoomMode>({ kind: "fit-width" });
  const box = signal<Size>({ width: 0, height: 0 });
  const currentPage = signal(1);
  const pageInput = signal("1");
  /** The zoom the page images are drawn at: follows `zoom` once it has stopped changing. */
  const renderZoom = signal(1);
  /** Bumped per opened document: late answers from the previous one are dropped. */
  const docKey = signal("");

  let docGen = 0;
  let docId = "";
  let pageInputFocused = false;
  let listRef: ListRef | null = null;
  let offset = 0;
  /** Where the reader is, so a zoom keeps the same spot on screen. */
  let anchor: { page: number; frac: number } | null = null;
  let shownZoom = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const drawn = new Map<number, Drawn>();
  let useClock = 0;

  const numPages = () => sizes().length;
  const pageNumbers = computed(() => Array.from({ length: sizes().length }, (_, i) => i + 1));
  const basis = computed(() => fitBasis(sizes()));
  const zoom = computed(() => {
    const b = basis();
    if (!b) return 1;
    // Nothing to fit into before the area is measured.
    if (zoomMode().kind !== "scale" && box().width <= 0) return 1;
    return resolveZoom(zoomMode(), b, box());
  });
  const layout = computed<PageLayout>(() => pageLayout(sizes(), zoom()));
  /** The widest page, plus the gutters: what the horizontal scroll area has to be at least. */
  const contentWidth = computed(() => Math.max(box().width, ...layout().widths.map((w) => w + 2 * PAGE_GAP)));

  function forgetImages(): void {
    drawn.clear();
  }

  function reset(): void {
    if (docId) Documents.closePdf(docId);
    docId = "";
    docKey.set("");
    forgetImages();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    status.set("loading");
    sizes.set([]);
    currentPage.set(1);
    pageInput.set("1");
    anchor = null;
    offset = 0;
    shownZoom = 0;
    host.onReset();
  }

  // A new source opens a new document.
  effect(() => {
    const source = host.source();
    const gen = ++docGen;
    untracked(reset);
    if (!source) return;
    const id = `pdf-viewer-${++opened}`;
    Documents.openPdf(id, source.url, source.token).then(
      (flat) => {
        if (gen !== docGen) {
          Documents.closePdf(id);
          return;
        }
        docId = id;
        const list: Size[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) list.push({ width: flat[i]! * PDF_TO_CSS_UNITS, height: flat[i + 1]! * PDF_TO_CSS_UNITS });
        if (list.length === 0) {
          Documents.closePdf(id);
          docId = "";
          status.set("broken");
          return;
        }
        sizes.set(list);
        docKey.set(id);
        status.set("ready");
      },
      (error: unknown) => {
        if (gen !== docGen) return;
        status.set(String(error).includes("not a readable PDF") ? "broken" : "failed");
      },
    );
  });
  cleanup(() => {
    docGen += 1;
    if (docId) Documents.closePdf(docId);
    if (settleTimer) clearTimeout(settleTimer);
  });

  function scrollTo(y: number): void {
    offset = Math.max(0, y);
    listRef?.scrollToOffset({ offset, animated: false });
  }

  function restoreAnchor(l: PageLayout): void {
    const at = anchor;
    if (!at) return;
    const i = at.page - 1;
    if (i < 0 || i >= l.tops.length) return;
    scrollTo(l.tops[i]! + at.frac * l.heights[i]!);
  }

  // A new zoom keeps the page and the spot that were on screen where they were, and re-renders once it settles.
  effect(() => {
    const z = zoom();
    const l = layout();
    if (status() !== "ready") return;
    untracked(() => {
      const changed = shownZoom !== 0 && z !== shownZoom;
      if (changed) restoreAnchor(l);
      if (shownZoom === 0 || !changed) {
        if (shownZoom === 0) renderZoom.set(z);
      } else {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          renderZoom.set(z);
        }, ZOOM_SETTLE_MS);
      }
      shownZoom = z;
    });
  });

  /** The list's scroll: which page is current, and the spot a zoom keeps. */
  function onScroll(e: { offset: { y: number }; size: { height: number }; contentSize: { height: number } }): void {
    const l = layout();
    if (l.tops.length === 0) return;
    offset = e.offset.y;
    const viewport = e.size.height;
    let page = currentPageAt(l, offset, viewport);
    // At the very bottom the last page is the current one, however little of it shows.
    if (e.contentSize.height > viewport + 1 && offset >= e.contentSize.height - viewport - 1) page = numPages();
    if (page !== currentPage()) {
      currentPage.set(page);
      if (!pageInputFocused) pageInput.set(String(page));
    }
    const i = page - 1;
    anchor = { page, frac: (offset - l.tops[i]!) / Math.max(1, l.heights[i]!) };
  }

  function jumpTo(page: number): void {
    const l = layout();
    if (l.tops.length === 0) return;
    const n = Math.min(Math.max(1, page), numPages());
    scrollTo(scrollTopForPage(l, n));
    currentPage.set(n);
    pageInput.set(String(n));
    anchor = { page: n, frac: -PAGE_GAP / Math.max(1, l.heights[n - 1]!) };
  }

  function commitPageInput(): void {
    const n = parsePageNumber(pageInput(), numPages());
    if (n === null) pageInput.set(String(currentPage()));
    else jumpTo(n);
  }

  function setZoom(next: number): void {
    zoomMode.set({ kind: "scale", value: clampZoom(next) });
  }

  function onZoomMenu(value: string): void {
    const mode = parseZoomMenuValue(value);
    if (mode) zoomMode.set(mode);
  }

  /**
   * Page `n` as an image `width` CSS px wide at the settled zoom: rendered once per width and kept
   * while it is near the page on screen; the pixels and page count are bounded as in the messenger.
   */
  function pageImage(n: number): string {
    const id = docKey();
    if (!id || n < 1 || n > numPages()) return "";
    const size = sizes()[n - 1]!;
    const z = renderZoom();
    const cssWidth = Math.max(1, Math.floor(size.width * z));
    const cssHeight = Math.max(1, Math.floor(size.height * z));
    const px = Math.max(1, Math.floor(cssWidth * outputScaleFor(cssWidth, cssHeight, pixelRatio())));
    const had = drawn.get(n);
    if (had && had.px === px) {
      had.lastUsed = ++useClock;
      return had.uri;
    }
    let uri = "";
    try {
      uri = Documents.renderPdfPage(id, n - 1, px);
    } catch {
      return "";
    }
    drawn.set(n, { px, uri, pixels: px * Math.round((px * size.height) / Math.max(1, size.width)), lastUsed: ++useClock });
    const near = new Set<number>();
    const at = untracked(currentPage);
    for (let k = at - 2; k <= at + 3; k += 1) near.add(k);
    near.add(n);
    const rows = [...drawn.entries()].map(([page, d]) => ({ page, pixels: d.pixels, lastUsed: d.lastUsed }));
    for (const page of pickEvictions(rows, near)) drawn.delete(page);
    return uri;
  }

  return {
    status,
    sizes,
    zoomMode,
    box,
    currentPage,
    pageInput,
    renderZoom,
    docKey,
    numPages,
    pageNumbers,
    zoom,
    layout,
    contentWidth,
    onScroll,
    jumpTo,
    commitPageInput,
    setZoom,
    onZoomMenu,
    pageImage,
    setListRef: (ref: ListRef | null) => {
      listRef = ref;
    },
    /** The page-number box has the focus: scrolling leaves what is typed alone. */
    setPageInputFocused: (on: boolean) => {
      pageInputFocused = on;
    },
    scrollTo,
    scrollOffset: () => offset,
    /** Remember where the reader is after a jump the viewer made itself (reveal). */
    anchorAt: (y: number) => {
      onScroll({ offset: { y }, size: { height: box().height }, contentSize: { height: layout().total } });
    },
  };
}
