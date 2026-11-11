/**
 * PDF preview with annotations (`PdfViewer.svelte`). The Svelte draws pages with pdf.js; here the
 * app's native module (`Documents`, hayro) renders each page to an image at the width it is shown,
 * in a virtualised `List` (state in `pdf-pages.ts`). Continuous scroll, zoom (fit width / fit page /
 * percent / ±, ⌘+ ⌘− ⌘0, ⌘/Ctrl + wheel and trackpad pinch through `platform/wheel`), jumping to a
 * page, annotations: in annotate mode a drag on a page makes a box (a press is a small one); the
 * box awaiting its remark moves, resizes by its corners and nudges with the arrow keys, Escape
 * cancels; existing annotations are numbered in order on their own pages, three looks by state,
 * dashed when stale; a row that is not drawn (file gone, page gone) is left out.
 *
 * Find (⌘F, the toolbar's button, Enter / Shift+Enter, the count, matches boxed on the pages and the
 * current one scrolled to; Escape closes the bar first), the password form of an encrypted file,
 * links (a web address opens outside the app, an inside link jumps to its page), the dimming of the
 * pages in the dark theme, and an anchor's `quote` and a draft's `crop` come from the native module
 * reading the file back (`Documents`, see `pdf-text.ts`).
 *
 * Differences from the Svelte, all from what the native module cannot do yet: no selectable text
 * layer (NSH cannot select text over an image), so the quote is the text of the glyphs inside the
 * box that was drawn, not of a selection, and find opens with its last query, not with the selected
 * text; a crop that does not fit in a megabyte as PNG is made smaller, never JPEG (the module has no
 * JPEG encoder); the horizontal scroll to a match is the page's, not the match's. The viewer is
 * given a `source` (URL and token, or bytes) in place of the file's bytes, because the module
 * fetches the file itself.
 */
