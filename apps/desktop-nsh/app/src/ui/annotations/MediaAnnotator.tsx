/**
 * Time marks on audio and video (`MediaAnnotator.svelte`): the player (nsh/base's `Video`, with its
 * platform controls), a thin timeline under it where the existing marks are numbered dots (a time)
 * or bars (a stretch), in three states, dashed when stale; pressing one jumps there. 「在此处批注」
 * takes the playback position as a point; while that point waits for its remark, 「到此为止」
 * stretches it to a span ending at the position.
 *
 * Not here: the video frame at the start (`crop`). NSH has no way to read a frame back, so a
 * finished point hands the preview its anchor with no crop, video or not.
 */
import { effect, keymap, signal, Text, untracked, Video, View, type VideoRef } from "nsh";
import type { Annotation, MediaTimeAnchor } from "@real-bot/protocol";
import {
  durationMs,
  layoutTimeline,
  markTitle,
  percentOf,
  pointAt,
  pointRoom,
  secondsToMs,
  spanBetween,
  timeLabel,
  type SpanCheck,
  type TimelineMark,
} from "../../m/annotations/media-time.ts";
import type { EncodedCrop } from "../../m/annotations/region-box.ts";
import { Button } from "../Button";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

/** Every string this annotator shows; the preview hands them in from its copy. */
export type MediaAnnotatorLabels = {
  /** The button that takes the playback position as a point. */
  markHere: string;
  markHereHint: string;
  /** The button that turns the pending point into a span ending at the playback position. */
  endHere: string;
  endHereHint: string;
  /** The timeline's accessible name. */
  timeline: string;
  /** The tooltip on the time readout of the anchor that is waiting for its remark. */
  pending: string;
  /** Why nothing can be annotated: the player has no duration to measure against. */
  durationUnknown: string;
  /** Why 「到此为止」 is off: the playback position is too close to the start. */
  spanTooShort: string;
  /** Why 「到此为止」 is off: the point lies past the end the player now reports. */
  spanPastEnd: string;
  /** Added to a stale mark's tooltip. */
  stale: string;
};

const pct = (value: number) => `${value.toFixed(3)}%` as `${number}%`;

