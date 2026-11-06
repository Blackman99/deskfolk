/**
 * The overlay on one PDF page (`PdfPageMarks.svelte`): the page's drawn annotations as numbered
 * boxes (accent solid for open, dotted for a draft, grey for resolved, dashed when the file has
 * changed since), the box being dragged out, and the pending box with its four corner handles.
 * Positions are percentages of the page, so they follow any zoom.
 *
 * The drags are PanResponders made by the viewer's gesture controller (`pdf-gestures.ts`), not the
 * Svelte's pointer callbacks; the controller reads `n` when a finger goes down, because a list row
 * is recycled for other pages. Moving the pending box with the arrow keys is the viewer's
 * (a View has no key events here).
 */
import { Text, View } from "nsh";
import type { PdfMark } from "../../m/annotations/pdf-region.ts";
import type { Handle, NormBox } from "../../m/annotations/region-box.ts";
import { narrowWindow } from "../Modal";
import { cssColor, shadow } from "../styles";
import { tip } from "../tip";
import type { PdfGestures, PdfGestureView } from "./pdf-gestures";
import type { PdfViewerLabels } from "./PdfViewer";

const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];

const pct = (v: number) => `${(v * 100).toFixed(3)}%` as `${number}%`;
const boxStyle = (box: NormBox) => ({ position: "absolute" as const, left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) });

export function PdfPageMarks(props: {
  /** The page this overlay sits on. */
  n: number;
  labels: PdfViewerLabels;
  choosing: boolean;
  /** This page's drawn annotations. */
  marks: PdfMark[];
  flashId: string | null;
  peekId: string | null;
  gesture: PdfGestureView | null;
  pendingShown: { page: number; box: NormBox } | null;
  gestures: PdfGestures;
  onBadgePress: (id: string) => void;
  /** A long press on a badge shows its remark (a touch screen has no hover). */
  onBadgePeek: (id: string) => void;
}) {
  const hit = narrowWindow() ? 40 : 16;
  const pending = () => (props.pendingShown && props.pendingShown.page === props.n ? props.pendingShown.box : null);
  const markTitle = (mark: PdfMark) => (mark.stale ? `${mark.body}\n${props.labels.stale}` : mark.body);

  const overlayPan = props.gestures.responder(() => props.n, { kind: "new" });
  const movePan = props.gestures.responder(() => props.n, { kind: "move", region: pending });
  const handlePans = Object.fromEntries(HANDLES.map((h) => [h, props.gestures.responder(() => props.n, { kind: "resize", handle: h, region: pending })])) as Record<
    Handle,
    ReturnType<PdfGestures["responder"]>
  >;

  return (
    <View
      testID={`pdf-marks-${props.n}`}
      tooltip={props.choosing ? tip(props.labels.region) : undefined}
      {...overlayPan.panHandlers}
      class="absolute"
      style={{ left: 0, top: 0, right: 0, bottom: 0, cursor: props.choosing ? "crosshair" : undefined }}
    >
      <Each of={props.marks} key={(mark: PdfMark) => mark.id}>
        {(mark: () => PdfMark) => (
          <View
            testID={`pdf-mark-${mark().id}`}
            // While choosing, the boxes let a drag through; their numbers still open them.
            style={{
              ...boxStyle(mark().box),
              pointerEvents: "none",
              boxShadow: props.flashId === mark().id ? `0 0 0 6px ${cssColor("var(--accent-glow)")}` : undefined,
            }}
            class={`border-2 rounded-[2px] ${
              mark().status === "resolved" ? "border-ink-muted/70 bg-ink-muted/10" : mark().status === "draft" ? "border-brand bg-brand/6" : "border-brand bg-brand/12"
            } ${mark().status === "draft" ? "border-dotted" : mark().stale ? "border-dashed" : ""}`}
          >
            <View
              testID={`pdf-mark-number-${mark().id}`}
              role="button"
              accessibilityLabel={props.labels.mark(mark().n, mark().body)}
              tooltip={tip(markTitle(mark()))}
              onPress={() => props.onBadgePress(mark().id)}
              onLongPress={() => props.onBadgePeek(mark().id)}
              style={{ position: "absolute", left: -11, top: -11, pointerEvents: "auto", boxShadow: shadow("md") }}
              class={`min-w-[18px] h-[18px] px-[5px] rounded-full items-center justify-center ${
                mark().status === "draft" ? "bg-pane border-2 border-brand" : mark().status === "resolved" ? "bg-ink-muted" : "bg-brand"
              }`}
            >
              <Text class={`text-[11px] font-semibold ${mark().status === "draft" ? "text-brand" : "text-on-accent"}`}>{String(mark().n)}</Text>
            </View>
            <If when={props.peekId === mark().id}>
              <View
                testID="pdf-mark-peek"
                style={{ position: "absolute", left: 0, top: "100%", marginTop: 6, maxWidth: 240, boxShadow: shadow("md"), pointerEvents: "none" }}
                class="px-2 py-1 border border-line rounded-(--radius-sm) bg-pane"
              >
                <Text class="text-[12px] text-ink">{markTitle(mark())}</Text>
              </View>
            </If>
          </View>
        )}
      </Each>
      <If when={props.gesture?.kind === "new" && props.gesture.page === props.n ? props.gesture.box : null}>
        {(box: () => NormBox) => <View testID="pdf-drawing" accessible={false} style={boxStyle(box())} class="border-2 border-dashed border-brand bg-brand/10" />}
      </If>
      <If when={pending()}>
        {(box: () => NormBox) => (
          <View
            testID="pdf-pending"
            role="group"
            accessibilityLabel={props.labels.pending}
            tooltip={tip(props.labels.pending)}
            {...movePan.panHandlers}
            style={{ ...boxStyle(box()), boxShadow: shadow("md"), cursor: "move" }}
            class="border-2 border-brand rounded-[2px] bg-accent-glow"
          >
            <Each of={HANDLES} key={(h: Handle) => h}>
              {(h: () => Handle) => (
                <View
                  testID={`pdf-handle-${h()}`}
                  tooltip={tip(props.labels.resize)}
                  {...handlePans[h()].panHandlers}
                  class="absolute items-center justify-center"
                  style={{
                    width: hit,
                    height: hit,
                    left: h() === "nw" || h() === "sw" ? -hit / 2 : undefined,
                    right: h() === "ne" || h() === "se" ? -hit / 2 : undefined,
                    top: h() === "nw" || h() === "ne" ? -hit / 2 : undefined,
                    bottom: h() === "sw" || h() === "se" ? -hit / 2 : undefined,
                    cursor: h() === "nw" || h() === "se" ? "nwse-resize" : "nesw-resize",
                  }}
                >
                  <View accessible={false} class="w-[10px] h-[10px] border-2 border-brand rounded-[2px] bg-pane" />
                </View>
              )}
            </Each>
          </View>
        )}
      </If>
    </View>
  );
}
