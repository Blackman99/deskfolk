/**
 * A rendered Markdown file and its annotations (`MarkdownAnnotator.svelte`). In annotate mode a
 * pick makes a `text_range` anchor in the source's lines (the Bot reads source line numbers) with
 * `view: "rendered"`; the marks already made are drawn on what they cover in three looks by state,
 * dashed when the file has changed since, each with a number (press it to open the annotation).
 *
 * Differently from the messenger: NSH's `TextView` has no DOM and no selection range to read, so
 * the file is cut into its top-level blocks (`markdown-blocks.ts`, from the source lines the
 * mirrored `markdown-lines.ts` assigns) and each is rendered by its own `MarkdownBody`. A pick is a
 * whole block (a paragraph, a heading, a list, a quote, a code block, a table): press it, then the
 * 「批注」 button under it. The anchor covers the block's lines from the first column to the end of
 * the last line, so the Bot still gets exact source lines and a quote.
 */
import { computed, effect, keymap, signal, Text, untracked, View } from "nsh";
import { validateAnchor, type Annotation, type TextRangeAnchor } from "@real-bot/protocol";
import { effectiveLines } from "../../m/annotations/model.ts";
import { normalizeSource } from "../../m/annotations/markdown-lines.ts";
import { anchorFromSelection } from "../../m/annotations/text-range.ts";
import type { EncodedCrop } from "../../m/annotations/region-box.ts";
import { MarkdownBody } from "../MarkdownBody";
import { tip } from "../tip";
import { markdownBlocks, type MarkdownBlock } from "./markdown-blocks";

/** Everything this surface says; the preview passes it in from `copy.ts`. */
export type MarkdownAnnotatorLabels = {
  /** The button that offers a picked block. */
  annotate: string;
  /** A drawn annotation's number badge for a screen reader: its number and its remark. */
  mark: (n: number, remark: string) => string;
  /** Added under the remark on a mark whose file has changed since. */
  stale: string;
};

/** What a finished pick hands the preview. Text has nothing to crop. */
export type MarkdownRangeDraft = { anchor: TextRangeAnchor; crop?: () => Promise<EncodedCrop | null> };

const FLASH_MS = 1400;

type Mark = { id: string; n: number; status: "open" | "draft" | "resolved"; stale: boolean; body: string; start: number; end: number };

const statusOf = (row: Annotation): Mark["status"] => (row.status === "draft" ? "draft" : row.status === "resolved" ? "resolved" : "open");

