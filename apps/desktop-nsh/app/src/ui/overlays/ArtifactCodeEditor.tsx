/**
 * A file as editable code (`ArtifactCodeEditor.svelte`), on nsh/base's `Editor` where the Svelte
 * had Monaco: the Editor's own highlighting (by the file name), soft wrap, read-only, and the
 * annotations drawn as decorations (a tint on the range, a mark in the gutter before the line
 * numbers). The text is a signal mirrored from `onChange`, so `getValue` and `isDirty` are sync;
 * the buffer is unsaved whenever it differs from `baseline` (what is on disk).
 *
 * The Editor keeps its own text (`defaultValue`), and `onChange` only reports it. Controlling it
 * (`value` set again from `onChange`) lost typing: the value comes back to the editor a frame
 * late, as an edit of its own, over the keys typed since.
 *
 * Text from outside (the file read again with nothing unsaved, a discard) makes a new Editor rather
 * than `setValue`, and so does another file, even one with the same text. The Editor's `setValue`
 * is an edit undo takes back, so after a switch ⌘Z would bring the last file's text into this one,
 * and a save would write it there. Monaco's `setValue` began a new history.
 *
 * What is on disk follows `baseline` whenever it changes. The loader sets the text and then the
 * disk text, and in between the buffer looked unsaved. It stayed so, and the next switch asked
 * about an edit nobody made.
 *
 * The colours are the messenger's (`code-colors.tsx`: Vitesse, or the code theme your interface
 * chose, with its surface), as decorations over the Editor's own highlighting turned off. They are
 * read again a moment after the last edit; meanwhile the Editor carries them with the text. Past
 * `CODE_COLORS_LIMIT`, or where there are none (the web), the Editor's own colours stay.
 *
 * TSX has no `bind:this`/exports: the methods the Svelte exports come out as an
 * `ArtifactEditorHandle`, handed to `handle` once mounted and `null` when it goes.
 * Not ported: `loadMonaco` (no Monaco here); Monaco's find widget is a small find bar of
 * its own (find, next, previous, close; no replace row: the copy has no words for it, so
 * `openReplace` opens the same bar). A drawn annotation moves with edits, but a click on its
 * mark finds it by where it was drawn.
 */
import { Overlay, Text, View, cleanup, computed, effect, signal, untracked, type Bounds } from "nsh";
import { Editor, Input, type EditorDecoration, type EditorRef, type EditorSelection } from "nsh/base";
import type { Annotation } from "@real-bot/protocol";
import { wholeLineRange, type EditorRange } from "../../m/annotations/text-range.ts";
import { baseName } from "../../m/paths.ts";
import { copy } from "../../runtime";
import { codeColorsAvailable, codeSurface, codeTheme, colorDecorations, highlightCode } from "../code-colors";
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
  /** Counts the texts put in from outside: each one is a new Editor, with a history of its own. */
  const generation = signal(0);
  /** The last text from outside (`code`, a discard). The buffer holds the person's own edits while it differs. */
  let loaded = text();
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

  /**
   * The text the colours were read from, with the file it is (its language): the buffer a moment
   * after the last edit, at once when it comes from outside. One value: another file brings its
   * name and its text together, and reading the name apart coloured the last file's text as the
   * next one's first.
   */
  const colorSource = signal({ text: text(), path: props.path });
  let colorTimer: ReturnType<typeof setTimeout> | null = null;
  const colorSoon = (value: string) => {
    if (colorTimer) clearTimeout(colorTimer);
    colorTimer = setTimeout(() => {
      colorTimer = null;
      colorSource.set({ text: value, path: historyPath });
    }, 150);
  };
  const runs = computed(() => {
    const source = colorSource();
    return codeColorsAvailable() ? highlightCode(source.text, baseName(source.path), codeTheme("editor"), false) : null;
  });
  const colorDecos = computed(() => {
    const r = runs();
    return r ? colorDecorations(r) : [];
  });
  const surface = () => codeSurface();

  const marks = () => annotationDecorations(props.annotations ?? [], text());
  /** The same array while nothing in it changed: the Editor takes a new one whole, colours and all. */
  const decorations = computed(
    (): EditorDecoration[] => {
      const m = marks();
      drawn = m.drawn;
      const colors = colorDecos();
      const lit = flash();
      return m.decorations.length === 0 && lit.length === 0 ? colors : [...colors, ...m.decorations, ...lit];
    },
    { equals: (a, b) => a === b || (a.length === b.length && a.every((d, i) => d === b[i])) },
  );

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

  /** Puts `folded` (of file `path`) in from outside: a new Editor holding it. Whether one was made. */
  const replace = (folded: string, path: string = historyPath): boolean => {
    loaded = folded;
    if (folded === text()) return false;
    text.set(folded);
    if (colorTimer) clearTimeout(colorTimer);
    colorSource.set({ text: folded, path });
    generation.set(generation() + 1);
    return true;
  };
  /** The file the Editor's history belongs to. */
  let historyPath = props.path;

  const handle: ArtifactEditorHandle = {
    getValue: () => text(),
    isDirty: dirty,
    markSaved,
    revert: (value) => {
      const folded = foldLineEndings(value);
      replace(folded);
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
    if (colorTimer) clearTimeout(colorTimer);
  });

  // A new `code` (another file, or this one read again) replaces a buffer with none of the person's
  // edits in it; what is on disk is `baseline`'s, whichever of the two changed first. Another file
  // is a new Editor even when its text is the same (two empty files): its history is not this one's.
  effect(() => {
    const doc = foldLineEndings(props.code);
    const disk = foldLineEndings(props.baseline ?? props.code);
    const path = props.path;
    untracked(() => {
      let made = false;
      if (doc !== loaded) {
        if (text() === loaded) made = replace(doc, path);
        else loaded = doc;
      }
      if (path !== historyPath) {
        historyPath = path;
        if (!made) {
          // The same text as another file: a new Editor all the same, coloured as this one.
          if (colorTimer) clearTimeout(colorTimer);
          colorSource.set({ text: text(), path });
          generation.set(generation() + 1);
        }
      }
      saved.set(disk);
      syncDirty();
    });
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

  /** One Editor, holding the text as it is when it is made. */
  const editorView = () => (
    <Editor
      testID="artifact-editor"
      ref={(node: EditorRef) => {
        editor = node;
      }}
      class="flex-1 min-h-0 bg-pane"
      style={surface() ? { backgroundColor: surface()!.bg } : undefined}
      defaultValue={untracked(text)}
      language={baseName(props.path)}
      readOnly={props.readOnly === true}
      softWrap={props.wrap}
      fontSize={12}
      lineHeight={18}
      tabSize={2}
      scrollBeyondLastLine={false}
      highlighting={runs() === null}
      styles={runs() ? { content: { color: surface()?.fg ?? runs()!.fg } } : undefined}
      decorations={decorations()}
      gutterDecorationsWidth={4}
      search={findOpen() && query() !== "" ? { query: query() } : null}
      accessibilityLabel={baseName(props.path)}
      onSearchChange={(e) => count.set({ current: e.result.current ?? 0, total: e.result.count })}
      onChange={(e) => {
        text.set(e.value);
        syncDirty();
        colorSoon(e.value);
      }}
      onSelectionChange={(e) => void onSelection(e.selections)}
      onLineNumberPress={(e) => onLineNumber(e.line)}
    />
  );

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
      <Each of={[generation()]} key={(g) => g}>
        {() => editorView()}
      </Each>
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
