import { untrack } from "svelte";
import {
  PAGE_GAP,
  PDF_TO_CSS_UNITS,
  clampZoom,
  currentPageAt,
  fitBasis,
  outputScaleFor,
  pageLayout,
  pageTextIndex,
  parsePageNumber,
  parseZoomMenuValue,
  pickEvictions,
  renderOrder,
  resolveZoom,
  scrollTopForPage,
  type PageLayout,
  type PageText,
  type PdfLinkTarget,
  type ZoomMode,
} from "../annotations/pdf-region.ts";
import { openPdf, PdfOpenError, type PdfDocument, type PdfPageSize, type PdfTask, type PdfTextLayer } from "./pdfjs.ts";

/** Rendering waits this long after a zoom, so a pinch does not draw every step of the way. */
const ZOOM_SETTLE_MS = 120;

type Status = "loading" | "password" | "ready" | "broken" | "failed";
/** One drawn page: its canvas and text layer, at which zoom, and when it was last on screen. */
type Drawn = {
  page: number;
  zoom: number;
  pixels: number;
  lastUsed: number;
  canvas: HTMLCanvasElement | null;
  text: PdfTextLayer | null;
  textZoom: number;
  failedZoom: number | null;
};

/** What the viewer hands the pages: each is read where it was read before, so effects track the same signals. */
export interface PdfPagesHost {
  /** The PDF's bytes. A new blob opens a new document. */
  data: () => Blob;
  scroller: () => HTMLDivElement | undefined;
  /** A page's text layer is in place: the find highlights go into it. */
  onTextReady: (n: number) => void;
  /** The document was let go of: whatever the viewer holds for it goes too. */
  onReset: () => void;
}

/** The document on screen: opening it, laying its pages out, zooming and scrolling, and drawing the ones in view. */
export class PdfPages {
  readonly #h: PdfPagesHost;

  status = $state<Status>("loading");
  passwordWrong = $state(false);
  password = $state("");
  submitPassword: ((value: string) => void) | null = null;
  doc: PdfDocument | null = null;
  /** Bumped per opened document: late answers from the previous one are dropped. */
  docGen = 0;
  numPages = $state(0);
  sizes = $state.raw<PdfPageSize[]>([]);
  zoomMode = $state.raw<ZoomMode>({ kind: "fit-width" });
  box = $state.raw({ width: 0, height: 0 });
  currentPage = $state(1);
  pageInput = $state("1");
  pageInputFocused = false;
  links = $state.raw<Record<number, PdfLinkTarget[]>>({});
  /** Where the reader is, so a zoom keeps the same spot on screen. */
  anchor: { page: number; frac: number; xFrac: number } | null = null;
  drawn = new Map<number, Drawn>();
  near = new Set<number>();
  pageTexts = new Map<number, Promise<PageText>>();
  /** Text-layer spans that carry find highlights, per page, to put back. */
  painted = new Map<number, Set<number>>();
  useClock = 0;
  pumping = false;
  pumpAgain = false;
  pumpTimer: ReturnType<typeof setTimeout> | null = null;
  inflight: { page: number; zoom: number; task: PdfTask; cancelled: boolean } | null = null;
  shownZoom = 0;
  /** The layout the scroll position was last read against; a new one (zoom, measured pages) re-anchors it. */
  shownLayout: PageLayout | null = null;
  pageNumbers = $derived(Array.from({ length: this.numPages }, (_, i) => i + 1));
  basis = $derived(fitBasis(this.sizes));
  zoom = $derived.by(() => {
    if (!this.basis) return 1;
    // Nothing to fit into before the scroller is measured (and never in a test document).
    if (this.zoomMode.kind !== "scale" && this.box.width <= 0) return 1;
    return resolveZoom(this.zoomMode, this.basis, this.box);
  });
  layout = $derived(pageLayout(this.sizes, this.zoom));

