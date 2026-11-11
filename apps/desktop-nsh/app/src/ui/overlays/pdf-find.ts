/**
 * Find in the document, for `PdfViewer` (`pdf-find.svelte.ts`): the bar's state, the search over
 * every page's text (the native module's runs through the messenger's `findPattern` /
 * `findInText`), stepping through the matches, and the boxes the viewer draws over the pages. The
 * search yields to the event loop between pages, so a long document does not freeze the window;
 * a match is revealed by scrolling its page into view (the Svelte also scrolled sideways, which the
 * viewer's single horizontal scroll area does here only through the page).
 */
import { cleanup, computed, signal } from "nsh";
import {
  FIND_MATCH_MAX,
  findInText,
  findPattern,
  firstMatchFrom,
  matchSegments,
  scrollTopForPoint,
  stepMatch,
  type PdfMatch,
} from "../../m/annotations/pdf-region.ts";
import { findBoxes, type FindBox } from "./pdf-text";
import type { PdfPages } from "./pdf-pages";
import type { PdfViewerLabels } from "./PdfViewer";

/** How long typing settles before the search runs. */
export const FIND_DEBOUNCE_MS = 150;

const nextTurn = () => new Promise<void>((done) => setTimeout(done, 0));

export function createPdfFind(host: { pages: PdfPages; labels: () => PdfViewerLabels }) {
  const pages = host.pages;
  const open = signal(false);
  const query = signal("");
  const matches = signal<PdfMatch[]>([]);
  const matchIndex = signal(-1);
  const busy = signal(false);
  /** Bumped whenever the bar is asked to open (or is open and asked again): the bar takes the focus. */
  const focusInput = signal(0);
  let gen = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const status = computed(() => {
    if (!query().trim()) return "";
    if (matches().length > 0) return host.labels().findCount(Math.max(0, matchIndex()) + 1, matches().length);
    return busy() ? host.labels().findSearching : host.labels().findNone;
  });

  /** The boxes to draw, by page. */
  const boxes = computed<Map<number, FindBox[]>>(() => (open() && matches().length > 0 ? findBoxes(matches(), matchIndex(), pages.text.textOf) : new Map()));

  function cancelTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** The document was let go of: a bar left open over the next file would show the last file's query with no search run. */
  function reset(): void {
    gen += 1;
    cancelTimer();
    open.set(false);
    matches.set([]);
    matchIndex.set(-1);
    busy.set(false);
  }

  /** Open the bar (⌘F); asks the input to take the focus. */
  function openFind(): void {
    if (pages.status() !== "ready") return;
    if (!open() && query().trim()) {
      // Closing dropped the matches, not the query: search it again rather than say "no match".
      queueFind(0);
    }
    open.set(true);
    focusInput.set(focusInput() + 1);
  }

  /** Close the bar; false when it was not open (so Escape can go on to close the pane). */
  function closeFind(): boolean {
    if (!open()) return false;
    open.set(false);
    gen += 1;
    cancelTimer();
    busy.set(false);
    matches.set([]);
    matchIndex.set(-1);
    return true;
  }

  function queueFind(delay = FIND_DEBOUNCE_MS): void {
    cancelTimer();
    // While the typing settles, say "searching", not "no match".
    busy.set(query().trim() !== "");
    timer = setTimeout(() => {
      timer = null;
      void runFind(query());
    }, delay);
  }

  async function runFind(text: string): Promise<void> {
    const mine = ++gen;
    const pattern = findPattern(text);
    matches.set([]);
    matchIndex.set(-1);
    if (!pattern || pages.status() !== "ready") {
      busy.set(false);
      return;
    }
    busy.set(true);
    const start = pages.currentPage();
    const found: PdfMatch[] = [];
    let chosen = false;
    const total = pages.numPages();
    for (let n = 1; n <= total; n += 1) {
      for (const m of findInText(pages.text.textOf(n).index.text, pattern, FIND_MATCH_MAX - found.length)) found.push({ page: n, ...m });
      const full = found.length >= FIND_MATCH_MAX;
      if (n % 10 === 0 || n === total || full) {
        matches.set([...found]);
        if (!chosen && n >= start && found.some((m) => m.page >= start)) {
          chosen = true;
          selectMatch(firstMatchFrom(found, start));
        }
      }
      if (full) break;
      await nextTurn();
      if (mine !== gen) return;
    }
    if (mine !== gen) return;
    if (!chosen && found.length > 0) selectMatch(0);
    busy.set(false);
  }

  function selectMatch(i: number): void {
    matchIndex.set(i);
    const m = matches()[i];
    if (m) revealMatch(m);
  }

  function stepFind(direction: 1 | -1): void {
    if (matches().length === 0) {
      if (query().trim()) queueFind(0);
      return;
    }
    selectMatch(stepMatch(matchIndex(), matches().length, direction));
  }

  /** Scroll the match's page so that its first line shows. */
  function revealMatch(m: PdfMatch): void {
    const text = pages.text.textOf(m.page);
    const first = matchSegments(text.index, m)[0];
    const rect = first ? text.runs[first.item]?.rect : undefined;
    const l = pages.layout();
    const i = m.page - 1;
    if (i < 0 || i >= l.tops.length) return;
    const top = l.tops[i]! + (rect?.y ?? 0) * l.heights[i]!;
    const bottom = top + (rect?.h ?? 0) * l.heights[i]!;
    const viewport = pages.box().height;
    const offset = pages.scrollOffset();
    if (top < offset || bottom > offset + viewport) pages.scrollTo(scrollTopForPoint(l, m.page, rect?.y ?? 0, viewport));
    pages.anchorAt(pages.scrollOffset());
  }

  cleanup(cancelTimer);

  return { open, query, matches, matchIndex, busy, status, boxes, focusInput, reset, openFind, closeFind, queueFind, stepFind, isFindOpen: () => open() };
}

export type PdfFind = ReturnType<typeof createPdfFind>;
