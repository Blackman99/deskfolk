import { tick } from "svelte";
import {
  FIND_MATCH_MAX,
  findInText,
  findPattern,
  firstMatchFrom,
  highlightPieces,
  matchSegments,
  scrollTopForPoint,
  stepMatch,
  type PageText,
  type PdfMatch,
} from "../annotations/pdf-region.ts";
import type { NormBox } from "../annotations/region-box.ts";
import type { PdfViewerLabels } from "./PdfViewer.svelte";
import type { PdfPages } from "./pdf-pages.svelte.ts";

/** What the viewer hands the find bar: each is read where it was read before, so effects track the same signals. */
export interface PdfFindHost {
  pages: PdfPages;
  labels: () => PdfViewerLabels;
  rootEl: () => HTMLDivElement | undefined;
  scroller: () => HTMLDivElement | undefined;
}

/** Find in the document: the bar's state, the search over every page's text, and the highlights painted into the text layers. */
export class PdfFind {
  readonly #h: PdfFindHost;
  readonly #pages: PdfPages;

  findInput = $state<HTMLInputElement | undefined>(undefined);
  findOpen = $state(false);
  findQuery = $state("");
  matches = $state.raw<PdfMatch[]>([]);
  matchIndex = $state(-1);
  findBusy = $state(false);
  findGen = 0;
  findTimer: ReturnType<typeof setTimeout> | null = null;
  findStatus = $derived.by(() => {
    if (!this.findQuery.trim()) return "";
    if (this.matches.length > 0) return this.#h.labels().findCount(Math.max(0, this.matchIndex) + 1, this.matches.length);
    return this.findBusy ? this.#h.labels().findSearching : this.#h.labels().findNone;
  });

  constructor(host: PdfFindHost) {
    this.#h = host;
    this.#pages = host.pages;
  }

  /** The document was let go of: a find bar left open over the next file would show the last file's query with no search run. */
  reset(): void {
    this.findGen += 1;
    if (this.findTimer) clearTimeout(this.findTimer);
    this.findOpen = false;
    this.matches = [];
    this.matchIndex = -1;
    this.findBusy = false;
  }