export function MarkdownAnnotator(props: {
  /** The Markdown file's text, exactly as on disk. */
  source: string;
  /** This file's text-range rows, in display order: drawn numbered 1..n. */
  annotations: Annotation[];
  /** Flash this one. */
  focusId: string | null;
  /** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
  focusSeq?: number;
  /** Annotate mode: a block can be picked. */
  active: boolean;
  /** Whether a new annotation may be made at all; existing ones are drawn either way. */
  enabled: boolean;
  labels: MarkdownAnnotatorLabels;
  /** A block was chosen; the preview opens the composer for its remark. */
  onDraft: (draft: MarkdownRangeDraft) => void;
  /** A press on an existing mark. */
  onPick: (id: string) => void;
  /** The anchor awaiting its remark: drawn apart from the saved ones. */
  pending?: TextRangeAnchor | null;
  /** Part of the shared adapter contract; a text range is not moved in place, so never called. */
  onPendingChange?: (anchor: TextRangeAnchor) => void;
  /** Escape while choosing, or with a range pending. */
  onCancel?: () => void;
  /** MarkdownBody's pass-throughs. */
  copyLabel: string;
  copiedLabel: string;
  onOpenArtifact?: (relpath: string) => void;
  onOpenImage?: (relpath: string) => void;
  loadArtifactImage?: (relpath: string, signal: AbortSignal) => Promise<Blob>;
  testID?: string;
}) {
  /** The block picked in annotate mode, waiting for the button. */
  const picked = signal<number | null>(null);
  const flashId = signal<string | null>(null);
  let lastFocus: string | null = null;
  let lastFocusSeq = 0;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const choosing = () => props.active && props.enabled;
  const blocks = computed(() => markdownBlocks(props.source));
  const marks = (): Mark[] => {
    const out: Mark[] = [];
    props.annotations.forEach((row, index) => {
      if (row.anchor_kind !== "text_range" || row.stale?.kind === "missing") return;
      const lines = effectiveLines(row);
      if (!lines) return;
      out.push({ id: row.id, n: index + 1, status: statusOf(row), stale: Boolean(row.stale), body: row.body, start: lines.start_line, end: lines.end_line });
    });
    return out;
  };
  const covers = (block: MarkdownBlock, start: number, end: number) => block.end >= start && block.start <= end;
  /** The marks that sit on a block, and which of them put their number there (the first block each covers). */
  const marksOn = (block: MarkdownBlock, all: Mark[]) => all.filter((m) => covers(block, m.start, m.end));
  const numberedOn = (block: MarkdownBlock, all: Mark[], blocksNow: MarkdownBlock[]) =>
    all.filter((m) => blocksNow.find((b) => covers(b, m.start, m.end)) === block);
  const isPending = (block: MarkdownBlock) => props.pending != null && covers(block, props.pending.start_line, props.pending.end_line);
  const markTitle = (m: Mark) => (m.stale ? `${m.body}\n${props.labels.stale}` : m.body);

  function annotate(block: MarkdownBlock): void {
    if (!choosing()) return;
    const text = normalizeSource(props.source);
    const last = text.split("\n")[block.end - 1] ?? "";
    const raw = anchorFromSelection(text, { startLineNumber: block.start, startColumn: 1, endLineNumber: block.end, endColumn: last.length + 1 });
    const check = validateAnchor("text_range", { ...raw, view: "rendered" });
    if (!check.ok) return;
    picked.set(null);
    props.onDraft({ anchor: check.anchor as TextRangeAnchor });
  }

  function press(block: MarkdownBlock, index: number, onBlock: Mark[]): void {
    if (choosing()) {
      picked.set(picked() === index ? null : index);
      return;
    }
    // Outside annotate mode a press on marked text opens its annotation; the later mark wins where two overlap.
    const hit = onBlock.at(-1);
    if (hit) props.onPick(hit.id);
  }

  keymap.bind(
    "escape",
    () => {
      const choosingNow = picked() !== null;
      if (!choosingNow && !props.pending) return;
      picked.set(null);
      props.onCancel?.();
    },
    { when: "always" },
  );

  // Leaving annotate mode drops the pick.
  effect(() => {
    if (!choosing()) untracked(() => picked.set(null));
  });
  // A new text: the block numbers mean something else now.
  effect(() => {
    void props.source;
    untracked(() => picked.set(null));
  });

  effect(() => {
    const id = props.focusId;
    const seq = props.focusSeq ?? 0;
    // The rows are read below, so a snapshot runs this again: only a new request flashes.
    if (id === lastFocus && seq === lastFocusSeq) return;
    if (!id) {
      lastFocus = null;
      lastFocusSeq = seq;
      return;
    }
    if (!props.annotations.some((row) => row.id === id && row.anchor_kind === "text_range")) return;
    lastFocus = id;
    lastFocusSeq = seq;
    untracked(() => {
      flashId.set(id);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flashId.set(null), FLASH_MS);
    });
  });

  return (
    <View testID={props.testID ?? "markdown-annotator"} class="min-w-0">
      <Each of={blocks()} key={(b: MarkdownBlock) => `${b.start}-${b.end}`}>
        {(block: () => MarkdownBlock, index: () => number) => {
          const on = () => marksOn(block(), marks());
          const strongest = () => on().find((m) => m.status === "open") ?? on().find((m) => m.status === "draft") ?? on().at(-1);
          const flashing = () => on().some((m) => m.id === flashId());
          const sel = () => picked() === index();
          return (
            <View class="min-w-0">
              <View
                testID={`markdown-block-${block().start}`}
                role={choosing() || on().length > 0 ? "button" : undefined}
                tooltip={on().length > 0 && !choosing() ? tip(on().map(markTitle).join("\n\n")) : undefined}
                onPress={() => press(block(), index(), on())}
                class={`${choosing() || on().length > 0 ? "cursor-pointer " : ""}min-w-0 rounded-(--radius-sm) ${
                  sel() || isPending(block()) ? "border border-dashed border-brand bg-brand/18" : "border border-transparent"
                } ${
                  !sel() && !isPending(block()) && strongest()
                    ? strongest()!.status === "resolved"
                      ? "bg-ink-muted/10"
                      : strongest()!.status === "draft"
                        ? "bg-brand/8"
                        : "bg-brand/14"
                    : ""
                } ${strongest()?.stale && !sel() ? "border-dashed border-ink-muted" : ""}`}
                style={{ boxShadow: flashing() ? "0 0 0 3px rgba(0,128,128,0.35)" : undefined }}
              >
                <MarkdownBody
                  source={block().raw}
                  copyLabel={props.copyLabel}
                  copiedLabel={props.copiedLabel}
                  selectable={!choosing()}
                  onOpenArtifact={props.onOpenArtifact}
                  onOpenImage={props.onOpenImage}
                  loadArtifactImage={props.loadArtifactImage}
                />
                <View class="absolute top-0 left-0 flex-row gap-[2px]" style={{ marginTop: -4, marginLeft: -4 }}>
                  <Each of={numberedOn(block(), marks(), blocks())} key={(m: Mark) => m.id}>
                    {(m: () => Mark) => (
                      <View
                        role="button"
                        testID={`markdown-mark-${m().id}`}
                        accessibilityLabel={props.labels.mark(m().n, markTitle(m()))}
                        tooltip={tip(markTitle(m()))}
                        onPress={() => props.onPick(m().id)}
                        class={`cursor-pointer select-none min-w-[18px] h-[18px] px-1 rounded-full items-center justify-center border ${
                          m().status === "draft" ? "bg-pane border-dotted border-brand" : m().status === "resolved" ? "bg-ink-muted border-ink-muted" : "bg-brand border-brand"
                        } ${m().stale ? "border-dashed" : ""}`}
                      >
                        <Text class={`font-mono text-[10px] font-semibold ${m().status === "draft" ? "text-brand" : "text-white"}`}>{String(m().n)}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
              <If when={sel() && choosing()}>
                <View
                  role="button"
                  testID="markdown-annotate-button"
                  onPress={() => annotate(block())}
                  class="cursor-pointer select-none self-end mt-1 px-3 h-[28px] items-center justify-center rounded-(--radius-sm) bg-brand active:bg-accent-active"
                >
                  <Text class="text-[12px] font-semibold text-on-accent">{props.labels.annotate}</Text>
                </View>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