export function MediaAnnotator(props: {
  src: string;
  kind: "audio" | "video";
  /** This file's media_time rows, in display order: numbered 1..n. */
  annotations: Annotation[];
  /** Seek to this one and flash its mark when it changes, or when `focusSeq` asks again. */
  focusId: string | null;
  /** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
  focusSeq?: number;
  /** Part of the adapters' shared contract; the buttons are the mode here, so it is not read. */
  active?: boolean;
  /** Whether a new annotation may be started at all; existing ones are drawn either way. */
  enabled: boolean;
  labels: MediaAnnotatorLabels;
  /** A point was chosen: the preview opens the composer. There is never a crop. */
  onDraft: (draft: { anchor: MediaTimeAnchor; crop?: () => Promise<EncodedCrop | null> }) => void;
  /** A mark was pressed (after the player has jumped to it). */
  onPick: (id: string) => void;
  /** The anchor waiting for its remark. */
  pending?: MediaTimeAnchor | null;
  /** 「到此为止」 turned the pending anchor into this span. Without it the button is not offered. */
  onPendingChange?: (anchor: MediaTimeAnchor) => void;
  /** Escape with an anchor pending. */
  onCancel?: () => void;
  /** The player could not play the source (a stream that broke off, a file that went away). */
  onError?: () => void;
  /** A length (seconds) known before the player reports one; the player's own replaces it. */
  durationSeconds?: number;
  testID?: string;
}) {
  let player: VideoRef | null = null;
  /** Playback position and duration in seconds, as the player last reported them. */
  const now = signal(0);
  const total = signal(props.durationSeconds ?? Number.NaN);
  /** The player has reported its metadata once: an unknown duration after that is worth a word. */
  const metaSeen = signal(false);
  const flashId = signal<string | null>(null);
  /** Where the pending point was set: a span grows from here, whichever way the person seeks. */
  const spanOrigin = signal<number | null>(null);
  /** The timeline's width in points; 0 until laid out. */
  const trackPx = signal(0);

  let lastFocus: string | null = null;
  let lastFocusSeq = 0;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  /** A point's mark is this wide (a finger's 40 on a phone). */
  const laneH = () => (narrowWindow() ? 40 : 20);
  const dur = () => durationMs(total());
  const layout = () => layoutTimeline(props.annotations, dur(), pointRoom(trackPx(), laneH()));
  /** The point the span would grow from: the one we set, or whatever point the preview holds. */
  const origin = (): number | null => {
    const held = props.pending;
    if (!held) return null;
    if (held.end_ms === undefined) return held.start_ms;
    const o = spanOrigin();
    return o !== null && (o === held.start_ms || o === held.end_ms) ? o : held.start_ms;
  };
  const spanCheck = (): SpanCheck | null => {
    const o = origin();
    return o === null ? null : spanBetween(o, secondsToMs(now()), dur());
  };
  const spanHint = (): string | null => {
    const check = spanCheck();
    if (!check || check.ok) return null;
    if (check.reason === "too-short") return props.labels.spanTooShort;
    if (check.reason === "past-end") return props.labels.spanPastEnd;
    return metaSeen() ? props.labels.durationUnknown : null;
  };
  const scale = () => dur() ?? props.pending?.duration_ms ?? null;
  const showTimeline = () => scale() !== null && (layout().marks.length > 0 || props.pending != null || props.enabled);
  const canExtend = () => Boolean(props.pending && props.onPendingChange);

  function seek(ms: number): void {
    player?.seek(ms / 1000);
    now.set(ms / 1000);
  }

  function markHere(): void {
    if (!props.enabled || props.pending) return;
    const anchor = pointAt(now(), total());
    if (!anchor) return;
    spanOrigin.set(anchor.start_ms);
    props.onDraft({ anchor });
  }

  function endHere(): void {
    const held = props.pending;
    if (!held || !props.onPendingChange) return;
    const from = origin() ?? held.start_ms;
    const check = spanBetween(from, secondsToMs(now()), dur());
    if (!check.ok) return;
    spanOrigin.set(from);
    props.onPendingChange(check.anchor);
  }

  function pick(mark: TimelineMark): void {
    seek(mark.start_ms);
    props.onPick(mark.id);
  }

  // Escape drops the pending anchor wherever focus is. The composer handles its own first.
  keymap.bind(
    "escape",
    () => {
      if (props.pending && props.onCancel) props.onCancel();
    },
    { when: "always" },
  );

  effect(() => {
    const id = props.focusId;
    const seq = props.focusSeq ?? 0;
    // The rows are read below, so a snapshot runs this again: only a new request seeks.
    if (id === lastFocus && seq === lastFocusSeq) return;
    if (!id) {
      lastFocus = null;
      lastFocusSeq = seq;
      return;
    }
    const row = props.annotations.find((item) => item.id === id);
    // Not ours yet: the rows may land after the focus does, and this runs again when they do.
    if (!row || row.anchor_kind !== "media_time") return;
    lastFocus = id;
    lastFocusSeq = seq;
    untracked(() => {
      const start = (row.anchor as MediaTimeAnchor).start_ms;
      const d = dur();
      if (row.stale?.kind === "missing" || (d !== null && start > d)) return;
      seek(start);
      flashId.set(id);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flashId.set(null), 1400);
    });
  });

  const markBox = (mark: TimelineMark) => {
    const span = mark.end_ms !== null;
    return span
      ? { position: "absolute" as const, left: pct(mark.left), width: pct(mark.width), top: mark.lane * laneH(), height: laneH() }
      : { position: "absolute" as const, left: pct(mark.left), marginLeft: -laneH() / 2, width: laneH(), top: mark.lane * laneH(), height: laneH() };
  };
  const badgeClass = (mark: TimelineMark) =>
    `min-w-[16px] h-[16px] px-[3px] rounded-full items-center justify-center border ${
      mark.status === "draft" ? "bg-pane border-dotted border-brand" : mark.status === "resolved" ? "bg-ink-muted border-ink-muted" : "bg-brand border-brand"
    } ${mark.stale ? "border-dashed" : ""}`;

  return (
    <View testID={props.testID ?? "media-annotator"} class="gap-[6px] w-full min-h-0">
      <Video
        testID="media-annotator-player"
        ref={(node: VideoRef) => (player = node)}
        src={props.src}
        controls
        paused
        progressUpdateInterval={100}
        onLoad={(e) => {
          metaSeen.set(true);
          total.set(e.duration);
        }}
        onProgress={(e) => {
          now.set(Number.isFinite(e.currentTime) ? e.currentTime : 0);
          total.set(e.duration);
        }}
        onError={() => props.onError?.()}
        class={`w-full rounded-(--radius-md) ${props.kind === "video" ? "min-h-[96px] flex-1" : "h-[54px]"}`}
      />

      <If when={showTimeline() && scale() !== null}>
        <View
          role="group"
          testID="media-timeline"
          accessibilityLabel={props.labels.timeline}
          class="px-2 py-[6px] border border-line rounded-(--radius-md) bg-pane"
        >
          <View
            testID="media-timeline-lanes"
            onLayout={(e) => trackPx.set(e.bounds.size.width)}
            // A press on the bare timeline is a shortcut that seeks there; the player's own controls stay the keyboard way.
            onPress={(e) => {
              const width = trackPx();
              const s = scale();
              if (width > 0 && s !== null) seek(Math.round(Math.min(1, Math.max(0, e.position.x / width)) * s));
            }}
            class="cursor-pointer rounded-(--radius-sm) bg-line-subtle"
            style={{ height: layout().lanes * laneH() }}
          >
            <If when={props.pending && spanCheck()?.ok && props.pending.end_ms === undefined}>
              <View
                accessible={false}
                testID="media-annot-preview"
                class="absolute top-0 bottom-0 border border-dashed border-accent-border bg-accent-tint"
                style={{
                  left: pct(percentOf((spanCheck() as { anchor: MediaTimeAnchor }).anchor.start_ms, scale()!)),
                  width: pct(
                    percentOf((spanCheck() as { anchor: MediaTimeAnchor }).anchor.end_ms ?? 0, scale()!) -
                      percentOf((spanCheck() as { anchor: MediaTimeAnchor }).anchor.start_ms, scale()!),
                  ),
                }}
              />
            </If>
            <Each of={layout().marks} key={(mark: TimelineMark) => mark.id}>
              {(mark: () => TimelineMark) => (
                <View
                  role="button"
                  testID={`media-mark-${mark().id}`}
                  accessibilityLabel={markTitle(mark(), props.labels.stale)}
                  tooltip={tip(markTitle(mark(), props.labels.stale))}
                  onPress={() => pick(mark())}
                  class={`cursor-pointer select-none flex-row items-center ${mark().end_ms === null ? "justify-center" : "justify-start"}`}
                  style={{ ...markBox(mark()), boxShadow: flashId() === mark().id ? "0 0 0 3px rgba(0,128,128,0.4)" : undefined }}
                >
                  <If when={mark().end_ms !== null}>
                    <View
                      accessible={false}
                      class={`absolute left-0 right-0 h-[8px] rounded-[3px] border ${
                        mark().status === "resolved" ? "border-ink-muted bg-ink-muted/55" : mark().status === "draft" ? "border-dotted border-brand bg-brand/18" : "border-brand bg-brand/70"
                      } ${mark().stale ? "border-dashed" : ""}`}
                      style={{ top: (laneH() - 8) / 2 }}
                    />
                  </If>
                  <View accessible={false} class={badgeClass(mark())}>
                    <Text class={`font-mono text-[10px] font-semibold ${mark().status === "draft" ? "text-brand" : "text-white"}`}>{String(mark().n)}</Text>
                  </View>
                </View>
              )}
            </Each>
            <If when={props.pending}>
              {(held: () => MediaTimeAnchor) => (
                <View
                  accessible={false}
                  testID="media-pending"
                  class={held().end_ms === undefined ? "absolute top-0 bottom-0 w-[2px] border-l-2 border-dashed border-brand" : "absolute top-0 bottom-0 border border-dashed border-brand bg-brand/30 rounded-(--radius-sm)"}
                  style={
                    held().end_ms === undefined
                      ? { left: pct(percentOf(held().start_ms, scale()!)) }
                      : { left: pct(percentOf(held().start_ms, scale()!)), width: pct(percentOf(held().end_ms!, scale()!) - percentOf(held().start_ms, scale()!)) }
                  }
                />
              )}
            </If>
            <If when={dur() !== null}>
              <View
                accessible={false}
                testID="media-playhead"
                class="absolute top-0 bottom-0 w-[2px] bg-ink"
                style={{ left: pct(percentOf(secondsToMs(now()), dur()!)) }}
              />
            </If>
          </View>
        </View>
      </If>

      <If when={props.pending || props.enabled}>
        <View class="flex-row flex-wrap items-center gap-[6px]">
          <If
            when={props.pending}
            else={
              <>
                <View tooltip={tip(dur() === null ? props.labels.durationUnknown : props.labels.markHereHint)}>
                  <Button testID="media-mark-here" size={narrowWindow() ? "lg" : "sm"} disabled={dur() === null} onPress={markHere}>
                    {props.labels.markHere}
                  </Button>
                </View>
                <If when={dur() === null && metaSeen()}>
                  <Text testID="media-hint" class="text-[11px] text-ink-muted">{props.labels.durationUnknown}</Text>
                </If>
              </>
            }
          >
            {(held: () => MediaTimeAnchor) => (
              <>
                <Text testID="media-pending-label" tooltip={tip(props.labels.pending)} class="font-mono text-[11px] text-ink">{timeLabel(held())}</Text>
                <If when={canExtend()}>
                  <View tooltip={tip(props.labels.endHereHint)}>
                    <Button testID="media-end-here" variant="primary" size={narrowWindow() ? "lg" : "sm"} disabled={!spanCheck()?.ok} onPress={endHere}>
                      {props.labels.endHere}
                    </Button>
                  </View>
                </If>
                <If when={canExtend() ? spanHint() : null}>
                  {(hint: () => string) => <Text testID="media-hint" class="text-[11px] text-ink-muted">{hint()}</Text>}
                </If>
              </>
            )}
          </If>
        </View>
      </If>
    </View>
  );
}
