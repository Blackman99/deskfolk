/**
 * A file as editable code (`ArtifactCodeEditor.svelte`), on nsh/base's `Editor` where the Svelte
 * had Monaco: the Editor's own highlighting (by the file name), soft wrap, read-only, and the
 * annotations drawn as decorations (a tint on the range, a mark in the gutter before the line
 * numbers). The text is a signal mirrored from `onChange`, so `getValue` and `isDirty` are sync;
 * the buffer is unsaved whenever it differs from `baseline` (what is on disk).
 *
 * TSX has no `bind:this`/exports: the methods the Svelte exports come out as an
 * `ArtifactEditorHandle`, handed to `handle` once mounted and `null` when it goes.
 * Not ported: `loadMonaco` (no Monaco here); Monaco's find widget is a small find bar of
 * its own (find, next, previous, close; no replace row: the copy has no words for it, so
 * `openReplace` opens the same bar). A drawn annotation moves with edits, but a click on its
 * mark finds it by where it was drawn.
 */
import { Overlay, Text, View, cleanup, effect, signal, type Bounds } from "nsh";
import { Editor, Input, type EditorDecoration, type EditorRef, type EditorSelection } from "nsh/base";
import type { Annotation } from "@real-bot/protocol";
import { wholeLineRange, type EditorRange } from "../../m/annotations/text-range.ts";
import { baseName } from "../../m/paths.ts";
import { copy } from "../../runtime";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import {
  annotationDecorations,
  annotationStartingOn,
  foldLineEndings,
  selectionRange,
  toNshRange,
  type DrawnAnnotation,
} from "./artifact-code-editor";

export type ArtifactEditorHandle = {
  getValue: () => string;
  isDirty: () => boolean;
  markSaved: (next?: string) => void;
  revert: (value: string) => void;
  openFind: () => void;
  openReplace: () => void;
  findNext: () => void;
  findPrevious: () => void;
  isFindOpen: () => boolean;
  closeFind: () => boolean;
  revealAnnotation: (id: string) => void;
};