  /** Open the find bar (⌘F), seeded with the text selected in the viewer. */
  openFind(): void {
    if (this.#pages.status !== "ready") return;
    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    const picked = selection && this.#h.rootEl() && selection.anchorNode && this.#h.rootEl()!.contains(selection.anchorNode) ? selection.toString().trim() : "";
    if (picked && !picked.includes("\n") && picked.length <= 200 && picked !== this.findQuery) {
      this.findQuery = picked;
      this.queueFind(0);
    } else if (!this.findOpen && this.findQuery.trim()) {
      // Closing dropped the matches, not the query: search it again rather than say "no match".
      this.queueFind(0);
    }
    this.findOpen = true;
    void tick().then(() => {
      this.findInput?.focus();
      this.findInput?.select();
    });
  }

  /** Close the find bar; false when it was not open (so Escape can go on to close the pane). */
  closeFind(): boolean {
    if (!this.findOpen) return false;
    this.findOpen = false;
    this.findGen += 1;
    if (this.findTimer) clearTimeout(this.findTimer);
    this.findBusy = false;
    this.matches = [];
    this.matchIndex = -1;
    this.paintAll();
    this.#pages.focusScroller();
    return true;
  }

  isFindOpen(): boolean {
    return this.findOpen;
  }

  queueFind(delay = 150): void {
    if (this.findTimer) clearTimeout(this.findTimer);
    // While the typing settles, say "searching", not "no match".
    this.findBusy = this.findQuery.trim() !== "";
    this.findTimer = setTimeout(() => {
      this.findTimer = null;
      void this.runFind(this.findQuery);
    }, delay);
  }

  async runFind(query: string): Promise<void> {
    const gen = ++this.findGen;
    const pattern = findPattern(query);
    this.matches = [];
    this.matchIndex = -1;
    this.paintAll();
    if (!pattern || !this.#pages.doc || this.#pages.status !== "ready") {
      this.findBusy = false;
      return;
    }
    this.findBusy = true;
    const start = this.#pages.currentPage;
    const found: PdfMatch[] = [];
    let chosen = false;
    const total = this.#pages.numPages;
    for (let n = 1; n <= total; n += 1) {
      let text: PageText | null = null;
      try {
        text = await this.#pages.textOf(n);
      } catch {
        text = null;
      }
      if (gen !== this.findGen) return;
      if (text) for (const m of findInText(text.text, pattern, FIND_MATCH_MAX - found.length)) found.push({ page: n, ...m });
      const full = found.length >= FIND_MATCH_MAX;
      if (n % 10 === 0 || n === total || full) {
        this.matches = [...found];
        if (!chosen && n >= start && found.some((m) => m.page >= start)) {
          chosen = true;
          this.selectMatch(firstMatchFrom(found, start));
        } else this.paintAll();
      }
      if (full) break;
    }
    if (gen !== this.findGen) return;
    if (!chosen && found.length > 0) this.selectMatch(0);
    this.findBusy = false;
  }

  selectMatch(i: number): void {
    this.matchIndex = i;
    this.paintAll();
    const m = this.matches[i];
    if (m) void this.revealMatch(m);
  }

  stepFind(direction: 1 | -1): void {
    if (this.matches.length === 0) {
      if (this.findQuery.trim()) this.queueFind(0);
      return;
    }
    this.selectMatch(stepMatch(this.matchIndex, this.matches.length, direction));
  }

  async revealMatch(m: PdfMatch): Promise<void> {
    const source = this.#pages.doc;
    const el = this.#h.scroller();
    if (!source || !el) return;
    let rect: NormBox | null = null;
    /** Where along its first run the match starts and ends, 0–1. */
    let from = 0;
    let to = 1;
    try {
      const [text, page] = await Promise.all([this.#pages.textOf(m.page), source.page(m.page)]);
      const first = matchSegments(text, m)[0];
      const runs = await page.textRuns();
      rect = first ? (runs[first.item]?.rect ?? null) : null;
      if (first) {
        const length = Math.max(1, text.lengths[first.item]!);
        from = first.start / length;
        to = first.end / length;
      }
    } catch {
      rect = null;
    }
    if (this.matches[this.matchIndex] !== m) return;
    const i = m.page - 1;
    const top = this.#pages.layout.tops[i]! + (rect?.y ?? 0) * this.#pages.layout.heights[i]!;
    const bottom = top + (rect?.h ?? 0) * this.#pages.layout.heights[i]!;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = scrollTopForPoint(this.#pages.layout, m.page, rect?.y ?? 0, el.clientHeight);
    }
    const pageNode = this.#pages.pageEl(m.page);
    if (rect && pageNode && this.#pages.layout.widths[i]! > el.clientWidth) {
      const x0 = pageNode.offsetLeft + (rect.x + rect.w * from) * this.#pages.layout.widths[i]!;
      const x1 = pageNode.offsetLeft + (rect.x + rect.w * to) * this.#pages.layout.widths[i]!;
      // The whole match in view, moving no further than that, with a little room around it.
      if (x0 < el.scrollLeft) el.scrollLeft = Math.max(0, x0 - 48);
      else if (x1 > el.scrollLeft + el.clientWidth - 24) {
        el.scrollLeft = Math.max(0, Math.min(x0 - 48, x1 - el.clientWidth + 48));
      }
    }
    this.#pages.onScroll();
  }

  paintAll(): void {
    for (const n of this.#pages.drawn.keys()) void this.paintPage(n);
  }

  /** Put the find highlights for one page into its text layer's spans, taking the old ones out. */
  async paintPage(n: number): Promise<void> {
    const entry = this.#pages.drawn.get(n);
    const layer = entry?.text;
    if (!layer) return;
    const hasOld = (this.#pages.painted.get(n)?.size ?? 0) > 0;
    const onPage = this.findOpen && this.matches.some((m) => m.page === n);
    if (!hasOld && !onPage) return;
    let index: PageText;
    try {
      index = await this.#pages.textOf(n);
    } catch {
      return;
    }
    if (this.#pages.drawn.get(n)?.text !== layer) return;
    const divs = layer.divs();
    const str = (i: number) => index.text.slice(index.starts[i]!, index.starts[i]! + index.lengths[i]!);
    for (const i of this.#pages.painted.get(n) ?? []) {
      const div = divs[i];
      if (div) div.textContent = str(i);
    }
    this.#pages.painted.delete(n);
    if (!this.findOpen) return;
    const ranges = new Map<number, Array<{ start: number; end: number; selected: boolean }>>();
    this.matches.forEach((m, mi) => {
      if (m.page !== n) return;
      for (const seg of matchSegments(index, m)) {
        const list = ranges.get(seg.item) ?? [];
        list.push({ start: seg.start, end: seg.end, selected: mi === this.matchIndex });
        ranges.set(seg.item, list);
      }
    });
    const touched = new Set<number>();
    for (const [i, list] of ranges) {
      const div = divs[i];
      if (!div) continue;
      div.replaceChildren(
        ...highlightPieces(str(i), list).map((piece) => {
          if (!piece.mark) return document.createTextNode(piece.text);
          const span = document.createElement("span");
          span.className = piece.mark === "selected" ? "pdf-hl is-selected" : "pdf-hl";
          span.textContent = piece.text;
          return span;
        })
      );
      touched.add(i);
    }
    if (touched.size) this.#pages.painted.set(n, touched);
  }

  onFindKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      this.stepFind(ev.shiftKey ? -1 : 1);
    }
  };
}
