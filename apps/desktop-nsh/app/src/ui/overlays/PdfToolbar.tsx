/**
 * The PDF viewer's toolbar (`PdfToolbar.svelte`): zoom out, the zoom menu (fits and presets, the
 * fit showing its percentage while it is the one in force), zoom in, the page-number box, the page
 * count and the find button, which opens the find bar under the toolbar: the query, the count
 * ("2/7", "no match", "searching"), previous / next and close. Enter steps forward, Shift+Enter back.
 */
import { effect, keymap, Text, untracked, View, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { ZOOM_PRESETS, zoomIn, zoomMenuValue, zoomOut, zoomPercent } from "../../m/annotations/pdf-region.ts";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { Select, type SelectOption } from "../Select";
import { tip } from "../tip";
import type { PdfFind } from "./pdf-find";
import type { PdfPages } from "./pdf-pages";
import type { PdfViewerLabels } from "./PdfViewer";

function ToolButton(props: { label: string; testID: string; onPress: () => void; children: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={tip(props.label)}
      onPress={props.onPress}
      class={`cursor-pointer select-none items-center justify-center rounded-(--radius-sm) border border-line bg-btn-secondary-bg hover:bg-btn-secondary-hover active:scale-[0.96] px-[6px] ${narrowWindow() ? "min-w-[40px] h-[40px]" : "min-w-[26px] h-[26px]"}`}
    >
      <Text class="text-[13px] text-ink">{props.children}</Text>
    </View>
  );
}

export function PdfToolbar(props: { labels: PdfViewerLabels; pages: PdfPages; find: PdfFind }) {
  const pages = props.pages;
  const find = props.find;
  const labels = () => props.labels;
  /** A zoom typed or pinched to, that is none of the presets, gets its own entry while it is in force. */
  const customZoom = () => {
    const mode = pages.zoomMode();
    return mode.kind === "scale" && !(ZOOM_PRESETS as readonly number[]).includes(mode.value) ? mode.value : null;
  };
  const options = (): SelectOption[] => {
    const mode = pages.zoomMode();
    const out: SelectOption[] = [
      { value: "fit-width", label: mode.kind === "fit-width" ? `${labels().fitWidth} · ${zoomPercent(pages.zoom())}` : labels().fitWidth },
      { value: "fit-page", label: mode.kind === "fit-page" ? `${labels().fitPage} · ${zoomPercent(pages.zoom())}` : labels().fitPage },
      ...ZOOM_PRESETS.map((preset) => ({ value: String(preset), label: zoomPercent(preset) })),
    ];
    const custom = customZoom();
    if (custom !== null) out.push({ value: String(custom), label: zoomPercent(custom) });
    return out;
  };
  let pageBox: InputRef | null = null;
  let findBox: InputRef | null = null;
  /** Shift+Enter just stepped back: the input also reports it as a submit, which must not step forward. */
  let steppedBack = false;

  // The bar was asked to open (again): the query takes the focus and is selected, so typing replaces it.
  effect(() => {
    if (find.focusInput() === 0) return;
    untracked(() => setTimeout(() => {
      findBox?.focus();
      findBox?.setSelection(0, find.query().length);
    }, 0));
  });
  // Shift+Enter in the query steps back.
  effect(() => {
    if (!find.open()) return;
    return keymap.bind(
      "shift+enter",
      () => {
        steppedBack = true;
        setTimeout(() => {
          steppedBack = false;
        }, 100);
        find.stepFind(-1);
      },
      { when: "always" },
    );
  });

  return (
    <View>
    <View testID="pdf-toolbar" class="flex-row flex-wrap items-center gap-1 px-2 py-1 bg-pane border-b border-line">
      <ToolButton label={labels().zoomOut} testID="pdf-zoom-out" onPress={() => pages.setZoom(zoomOut(pages.zoom()))}>−</ToolButton>
      <View class="w-[150px]">
        <Select
          testID="pdf-zoom"
          value={zoomMenuValue(pages.zoomMode())}
          options={options()}
          size="sm"
          ariaLabel={labels().zoom}
          onChange={(value) => pages.onZoomMenu(value)}
        />
      </View>
      <ToolButton label={labels().zoomIn} testID="pdf-zoom-in" onPress={() => pages.setZoom(zoomIn(pages.zoom()))}>+</ToolButton>
      <View class="w-px h-4 mx-1 bg-line" />
      <Input
        testID="pdf-page-input"
        ref={(node: InputRef) => {
          pageBox = node;
        }}
        accessibilityLabel={labels().pageNumber}
        keyboardType="number-pad"
        value={pages.pageInput()}
        onChange={(e) => {
          // Only what was typed counts as typing: the input also reports the value the page set.
          if (e.value === pages.pageInput()) return;
          pages.setPageInputFocused(true);
          pages.pageInput.set(e.value);
        }}
        onFocus={() => {
          pages.setPageInputFocused(true);
          // The Svelte selects the number on focus, so typing replaces it.
          pageBox?.setSelection(0, pages.pageInput().length);
        }}
        onBlur={() => {
          pages.setPageInputFocused(false);
          pages.commitPageInput();
        }}
        onSubmit={() => {
          pages.commitPageInput();
          // Typing is done: scrolling updates the box again, focused or not.
          pages.setPageInputFocused(false);
        }}
        class={`px-[6px] border border-line rounded-(--radius-sm) bg-input-bg text-ink text-center text-[12px] focus:border-field-focus-border ${narrowWindow() ? "w-[52px] h-[40px]" : "w-[44px] h-[26px]"}`}
      />
      <Text testID="pdf-page-total" class="text-[12px] text-ink-muted">{labels().pageCount(pages.numPages())}</Text>
      <View class="flex-1" />
      <IconButton
        icon="search"
        size={narrowWindow() ? "lg" : "sm"}
        label={labels().find}
        testID="pdf-find-toggle"
        pressed={find.open()}
        onPress={() => (find.open() ? void find.closeFind() : find.openFind())}
      />
    </View>
    <If when={find.open()}>
      <View testID="pdf-find" role="search" class="flex-row items-center gap-1 px-2 py-1 bg-pane border-b border-line">
        <Input
          testID="pdf-find-input"
          ref={(node: InputRef) => {
            findBox = node;
          }}
          autoFocus
          placeholder={labels().findPlaceholder}
          accessibilityLabel={labels().find}
          submitBehavior="submit"
          value={find.query()}
          onChange={(e) => {
            if (e.value === find.query()) return;
            find.query.set(e.value);
            find.queueFind();
          }}
          onSubmit={() => {
            if (steppedBack) return;
            find.stepFind(1);
          }}
          class={`flex-1 min-w-[120px] px-[6px] border border-line rounded-(--radius-sm) bg-input-bg text-ink text-[12px] focus:border-field-focus-border ${narrowWindow() ? "h-[40px]" : "h-[26px]"}`}
        />
        <Text testID="pdf-find-count" class="text-[12px] text-ink-muted">{find.status()}</Text>
        <IconButton icon="chevron-up" size="sm" label={labels().findPrev} testID="pdf-find-prev" disabled={find.matches().length === 0} onPress={() => find.stepFind(-1)} />
        <IconButton icon="chevron-down" size="sm" label={labels().findNext} testID="pdf-find-next" disabled={find.matches().length === 0} onPress={() => find.stepFind(1)} />
        <IconButton icon="x" size="sm" label={labels().findClose} testID="pdf-find-close" onPress={() => void find.closeFind()} />
      </View>
    </If>
    </View>
  );
}