export function ArtifactCodeEditor(props: {
  code: string;
  path: string;
  wrap: boolean;
  onDirty?: (dirty: boolean) => void;
  /** This file's annotations: drawn as gutter marks and inline ranges. */
  annotations?: Annotation[];
  /** The one to scroll to and flash, when a card or a row was clicked. */
  focusAnnotationId?: string | null;
  /** Bumped on every request to go to `focusAnnotationId`: the one already focused is shown again. */
  focusAnnotationSeq?: number;
  /** What is on disk; left out, what the editor was made with. */
  baseline?: string | null;
  /** Whether a selection offers the annotate button, and what it says. */
  annotateEnabled?: boolean;
  annotateLabel?: string;
  onAnnotate?: (range: EditorRange, text: string) => void;
  /** A click on a drawn annotation's mark. */
  onPickAnnotation?: (id: string) => void;
  /** A file that cannot be saved from here: read, never typed into. */
  readOnly?: boolean;
  /** The Svelte's exported methods (`bind:this`). */
  handle?: (handle: ArtifactEditorHandle | null) => void;
}) {
  const text = signal(foldLineEndings(props.code));
  const saved = signal(foldLineEndings(props.baseline ?? props.code));
  const findOpen = signal(false);
  const query = signal("");
  const count = signal<{ current: number; total: number }>({ current: 0, total: 0 });
  const flash = signal<EditorDecoration[]>([]);
  const pending = signal<{ range: EditorRange; anchor: Bounds } | null>(null);
  let editor: EditorRef | null = null;
  let drawn: DrawnAnnotation[] = [];
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let reported: boolean | null = null;

  const dirty = () => text() !== saved();
  const syncDirty = () => {
    const now = dirty();
    if (reported === now) return;
    reported = now;
    props.onDirty?.(now);
  };
  syncDirty();

  const marks = () => annotationDecorations(props.annotations ?? [], text());
  const decorations = (): EditorDecoration[] => {
    const m = marks();
    drawn = m.drawn;
    return [...m.decorations, ...flash()];
  };

  const revealAnnotation = (id: string) => {
    const item = marks().drawn.find((d) => d.id === id);
    if (!item || !editor) return;
    const range = toNshRange(item.range);
    editor.revealPosition(range.start, true);
    flash.set([{ range, class: "bg-accent-border" }]);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.set([]), 1400);
  };

  const markSaved = (next: string = text()) => {
    saved.set(foldLineEndings(next));
    syncDirty();
  };

  const handle: ArtifactEditorHandle = {
    getValue: () => text(),
    isDirty: dirty,
    markSaved,
    revert: (value) => {
      const folded = foldLineEndings(value);
      text.set(folded);
      editor?.setValue(folded);
      markSaved(folded);
    },
    openFind: () => findOpen.set(true),
    openReplace: () => findOpen.set(true),
    findNext: () => editor?.run("findNext"),
    findPrevious: () => editor?.run("findPrevious"),
    isFindOpen: () => findOpen(),
    closeFind: () => {
      if (!findOpen()) return false;
      findOpen.set(false);
      editor?.focus();
      return true;
    },
    revealAnnotation,
  };
  props.handle?.(handle);
  cleanup(() => {
    props.handle?.(null);
    if (flashTimer) clearTimeout(flashTimer);
  });

  // A new `code` (the file read again) replaces a buffer with nothing unsaved in it.
  let lastCode = props.code;
  effect(() => {
    const doc = props.code;
    if (doc === lastCode) return;
    lastCode = doc;
    if (dirty()) return;
    const folded = foldLineEndings(doc);
    text.set(folded);
    editor?.setValue(folded);
    saved.set(foldLineEndings(props.baseline ?? doc));
    syncDirty();
  });

  effect(() => {
    const id = props.focusAnnotationId;
    void props.focusAnnotationSeq;
    if (id) queueMicrotask(() => revealAnnotation(id));
  });

  effect(() => {
    if (!props.annotateEnabled) pending.set(null);
  });

  const onSelection = async (selections: EditorSelection[]) => {
    const range = props.annotateEnabled && props.onAnnotate ? selectionRange(selections[selections.length - 1]) : null;
    if (!range || !editor) {
      pending.set(null);
      return;
    }
    const boxes = await editor.rangeBounds(toNshRange(range));
    const last = boxes[boxes.length - 1];
    pending.set(last ? { range, anchor: { origin: { x: last.pageBounds.origin.x + last.pageBounds.size.width, y: last.pageBounds.origin.y }, size: { width: 0, height: last.pageBounds.size.height } } } : null);
  };

  const onLineNumber = (line: number) => {
    const picked = annotationStartingOn(drawn, line + 1);
    if (picked) {
      props.onPickAnnotation?.(picked);
      return;
    }
    // A tap on a line number selects the line: what a touch selection cannot be trusted to do.
    if (!props.annotateEnabled) return;
    const whole = toNshRange(wholeLineRange(text(), line + 1));
    editor?.setSelections([{ anchor: whole.start, head: whole.end }]);
  };

  return (
    <View class="min-h-[280px] flex-1 h-full relative flex-col" testID="artifact-code-editor">
      <If when={findOpen()}>
        <View testID="artifact-find-bar" class="flex-row items-center gap-1 px-2 py-1 border-b border-line bg-pane">
          <Input
            testID="artifact-find-input"
            autoFocus
            accessibilityLabel={copy().stream.artifactFind}
            value={query()}
            onChange={(e) => query.set(e.value)}
            onSubmit={() => handle.findNext()}
            class={`flex-1 px-2 border border-line rounded-(--radius-sm) bg-input-bg text-ink text-[12px] focus:border-field-focus-border ${narrowWindow() ? "h-[40px]" : "h-[26px]"}`}
          />
          <Text testID="artifact-find-count" class="text-[12px] text-ink-muted">{`${count().total === 0 ? 0 : count().current + 1}/${count().total}`}</Text>
          <IconButton icon="chevron-up" size="sm" label={copy().stream.artifactFindPrev} testID="artifact-find-prev" onPress={handle.findPrevious} />
          <IconButton icon="chevron-down" size="sm" label={copy().stream.artifactFindNext} testID="artifact-find-next" onPress={handle.findNext} />
          <IconButton icon="x" size="sm" label={copy().common.close} testID="artifact-find-close" onPress={() => void handle.closeFind()} />
        </View>
      </If>
      <Editor
        testID="artifact-editor"
        ref={(node: EditorRef) => {
          editor = node;
        }}
        class="flex-1 min-h-0 bg-pane"
        value={text()}
        language={baseName(props.path)}
        readOnly={props.readOnly === true}
        softWrap={props.wrap}
        fontSize={12}
        lineHeight={18}
        tabSize={2}
        scrollBeyondLastLine={false}
        decorations={decorations()}
        gutterDecorationsWidth={4}
        search={findOpen() && query() !== "" ? { query: query() } : null}
        accessibilityLabel={baseName(props.path)}
        onSearchChange={(e) => count.set({ current: e.result.current ?? 0, total: e.result.count })}
        onChange={(e) => {
          text.set(e.value);
          syncDirty();
        }}
        onSelectionChange={(e) => void onSelection(e.selections)}
        onLineNumberPress={(e) => onLineNumber(e.line)}
      />
      <If when={pending()}>
        {(p) => (
          <Overlay anchor={p().anchor} placement="bottom" align="end" offset={4} margin={8}>
            <View
              role="button"
              testID="artifact-annotate-button"
              onPress={() => {
                const range = p().range;
                pending.set(null);
                props.onAnnotate?.(range, text());
              }}
              class={`px-[10px] bg-brand border border-accent-border rounded-full ${narrowWindow() ? "py-1" : "py-[2px]"}`}
              style={{ boxShadow: shadow("md") }}
            >
              <Text class="text-[12px] font-semibold text-on-accent">{props.annotateLabel ?? ""}</Text>
            </View>
          </Overlay>
        )}
      </If>
    </View>
  );
}