import type { Annotation, PdfRegionAnchor } from "@real-bot/protocol";
import { Image, keymap, List, openUrl, Scroll, signal, Text, untracked, View, cleanup, computed, effect, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { anchorFromBox, boxOfAnchor, nudgeBox, pdfMarks, quoteInBox, scrollTopForPoint, zoomIn, zoomOut, type PdfMark } from "../../m/annotations/pdf-region.ts";
import type { EncodedCrop, NormBox } from "../../m/annotations/region-box.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { onWheel } from "../../platform/wheel";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { createPdfFind, type PdfFind } from "./pdf-find";
import { createPdfGestures } from "./pdf-gestures";
import { createPdfPages, type PdfSource } from "./pdf-pages";
import { LINK_SCHEMES, type PdfLink } from "./pdf-text";
import { PdfPageMarks } from "./PdfPageMarks";
import { PdfToolbar } from "./PdfToolbar";

export type { PdfSource };

/** Everything this viewer says; the preview passes it in from `copy.ts` (`stream.annotPdf`). */
export type PdfViewerLabels = {
  /** While the file is read. */
  loading: string;
  /** The file could not be opened for a reason other than the next. */
  failed: string;
  /** The file is not a readable PDF. */
  broken: string;
  password: string;
  passwordWrong: string;
  passwordField: string;
  passwordOpen: string;
  zoomIn: string;
  zoomOut: string;
  /** The zoom menu's name, for a screen reader. */
  zoom: string;
  fitWidth: string;
  fitPage: string;
  /** The page-number box's name. */
  pageNumber: string;
  /** After the page-number box: how many pages there are. */
  pageCount: (total: number) => string;
  find: string;
  findPlaceholder: string;
  findPrev: string;
  findNext: string;
  findClose: string;
  findCount: (current: number, total: number) => string;
  findNone: string;
  findSearching: string;
  goTo: string;
  /** Hover text on a page while annotate mode is on. */
  region: string;
  /** A drawn annotation's badge, for a screen reader: its number and its remark. */
  mark: (n: number, remark: string) => string;
  /** Hover text on the box waiting for its remark. */
  pending: string;
  /** Hover text on that box's corner handles. */
  resize: string;
  /** Added under the remark on a mark whose file has changed since. */
  stale: string;
};

/** What a finished pick hands the preview: the anchor and how to cut its crop when the remark is saved. */
export type PdfRegionDraft = { anchor: PdfRegionAnchor; crop?: () => Promise<EncodedCrop | null> };

/** What the preview can ask of the viewer (the Svelte's exported functions). */
export type PdfViewerHandle = {
  /** Escape, innermost first: a drag in progress, then the box being chosen. True when it was used here, so the pane does not close. */
  handleEscape: () => boolean;
  /** Scroll to one annotation and flash it. Does nothing for a row that is not drawn. */
  revealAnnotation: (id: string) => void;
  /** Open the find bar (⌘F) and put the cursor in it. */
  openFind: () => void;
  /** Close the find bar; false when it was not open, so Escape goes on to the pane. */
  closeFind: () => boolean;
  isFindOpen: () => boolean;
  /** The crop for an anchor: its page at twice its size, the box cut out with a 10% margin. */
  cropAnchor: (anchor: PdfRegionAnchor) => Promise<EncodedCrop | null>;
};

const FLASH_MS = 1400;
const PEEK_SHOW_MS = 3000;

export function PdfViewer(props: {
  /** Where the PDF is fetched from. A new one opens a new document. */
  source: PdfSource | null;
  /** Dark keeps the pages a little dimmed on a dark gutter. */
  theme: "light" | "dark";
  /** Defaults to the app's `stream.annotPdf`. */
  labels?: PdfViewerLabels;
  /** This file's pdf_region rows, in display order: drawn numbered 1..n. */
  annotations: Annotation[];
  /** Scroll to this one and flash it. */
  focusId: string | null;
  /** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
  focusSeq?: number;
  /** Annotate mode: a drag or a press on a page makes a box. */
  active: boolean;
  /** Whether a new box may be made at all; existing ones are drawn either way. */
  enabled: boolean;
  /** A box was chosen; the preview opens the composer. */
  onDraft: (draft: PdfRegionDraft) => void;
  /** A press on an existing mark. */
  onPick: (id: string) => void;
  /** The anchor awaiting its remark: drawn with handles, movable and resizable. */
  pending?: PdfRegionAnchor | null;
  onPendingChange?: (anchor: PdfRegionAnchor) => void;
  /** Escape while choosing, or with a box pending. */
  onCancel?: () => void;
  /** Gives the preview the viewer's imperative functions. */
  onHandle?: (handle: PdfViewerHandle) => void;
  testID?: string;
}) {
  const labels = (): PdfViewerLabels => props.labels ?? copy().stream.annotPdf;
  const localPending = signal<{ page: number; box: NormBox } | null>(null);
  const flashId = signal<string | null>(null);
  const peekId = signal<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let peekTimer: ReturnType<typeof setTimeout> | null = null;
  let revealedId: string | null = null;
  /** The request `revealedId` answered: the same id asked for again is revealed again. */
  let revealedSeq = 0;
  let areaRef: ViewRef | null = null;

  const choosing = () => props.active && props.enabled && !props.pending;

  /** The draft handed over last, and where its box is now: its crop follows the box however it moved. */
  let draftRef: { anchor: PdfRegionAnchor } | null = null;
  let find: PdfFind | null = null;

  /** The text under a box on page `n`, in reading order; "" when there is none. */
  function quoteFor(n: number, region: NormBox): string {
    try {
      return quoteInBox(pages.text.textOf(n).runs, region);
    } catch {
      return "";
    }
  }

  /** The crop for an anchor: its page drawn at 2×, the box cut out with a 10% margin. */
  async function cropAnchor(target: PdfRegionAnchor): Promise<EncodedCrop | null> {
    return pages.text.crop(target.page, boxOfAnchor(target));
  }

  const gestures = createPdfGestures({
    choosing,
    drawnSize: (n) => {
      const l = pages.layout();
      return l.widths[n - 1] === undefined ? undefined : { width: l.widths[n - 1]!, height: l.heights[n - 1]! };
    },
    pageSize: (n) => pages.sizes()[n - 1],
    onDraft: (n, region) => {
      // The quote is the text of the glyphs under the box.
      const anchor = anchorFromBox(n, region, quoteFor(n, region));
      if (!anchor) return;
      const ref = { anchor };
      draftRef = ref;
      const key = pages.docKey();
      // The crop reads the box as it is when the remark is saved, after any moving; nothing once another file is open.
      props.onDraft({ anchor, crop: () => (pages.docKey() === key ? cropAnchor(props.pending ?? ref.anchor) : Promise.resolve(null)) });
    },
    onPendingChange: (n, region) => {
      localPending.set({ page: n, box: region });
      const next = anchorFromBox(n, region, quoteFor(n, region));
      if (!next) return;
      if (draftRef) draftRef.anchor = next;
      props.onPendingChange?.(next);
    },
  });

  const pages = createPdfPages({
    source: () => props.source,
    onReset: () => {
      find?.reset();
      draftRef = null;
      gestures.abort();
      localPending.set(null);
      revealedId = null;
    },
  });

  const findBar = createPdfFind({ pages, labels });
  find = findBar;

  const marks = computed(() => pdfMarks(props.annotations, pages.numPages()));
  const marksByPage = computed(() => {
    const byPage = new Map<number, PdfMark[]>();
    for (const mark of marks()) {
      const list = byPage.get(mark.page);
      if (list) list.push(mark);
      else byPage.set(mark.page, [mark]);
    }
    return byPage;
  });
  const pendingShown = (): { page: number; box: NormBox } | null => {
    const g = gestures.live();
    if (g && (g.kind === "move" || g.kind === "resize")) return { page: g.page, box: g.box };
    const local = localPending();
    if (local) return local;
    return props.pending ? { page: props.pending.page, box: boxOfAnchor(props.pending) } : null;
  };

  /** Scroll to one annotation and flash it. Does nothing for a row that is not drawn. */
  function revealAnnotation(id: string): void {
    const mark = marks().find((m) => m.id === id);
    if (!mark) return;
    const l = pages.layout();
    const i = mark.page - 1;
    const top = l.tops[i]! + mark.box.y * l.heights[i]!;
    const bottom = top + mark.box.h * l.heights[i]!;
    const viewport = pages.box().height;
    const offset = pages.scrollOffset();
    if (top < offset || bottom > offset + viewport) pages.scrollTo(scrollTopForPoint(l, mark.page, mark.box.y, viewport));
    // Read the new spot now, not on the scroll event.
    pages.anchorAt(pages.scrollOffset());
    flashId.set(id);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashId.set(null), FLASH_MS);
  }

  // The preview took the new anchor: stop drawing our own copy of it.
  effect(() => {
    void props.pending;
    untracked(() => localPending.set(null));
  });

  // Annotate mode went off (or a box became pending) with a new box still being dragged out: nothing to hand over.
  effect(() => {
    if (choosing()) return;
    untracked(() => {
      if (gestures.live()?.kind === "new") gestures.abort();
    });
  });

  effect(() => {
    const id = props.focusId;
    const seq = props.focusSeq ?? 0;
    const ready = pages.status() === "ready" && pages.sizes().length > 0;
    // Waits for the row too: the focus can arrive before the rows that hold it, and a focus spent
    // on nothing would never scroll once they came.
    const drawnMark = id ? marks().some((m) => m.id === id) : false;
    if (!id) {
      revealedId = null;
      return;
    }
    if (!ready || !drawnMark || (id === revealedId && seq === revealedSeq)) return;
    revealedId = id;
    revealedSeq = seq;
    untracked(() => revealAnnotation(id));
  });

  // ── Keys ─────────────────────────────────────────────────────────────────────────────────────

  /** Escape for the annotation half: a drag in progress, then the box pending or being chosen. */
  function escapeAnnotation(): boolean {
    if (gestures.active()) {
      gestures.abort();
      return true;
    }
    if ((props.pending || localPending() || choosing()) && props.onCancel) {
      localPending.set(null);
      props.onCancel();
      return true;
    }
    return false;
  }

  /** Escape, innermost first: the find bar, a drag in progress, then the box being chosen. True when used here, so the pane does not close. */
  function handleEscape(): boolean {
    return findBar.closeFind() || escapeAnnotation();
  }

  props.onHandle?.({
    handleEscape,
    revealAnnotation,
    openFind: findBar.openFind,
    closeFind: findBar.closeFind,
    isFindOpen: findBar.isFindOpen,
    cropAnchor,
  });

  /** The find bar open, choosing a spot, or a box waiting for its remark: Escape is ours wherever focus is. */
  const engaged = () => findBar.open() || choosing() || props.pending != null || localPending() !== null || gestures.live() !== null;
  effect(() => {
    if (!engaged()) return;
    return keymap.bind("escape", () => void handleEscape(), { when: "always" });
  });

  // ⌘F ⌘+ ⌘− ⌘0 while a document is shown.
  effect(() => {
    if (pages.status() !== "ready") return;
    return keymap.bind(
      {
        "mod+plus": () => pages.setZoom(zoomIn(pages.zoom())),
        "mod+minus": () => pages.setZoom(zoomOut(pages.zoom())),
        "mod+0": () => pages.zoomMode.set({ kind: "fit-width" }),
        "mod+f": () => findBar.openFind(),
      },
      { when: "always" },
    );
  });

  const hasPending = computed(() => pendingShown() !== null);
  // The arrow keys move the box awaiting its remark by 1% of the page; with Shift they resize it.
  effect(() => {
    if (!hasPending()) return;
    const nudge = (key: string, shift: boolean) => () => {
      const at = pendingShown();
      const next = at ? nudgeBox(at.box, key, shift) : null;
      if (at && next) {
        localPending.set({ page: at.page, box: next });
        const anchor = anchorFromBox(at.page, next);
        if (anchor) props.onPendingChange?.(anchor);
      }
    };
    return keymap.bind({
      left: nudge("ArrowLeft", false),
      right: nudge("ArrowRight", false),
      up: nudge("ArrowUp", false),
      down: nudge("ArrowDown", false),
      "shift+left": nudge("ArrowLeft", true),
      "shift+right": nudge("ArrowRight", true),
      "shift+up": nudge("ArrowUp", true),
      "shift+down": nudge("ArrowDown", true),
    });
  });

  // ⌘/Ctrl + wheel zooms the pages (a trackpad pinch is the same with its own scale); a plain wheel scrolls the list.
  onWheel(
    () => areaRef,
    (e) => {
      if (!(e.ctrl || e.meta) || pages.status() !== "ready") return;
      const factor = e.pinch ? Math.exp(-e.dy / 100) : Math.exp(-e.dy / 300);
      const next = Math.round(pages.zoom() * factor * 100) / 100;
      if (next !== pages.zoom()) pages.setZoom(next);
    },
  );

  cleanup(() => {
    if (flashTimer) clearTimeout(flashTimer);
    if (peekTimer) clearTimeout(peekTimer);
  });

  /** A press on a link: a web address opens outside the app (http, https and mailto only), an inside link jumps to its page. */
  function followLink(link: PdfLink): void {
    if (link.url) {
      if (LINK_SCHEMES.test(link.url.trim())) void openUrl(link.url.trim()).catch(() => undefined);
    } else if (link.page) pages.jumpTo(link.page);
  }

  function peek(id: string): void {
    peekId.set(id);
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = setTimeout(() => peekId.set(null), PEEK_SHOW_MS);
  }

  return (
    <View testID={props.testID ?? "pdf-viewer"} class="flex-1 w-full min-h-[280px] border border-line rounded-(--radius-md) bg-bg overflow-hidden">
      <If when={pages.status() === "ready"}>
        <PdfToolbar labels={labels()} pages={pages} find={findBar} />
      </If>
      <View
        testID="pdf-scroll"
        class="flex-1 min-h-0"
        ref={(node: ViewRef) => {
          areaRef = node;
        }}
        onLayout={(e) => {
          const size = e.bounds.size;
          if (size.width !== pages.box().width || size.height !== pages.box().height) pages.box.set({ width: size.width, height: size.height });
        }}
      >
        <If when={pages.status() === "loading"}>
          <Text testID="pdf-status" class="py-6 px-4 text-center text-[13px] text-ink-muted">{labels().loading}</Text>
        </If>
        <If when={pages.status() === "password"}>
          <View testID="pdf-password" class="items-center gap-2 pt-6 px-4">
            <Text testID="pdf-password-status" role={pages.passwordWrong() ? "alert" : "text"} class={`text-center text-[13px] ${pages.passwordWrong() ? "text-danger-text" : "text-ink-muted"}`}>
              {pages.passwordWrong() ? labels().passwordWrong : labels().password}
            </Text>
            <View class="flex-row items-center gap-1">
              <Input
                testID="pdf-password-input"
                autoFocus
                masked
                autoComplete="off"
                accessibilityLabel={labels().passwordField}
                placeholder={labels().passwordField}
                submitBehavior="submit"
                value={pages.password()}
                onChange={(e) => {
                  if (e.value !== pages.password()) pages.password.set(e.value);
                }}
                onSubmit={() => pages.sendPassword()}
                class={`w-[200px] px-[6px] border border-line rounded-(--radius-sm) bg-input-bg text-ink text-[12px] focus:border-field-focus-border ${narrowWindow() ? "h-[40px]" : "h-[26px]"}`}
              />
              <Button testID="pdf-password-open" size={narrowWindow() ? "lg" : "sm"} variant="secondary" disabled={!pages.password()} onPress={() => pages.sendPassword()}>
                {labels().passwordOpen}
              </Button>
            </View>
          </View>
        </If>
        <If when={pages.status() === "broken" || pages.status() === "failed"}>
          <Text testID="pdf-error" role="alert" class="py-6 px-4 text-center text-[13px] text-danger-text">
            {pages.status() === "broken" ? labels().broken : labels().failed}
          </Text>
        </If>
        <If when={pages.status() === "ready"}>
          <Scroll horizontal testID="pdf-hscroll" class="flex-1">
            <List
              testID="pdf-pages"
              ref={pages.setListRef}
              each={pages.pageNumbers()}
              keyExtractor={(n: number) => `${pages.docKey()}:${n}`}
              estimatedItemSize={Math.max(100, Math.round(pages.layout().heights[0] ?? 800))}
              onScroll={pages.onScroll}
              contentClass="p-3 gap-3 items-center"
              style={{ width: pages.contentWidth(), height: pages.box().height }}
            >
              {(n: () => number) => (
                <View
                  testID={`pdf-page-${n()}`}
                  style={{
                    width: pages.layout().widths[n() - 1] ?? 0,
                    height: pages.layout().heights[n() - 1] ?? 0,
                    backgroundColor: "#ffffff",
                    boxShadow: shadow("md"),
                  }}
                >
                  <Image
                    src={pages.pageImage(n())}
                    accessible={false}
                    style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
                  />
                  <If when={props.theme === "dark"}>
                    {/* brightness(0.92), as the Svelte dims the page canvas: 8% black over the page. */}
                    <View testID="pdf-dim" accessible={false} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.08)", pointerEvents: "none" }} />
                  </If>
                  <PdfPageMarks
                    n={n()}
                    labels={labels()}
                    choosing={choosing()}
                    marks={marksByPage().get(n()) ?? []}
                    flashId={flashId()}
                    peekId={peekId()}
                    gesture={gestures.live()}
                    pendingShown={pendingShown()}
                    gestures={gestures}
                    onBadgePress={(id) => {
                      peekId.set(null);
                      props.onPick(id);
                    }}
                    onBadgePeek={peek}
                    finds={findBar.boxes().get(n()) ?? []}
                    links={pages.text.linksOf(n())}
                    onLink={followLink}
                  />
                </View>
              )}
            </List>
          </Scroll>
        </If>
      </View>
    </View>
  );
}