  constructor(host: PdfPagesHost) {
    this.#h = host;

    $effect(() => {
      const blob = this.#h.data();
      const gen = ++this.docGen;
      untrack(() => this.resetDocument());
      const opened = openPdf(blob, {
        onPassword: (submit, wrong) => {
          if (gen !== this.docGen) return;
          this.submitPassword = submit;
          this.passwordWrong = wrong;
          this.password = "";
          this.status = "password";
        },
      });
      opened.promise
        .then(async (next) => {
          if (gen !== this.docGen) {
            next.destroy();
            return;
          }
          this.doc = next;
          const first = await next.page(1);
          if (gen !== this.docGen) return;
          this.sizes = Array.from({ length: next.numPages }, () => first.size);
          this.numPages = next.numPages;
          this.status = "ready";
          void this.measurePages(next, gen);
        })
        .catch((error: unknown) => {
          if (gen !== this.docGen) return;
          if (error instanceof PdfOpenError && error.kind === "cancelled") return;
          this.status = error instanceof PdfOpenError && error.kind === "broken" ? "broken" : "failed";
        });
      return () => {
        opened.cancel();
        untrack(() => this.resetDocument());
      };
    });

    $effect(() => {
      const el = this.#h.scroller();
      if (!el) return;
      const measure = () => {
        if (el.clientWidth !== this.box.width || el.clientHeight !== this.box.height) this.box = { width: el.clientWidth, height: el.clientHeight };
      };
      measure();
      if (typeof ResizeObserver !== "function") return;
      // Measured on the next frame, not inside the observer's callback: a fit-width zoom resizes
      // the pages, which can bring in a scrollbar and resize the scroller again in the same frame
      // ("ResizeObserver loop completed with undelivered notifications"). `scrollbar-gutter` in the
      // stylesheet keeps that from flip-flopping where it is supported.
      let frame = 0;
      const observer = new ResizeObserver(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      });
      observer.observe(el);
      return () => {
        observer.disconnect();
        if (frame) cancelAnimationFrame(frame);
      };
    });

