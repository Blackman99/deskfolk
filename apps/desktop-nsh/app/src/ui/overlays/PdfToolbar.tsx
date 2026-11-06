/**
 * The PDF viewer's toolbar (`PdfToolbar.svelte`): zoom out, the zoom menu (fits and presets, the
 * fit showing its percentage while it is the one in force), zoom in, the page-number box and the
 * page count. Not here: the find button and bar, which need the document's text (the native
 * module gives none yet).
 */
import { Text, View, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { ZOOM_PRESETS, zoomIn, zoomMenuValue, zoomOut, zoomPercent } from "../../m/annotations/pdf-region.ts";
import { narrowWindow } from "../Modal";
import { Select, type SelectOption } from "../Select";
import { tip } from "../tip";
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
      class={`items-center justify-center rounded-(--radius-sm) border border-line bg-btn-secondary-bg hover:bg-btn-secondary-hover active:scale-[0.96] px-[6px] ${narrowWindow() ? "min-w-[40px] h-[40px]" : "min-w-[26px] h-[26px]"}`}
    >
      <Text class="text-[13px] text-ink">{props.children}</Text>
    </View>
  );
}

export function PdfToolbar(props: { labels: PdfViewerLabels; pages: PdfPages }) {
  const pages = props.pages;
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

  return (
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
    </View>
  );
}
