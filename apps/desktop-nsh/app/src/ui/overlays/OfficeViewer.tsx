/**
 * `OfficeViewer.svelte`: a read-only preview of a Word, Excel or PowerPoint file, with the
 * toolbar (type, "read-only", slide pages, full screen), the loading / error / limit states, the
 * sheet tabs, and a slide show's keys in full screen. The file is read natively
 * (`deskfolk/native`'s `Office`, Rust: no web view, no `exceljs`, `docx-preview` or
 * `pptx-renderer`): the runtime's file `path` (as the PDF view fetches its own) or the file's
 * bytes in Base64, and what is drawn comes from the model Rust returns (`office-model.ts`).
 *
 * Props differ from the Svelte one's only in where the bytes come from: `path` / `base64` for
 * `data: Blob` (NSH has no Blob a Rust module can read) and no `labels` (`copy().stream.office`).
 *
 * Full screen is a `Dialog` over the window with the same content; the model, the sheet and the
 * slide are held here, so entering and leaving it reads nothing again. A file replaced (a new
 * `path`, `base64` or `kind`) starts over; the same file handed down again does not.
 */
import { batch, cleanup, computed, effect, keymap, signal, Text, untracked, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";
import { copy, runtime } from "../../runtime";
import { holdFullscreenPreview } from "../../m/overlays/fullscreen-preview.ts";
import { slideForKey } from "../../m/overlays/office/slides.ts";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { SheetView } from "./office-sheet";
import { SlideView } from "./office-slides";
import { WordView } from "./office-document";
import {
  closeOffice,
  failureOf,
  nextOfficeId,
  openOffice,
  type DeckModel,
  type OfficeKind,
  type OfficeModel,
  type OfficeSource,
} from "./office-model";

type Phase = "loading" | "ready" | "error" | "limit";

const TYPE = { word: "Word", spreadsheet: "Excel", presentation: "PowerPoint" } as const;

/** Key names (`keymap`) → the DOM names `slideForKey` reads. */
const SLIDE_KEYS: Record<string, string> = {
  right: "ArrowRight",
  down: "ArrowDown",
  pagedown: "PageDown",
  left: "ArrowLeft",
  up: "ArrowUp",
  pageup: "PageUp",
  home: "Home",
  end: "End",
};

export function OfficeViewer(props: {
  /** The file in the runtime's workspace (or an absolute path the runtime can read). */
  path?: string;
  /** Or the file's own bytes, Base64. */
  base64?: string;
  kind: OfficeKind;
  /** The file's name: the region's name, and the toolbar's in full screen. */
  title: string;
  testID?: string;
}) {
  const labels = () => copy().stream.office;
  const enlarged = signal(false);
  const phase = signal<Phase>("loading");
  const model = signal<OfficeModel | null>(null);
  const docId = signal("");
  const sheetIndex = signal(0);
  const slideIndex = signal(0);
  const retry = signal(0);
  const slideBox = signal({ width: 0, height: 0 });

  const fileKey = computed(() => `${props.kind}\u0000${props.path ?? ""}\u0000${props.base64 ?? ""}`);
  const deck = (): DeckModel | null => {
    const m = model();
    return m && m.kind === "presentation" ? m : null;
  };
  const slideCount = () => deck()?.slides.length ?? 0;

  // A file of the runtime waits for the link to it: once up, a later drop and reconnect does not reload.
  const linked = signal(props.base64 !== undefined);
  effect(() => {
    if (runtime.connection === "connected") linked.set(true);
  });

  effect(() => {
    fileKey();
    retry();
    if (!linked()) return;
    const id = nextOfficeId();
    let live = true;
    const kind = untracked(() => props.kind);
    const source: OfficeSource = untracked(() => (props.base64 !== undefined ? { base64: props.base64 } : { path: props.path ?? "" }));
    batch(() => {
      enlarged.set(false);
      phase.set("loading");
      model.set(null);
      docId.set(id);
      sheetIndex.set(0);
      slideIndex.set(0);
    });
    void openOffice(id, kind, source).then(
      (opened) => {
        if (!live) return;
        batch(() => {
          model.set(opened);
          phase.set("ready");
        });
      },
      (error) => {
        if (live) phase.set(failureOf(error));
      },
    );
    return () => {
      live = false;
      closeOffice(id);
    };
  });

  const go = (next: number) => {
    if (next >= 0 && next < slideCount()) slideIndex.set(next);
  };
  const exitFull = () => enlarged.set(false);

  // A presentation in full screen turns its pages the way a slide show does; Back leaves.
  effect(() => {
    if (!enlarged()) return;
    const release = holdFullscreenPreview(exitFull);
    const off = keymap.bind(
      Object.fromEntries(
        Object.entries(SLIDE_KEYS).map(([key, dom]) => [
          key,
          () => {
            if (props.kind !== "presentation" || phase() !== "ready") return;
            const next = slideForKey(dom, slideIndex(), slideCount());
            if (next !== null) slideIndex.set(next);
          },
        ]),
      ),
    );
    return () => {
      release();
      off();
    };
  });
  cleanup(() => enlarged.set(false));

  const content = () => (
    <View class="flex-1 min-h-0 min-w-0 bg-pane">
      <View class="flex-row flex-wrap items-center gap-2 px-[10px] py-[6px] min-h-[40px] border-b border-line">
        <Text testID="office-type" class="text-[12px] font-semibold text-ink">{TYPE[props.kind]}</Text>
        <Text testID="office-readonly" class="text-[11px] text-ink-muted">{labels().readOnly}</Text>
        <If when={enlarged()}>
          <Text testID="office-filename" class="flex-1 min-w-0 text-[12px] text-ink-muted line-clamp-1">{props.title}</Text>
        </If>
        <View class="flex-row items-center gap-2 ml-auto">
          <If when={phase() === "ready" && props.kind === "presentation" && slideCount() > 0}>
            <View class="flex-row items-center gap-2">
              <PageButton label={labels().previous} glyph="‹" testID="office-prev" disabled={slideIndex() === 0} onPress={() => go(slideIndex() - 1)} />
              <Text testID="office-pages" class="text-[12px] text-ink">{`${slideIndex() + 1} / ${slideCount()}`}</Text>
              <PageButton label={labels().next} glyph="›" testID="office-next" disabled={slideIndex() === slideCount() - 1} onPress={() => go(slideIndex() + 1)} />
            </View>
          </If>
          <IconButton
            testID="office-full"
            icon={enlarged() ? "minimize" : "maximize"}
            size="lg"
            label={enlarged() ? labels().exitFull : labels().fullscreen}
            pressed={enlarged()}
            onPress={() => enlarged.set(!enlarged())}
          />
        </View>
      </View>
      <If when={phase() === "loading"}>
        <Text testID="office-status" role="text" class="px-4 py-6 text-[13px] text-ink-muted">{labels().loading}</Text>
      </If>
      <If when={phase() === "error" || phase() === "limit"}>
        <View testID="office-error" role="alert" class="gap-3 px-4 py-6 items-start">
          <Text class="text-[13px] text-ink-muted">{phase() === "limit" ? labels().tooLarge : labels().failed}</Text>
          <If when={phase() === "error"}>
            <Button testID="office-retry" size="sm" onPress={() => retry.set(retry() + 1)}>{labels().retry}</Button>
          </If>
        </View>
      </If>
      <If when={phase() === "ready" ? model() : null}>
        {(ready) => {
          const m = ready();
          if (m.kind === "spreadsheet") return <SheetView book={m} index={sheetIndex()} onIndex={(i) => sheetIndex.set(i)} />;
          if (m.kind === "word") return <WordView id={docId()} blocks={m.blocks} />;
          return m.slides.length === 0 ? (
            <Text testID="office-empty" class="px-4 py-6 text-[13px] text-ink-muted">{labels().empty}</Text>
          ) : (
            <View
              class="flex-1 min-h-0 items-center justify-center bg-bg"
              onLayout={(e) => slideBox.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
            >
              <SlideView id={docId()} deck={m} index={slideIndex()} width={slideBox().width} height={slideBox().height} />
            </View>
          );
        }}
      </If>
      <Text testID="office-notice" class="px-[10px] py-[7px] text-[11px] text-ink-muted border-t border-line-subtle">
        {props.kind === "spreadsheet" ? labels().sheetHint : labels().layoutHint}
      </Text>
    </View>
  );

  return (
    <View
      testID={props.testID ?? "office-viewer"}
      role="region"
      accessibilityLabel={props.title}
      accessibilityState={{ busy: phase() === "loading" }}
      class="flex-1 min-h-[320px] min-w-0 overflow-hidden bg-pane"
    >
      <If when={enlarged()} else={content()}>
        <Dialog
          open
          animation="fade"
          closeOnEscape
          closeOnBackdropPress={false}
          onCancel={exitFull}
          onOpenChange={(e) => {
            if (!e.open) exitFull();
          }}
          backdropClass="bg-pane"
          class="m-auto bg-pane overflow-hidden"
          style={{ width: windowSize().width, height: windowSize().height }}
        >
          <View testID="office-fullscreen" class="flex-1 min-h-0">{content()}</View>
        </Dialog>
      </If>
    </View>
  );
}

function PageButton(props: { label: string; glyph: string; disabled: boolean; onPress: () => void; testID: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class="items-center justify-center min-w-[32px] min-h-[32px] rounded-[5px] border border-line bg-pane hover:bg-row-hover disabled:opacity-[0.4]"
    >
      <Text class="text-[20px] text-ink">{props.glyph}</Text>
    </View>
  );
}