    /**
     * Pinch on a trackpad zooms the pages, not the app: Chromium and Firefox send it as Ctrl +
     * wheel (as is Ctrl/⌘ + a mouse wheel), WebKit — the desktop window — as `gesture*` events
     * carrying a scale since the pinch began.
     */
    $effect(() => {
      const el = this.#h.scroller();
      if (!el) return;
      let pendingFactor = 1;
      let frame = 0;
      /** The zoom a WebKit pinch started from, 0 when none is under way. */
      let pinchBase = 0;
      let pinchTo = 0;
      const apply = (next: number) => {
        const value = clampZoom(Math.round(next * 100) / 100);
        if (value !== this.zoom) this.zoomMode = { kind: "scale", value };
      };
      const onWheel = (ev: WheelEvent) => {
        if (!(ev.ctrlKey || ev.metaKey) || this.status !== "ready") return;
        ev.preventDefault();
        // A WebKit pinch may send both; its gesture events already carry the zoom.
        if (pinchBase) return;
        pendingFactor *= Math.exp(-ev.deltaY / 300);
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const factor = pendingFactor;
          pendingFactor = 1;
          apply(this.zoom * factor);
        });
      };
      const onPinchStart = (ev: Event) => {
        if (this.status !== "ready") return;
        ev.preventDefault();
        pinchBase = this.zoom;
      };
      const onPinchChange = (ev: Event) => {
        if (!pinchBase) return;
        ev.preventDefault();
        const scale = (ev as Event & { scale?: unknown }).scale;
        if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return;
        pinchTo = pinchBase * scale;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (pinchTo) apply(pinchTo);
        });
      };
      const onPinchEnd = (ev: Event) => {
        if (!pinchBase) return;
        ev.preventDefault();
        if (pinchTo) apply(pinchTo);
        pinchBase = 0;
        pinchTo = 0;
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      el.addEventListener("gesturestart", onPinchStart, { passive: false });
      el.addEventListener("gesturechange", onPinchChange, { passive: false });
      el.addEventListener("gestureend", onPinchEnd, { passive: false });
      return () => {
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("gesturestart", onPinchStart);
        el.removeEventListener("gesturechange", onPinchChange);
        el.removeEventListener("gestureend", onPinchEnd);
        if (frame) cancelAnimationFrame(frame);
      };
    });

    $effect(() => {
      const z = this.zoom;
      const l = this.layout;
      if (this.status !== "ready") return;
      untrack(() => {
        const changed = this.shownZoom !== 0 && z !== this.shownZoom;
        // Any new layout — a zoom, or pages measured after the first one's size was assumed for
        // them — keeps the page and spot that were on screen where they were.
        if (this.shownLayout !== null && l !== this.shownLayout && this.#h.scroller()) this.restoreAnchor(this.#h.scroller()!, l);
        this.shownLayout = l;
        this.shownZoom = z;
        if (changed && this.inflight && this.inflight.zoom !== z) {
          this.inflight.cancelled = true;
          this.inflight.task.cancel();
        }
        this.schedulePump(changed ? ZOOM_SETTLE_MS : 0);
      });
    });

    $effect(() => {
      const root = this.#h.scroller();
      const count = this.numPages;
      if (!root || count === 0 || this.status !== "ready") return;
      // Before (or without) the observer's first report: the pages around the current one.
      untrack(() => {
        for (let n = Math.max(1, this.currentPage - 1); n <= Math.min(count, this.currentPage + 2); n += 1) this.near.add(n);
      });
      let observer: IntersectionObserver | null = null;
      if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const n = Number((entry.target as HTMLElement).dataset.page);
              if (!Number.isInteger(n)) continue;
              if (entry.isIntersecting) {
                this.near.add(n);
                const d = this.drawn.get(n);
                if (d) d.lastUsed = ++this.useClock;
              } else this.near.delete(n);
            }
            this.schedulePump(0);
          },
          { root, rootMargin: "100% 0px 100% 0px" }
        );
        for (const el of root.querySelectorAll(".pdf-page")) observer.observe(el);
      }
      this.schedulePump(0);
      return () => observer?.disconnect();
    });
  }

  pageEl(n: number): HTMLElement | null {
    return this.#h.scroller()?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`) ?? null;
  }

  /** Every page's own size, in the background: pages start as the first page's size. */
  async measurePages(source: PdfDocument, gen: number): Promise<void> {
    let next = this.sizes;
    let changed = false;
    for (let n = 2; n <= source.numPages; n += 1) {
      let size: PdfPageSize;
      try {
        size = (await source.page(n)).size;
      } catch {
        continue;
      }
      if (gen !== this.docGen) return;
      const was = next[n - 1];
      if (!was || was.width !== size.width || was.height !== size.height || was.userUnit !== size.userUnit) {
        if (!changed) next = [...next];
        next[n - 1] = size;
        changed = true;
      }
      if (changed && (n % 50 === 0 || n === source.numPages)) {
        this.sizes = next;
        changed = false;
      }
    }
    if (changed && gen === this.docGen) this.sizes = next;
  }

  resetDocument(): void {
    for (const n of [...this.drawn.keys()]) this.releasePage(n);
    if (this.inflight) this.inflight.task.cancel();
    this.inflight = null;
    this.doc?.destroy();
    this.doc = null;
    this.near.clear();
    this.pageTexts.clear();
    this.painted.clear();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.submitPassword = null;
    this.status = "loading";
    this.passwordWrong = false;
    this.numPages = 0;
    this.sizes = [];
    this.links = {};
    this.currentPage = 1;
    this.pageInput = "1";
    this.anchor = null;
    this.shownZoom = 0;
    this.shownLayout = null;
    this.#h.onReset();
  }

  sendPassword = (ev: SubmitEvent): void => {
    ev.preventDefault();
    const submit = this.submitPassword;
    const typed = this.password;
    if (!submit || !typed) return;
    this.submitPassword = null;
    // Handed to pdf.js and not kept here: a wrong one asks again with an empty field.
    this.password = "";
    this.status = "loading";
    submit(typed);
  };

  restoreAnchor(el: HTMLElement, l: PageLayout): void {
    const at = this.anchor;
    if (!at) return;
    const i = at.page - 1;
    if (i < 0 || i >= l.tops.length) return;
    el.scrollTop = Math.max(0, l.tops[i]! + at.frac * l.heights[i]!);
    el.scrollLeft = Math.max(0, at.xFrac * el.scrollWidth - el.clientWidth / 2);
  }

  onScroll = (): void => {
    const el = this.#h.scroller();
    if (!el || this.layout.tops.length === 0) return;
    let page = currentPageAt(this.layout, el.scrollTop, el.clientHeight);
    // At the very bottom the last page is the current one, however little of it shows.
    if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop >= el.scrollHeight - el.clientHeight - 1) page = this.numPages;
    if (page !== this.currentPage) {
      this.currentPage = page;
      if (!this.pageInputFocused) this.pageInput = String(page);
    }
    const i = page - 1;
    this.anchor = {
      page,
      frac: (el.scrollTop - this.layout.tops[i]!) / Math.max(1, this.layout.heights[i]!),
      xFrac: (el.scrollLeft + el.clientWidth / 2) / Math.max(1, el.scrollWidth),
    };
  };

  jumpTo(page: number): void {
    const el = this.#h.scroller();
    if (!el || this.layout.tops.length === 0) return;
    const n = Math.min(Math.max(1, page), this.numPages);
    el.scrollTop = scrollTopForPage(this.layout, n);
    this.currentPage = n;
    this.pageInput = String(n);
    this.anchor = { page: n, frac: -PAGE_GAP / Math.max(1, this.layout.heights[n - 1]!), xFrac: this.anchor?.xFrac ?? 0.5 };
  }

  commitPageInput(): void {
    const n = parsePageNumber(this.pageInput, this.numPages);
    if (n === null) this.pageInput = String(this.currentPage);
    else this.jumpTo(n);
  }

  onPageKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    this.commitPageInput();
    // Typing is done: scrolling updates the box again, focused or not.
    this.pageInputFocused = false;
  };

  setZoom(next: number): void {
    this.zoomMode = { kind: "scale", value: clampZoom(next) };
  }

  onZoomMenu = (ev: Event): void => {
    const mode = parseZoomMenuValue((ev.currentTarget as HTMLSelectElement).value);
    if (mode) this.zoomMode = mode;
  };

  focusScroller(): void {
    try {
      this.#h.scroller()?.focus({ preventScroll: true });
    } catch {
      // Nothing to focus in a detached tree.
    }
  }

  schedulePump(delay: number): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    if (delay <= 0) {
      void this.pump();
      return;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.pump();
    }, delay);
  }

  /** Draw the near pages that are not drawn at this zoom, nearest first, one at a time; then let go of far ones. */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (;;) {
          const source = this.doc;
          if (!source || this.status !== "ready") break;
          const z = this.zoom;
          const next = renderOrder(this.near, this.currentPage).find((n) => {
            if (n < 1 || n > this.numPages) return false;
            const d = this.drawn.get(n);
            return !d || ((d.zoom !== z || !d.canvas) && d.failedZoom !== z);
          });
          if (next === undefined) break;
          await this.drawPage(source, next, z);
        }
        this.evictFar();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  async drawPage(source: PdfDocument, n: number, z: number): Promise<void> {
    const gen = this.docGen;
    const el = this.pageEl(n);
    if (!el) {
      this.near.delete(n);
      return;
    }
    let entry = this.drawn.get(n);
    if (!entry) {
      entry = { page: n, zoom: 0, pixels: 0, lastUsed: ++this.useClock, canvas: null, text: null, textZoom: 0, failedZoom: null };
      this.drawn.set(n, entry);
    }
    let page;
    try {
      page = await source.page(n);
    } catch {
      entry.failedZoom = z;
      return;
    }
    if (gen !== this.docGen || this.drawn.get(n) !== entry) return;
    const width = Math.max(1, Math.floor(page.size.width * z));
    const height = Math.max(1, Math.floor(page.size.height * z));
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const task = page.render(canvas, z, outputScaleFor(width, height, window.devicePixelRatio || 1));
    const flight = { page: n, zoom: z, task, cancelled: false };
    this.inflight = flight;
    try {
      await task.promise;
    } catch {
      canvas.width = 0;
      canvas.height = 0;
      if (!flight.cancelled && this.drawn.get(n) === entry) entry.failedZoom = z;
      return;
    } finally {
      if (this.inflight === flight) this.inflight = null;
    }
    if (gen !== this.docGen || this.drawn.get(n) !== entry || flight.cancelled) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    const old = entry.canvas;
    el.querySelector(".pdf-canvas")?.replaceChildren(canvas);
    if (old && old !== canvas) {
      old.width = 0;
      old.height = 0;
    }
    entry.canvas = canvas;
    entry.zoom = z;
    entry.failedZoom = null;
    entry.pixels = canvas.width * canvas.height;
    entry.lastUsed = ++this.useClock;
    const textEl = el.querySelector<HTMLElement>(".pdf-text");
    if (!entry.text && textEl) {
      textEl.replaceChildren();
      const layer = page.renderText(textEl, z);
      entry.text = layer;
      entry.textZoom = z;
      const owner = entry;
      layer.promise.then(
        () => {
          if (owner.text === layer) this.#h.onTextReady(n);
        },
        () => {}
      );
    } else if (entry.text && entry.textZoom !== z) {
      try {
        entry.text.update(z);
      } catch {
        // A layer that never finished has nothing to move.
      }
      entry.textZoom = z;
    }
    if (!(n in this.links)) {
      page.links().then(
        (found) => {
          if (gen === this.docGen && !(n in this.links)) this.links = { ...this.links, [n]: found };
        },
        () => {}
      );
    }
  }

  evictFar(): void {
    const rows = [...this.drawn.values()].filter((d) => d.canvas).map((d) => ({ page: d.page, pixels: d.pixels, lastUsed: d.lastUsed }));
    for (const n of pickEvictions(rows, this.near)) this.releasePage(n);
  }

  releasePage(n: number): void {
    const entry = this.drawn.get(n);
    if (!entry) return;
    this.drawn.delete(n);
    if (this.inflight?.page === n) {
      this.inflight.cancelled = true;
      this.inflight.task.cancel();
    }
    entry.text?.cancel();
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    this.painted.delete(n);
    const el = this.pageEl(n);
    el?.querySelector(".pdf-canvas")?.replaceChildren();
    el?.querySelector(".pdf-text")?.replaceChildren();
    this.doc?.page(n).then(
      (page) => page.release(),
      () => {}
    );
  }

  onTextDown = (ev: PointerEvent): void => {
    // pdf.js's trick: while selecting, the end-of-content block covers the page so a drag
    // through blank space does not jump the selection to the end of the layer.
    (ev.currentTarget as HTMLElement).classList.add("is-selecting");
    const done = () => {
      this.#h.scroller()?.querySelectorAll(".pdf-text.is-selecting").forEach((el) => el.classList.remove("is-selecting"));
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
    };
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  async followLink(dest: unknown): Promise<void> {
    const target = await this.doc?.destinationPage(dest);
    if (target) this.jumpTo(target);
  }

  textOf(n: number): Promise<PageText> {
    let found = this.pageTexts.get(n);
    if (!found) {
      const source = this.doc;
      if (!source) return Promise.reject(new Error("no document"));
      found = source
        .page(n)
        .then((page) => page.textItems())
        .then(pageTextIndex);
      found.catch(() => this.pageTexts.delete(n));
      this.pageTexts.set(n, found);
    }
    return found;
  }
}
