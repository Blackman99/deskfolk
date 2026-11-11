/**
 * The map's clock (`MapTimeline.svelte`, ADR 0096): play, speed, back to live, one lane per
 * character with its failures as dots, the moments as marks, and a slider over the squeezed time.
 */
import { Canvas, Easing, Image, Path2D, Text, View, createMotion, effect, signal, token } from "nsh";
import { reduceMotion } from "../interface/motion";
import { Slider } from "nsh/base";
import type { Copy } from "../../m/copy";
import type { Timeline } from "../../m/taskmap/timeline";
import { tip } from "../tip";

type T = Copy["taskmap"];

const TRACK = 996;
const LANE_AREA = 56;
const SPEEDS = [1, 4, 8, 32];
const glyph = (d: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14"><path d="${d}" fill="#000"/></svg>`)}`;
const PLAY = glyph("M4 2l10 6-10 6z");
const PAUSE = glyph("M4 2h3v12H4zM9 2h3v12H9z");

export function MapTimeline(props: {
  t: T;
  tl: Timeline;
  v: number;
  playing: boolean;
  speed: number;
  /** Whether the run is going on now, and whether the map is following it to its newest step. */
  liveRun: boolean;
  atLive: boolean;
  step: number;
  steps: number;
  lanes: { label: string; color: string }[];
  markColor: (kind: string) => string;
  /** Ticks for the picked place's steps, on the squeezed clock; empty for none. */
  ticks: readonly number[];
  tickNote: string;
  onToggle: () => void;
  onSpeed: (s: number) => void;
  onSeek: (v: number) => void;
  onLive: () => void;
}) {
  const width = signal(0);
  const x = (at: number) => (props.tl.total > 0 ? (at / props.tl.total) * width() : 0);
  const label = () => (props.playing ? props.t.controls.pause : props.t.controls.play);

  // The live dot breathes while the map follows a run.
  const pulse = createMotion();
  effect(() => {
    if (props.liveRun && props.atLive && !reduceMotion()) {
      void pulse.play({ duration: 1400, keyframes: { opacity: [1, 0.35, 1] }, easing: Easing.inOut(Easing.ease), iterations: "infinite" });
    } else pulse.reset();
  });

  return (
    <View testID="taskmap-timeline" class="px-3 pt-2 pb-[6px] border-t border-line-subtle bg-pane">
      <View class="flex-row flex-wrap items-center gap-[6px] min-h-[34px]">
        <View
          role="button"
          testID="taskmap-play"
          accessibilityLabel={label()}
          tooltip={tip(label())}
          onPress={() => props.onToggle()}
          class="cursor-pointer select-none w-[32px] h-[32px] rounded-full items-center justify-center bg-brand hover:bg-accent-hover"
        >
          <Image src={props.playing ? PAUSE : PLAY} style={{ width: 14, height: 14, tintColor: token("on-accent") }} accessible={false} />
        </View>
        <Text class="text-[13px] text-ink-muted">{props.t.controls.speed}</Text>
        <Each of={SPEEDS}>
          {(s) => (
            <View
              role="button"
              testID={`taskmap-speed-${s()}`}
              accessibilityState={{ selected: s() === props.speed }}
              onPress={() => props.onSpeed(s())}
              class={`cursor-pointer select-none min-h-[26px] px-2 justify-center rounded-(--radius-sm) border ${s() === props.speed ? "bg-brand border-brand" : "bg-pane border-line"}`}
            >
              <Text class={`text-[13px] font-semibold ${s() === props.speed ? "text-on-accent" : "text-ink"}`}>{`${s()}×`}</Text>
            </View>
          )}
        </Each>
        <If when={props.liveRun}>
          <If
            when={props.atLive}
            else={
              <View
                role="button"
                testID="taskmap-to-live"
                onPress={() => props.onLive()}
                class="cursor-pointer select-none min-h-[26px] px-2 justify-center rounded-(--radius-sm) border bg-pane border-line"
              >
                <Text class="text-[13px] font-semibold text-ink">{props.t.controls.toLive}</Text>
              </View>
            }
          >
            <View testID="taskmap-live" class="flex-row items-center gap-[5px]">
              <View class="w-[7px] h-[7px] rounded-full bg-ok" style={{ opacity: pulse.opacity }} />
              <Text class="text-[13px] font-semibold text-ok-text">{props.t.live}</Text>
            </View>
          </If>
        </If>
        <View class="flex-1" />
        <If when={props.tickNote}>
          <Text testID="taskmap-tick-note" class="text-[13px] text-ink-secondary">{props.tickNote}</Text>
        </If>
        <Text testID="taskmap-step" class="text-[13px] text-ink-muted">{props.t.controls.step(props.step, props.steps)}</Text>
      </View>
      <View class="flex-row mt-[10px]">
        <View class="w-[40px] shrink-0 overflow-hidden">
          <Each of={props.lanes}>
            {(lane) => (
              <Text
                class="text-[10px] font-semibold line-clamp-1"
                style={{ height: props.tl.laneH, lineHeight: props.tl.laneH, color: lane().color }}
              >
                {lane().label}
              </Text>
            )}
          </Each>
        </View>
        <View class="flex-1 relative rounded-(--radius-sm) bg-chip" style={{ height: LANE_AREA }} onLayout={(e) => width.set(e.bounds.size.width)}>
          <Canvas
            class="absolute left-0 top-0 right-0 bottom-0"
            draw={(cx, size) => {
              const w = size.width;
              const total = Math.max(0.01, props.tl.total);
              const line = token("line");
              for (const idle of props.tl.idles) {
                const x0 = (idle.v0 / total) * w;
                const x1 = (idle.v1 / total) * w;
                cx.fillStyle = token("line-subtle");
                cx.fillRect(x0, 0, Math.max(3, x1 - x0), LANE_AREA);
                cx.fillStyle = line;
                cx.fillRect(x0, 0, 1, LANE_AREA);
                cx.fillRect(Math.max(x0 + 2, x1 - 1), 0, 1, LANE_AREA);
              }
              cx.save();
              cx.scale(w / TRACK, 1);
              cx.globalAlpha = 0.4;
              cx.strokeStyle = token("ink");
              cx.lineWidth = 1 / Math.max(0.01, w / TRACK);
              for (const tv of props.ticks) {
                const px = (tv / total) * TRACK;
                cx.beginPath();
                cx.moveTo(px, 0);
                cx.lineTo(px, LANE_AREA);
                cx.stroke();
              }
              cx.globalAlpha = 0.6;
              props.tl.lanes.forEach((d, i) => {
                cx.fillStyle = props.lanes[i]?.color ?? token("ink-muted");
                cx.fill(new Path2D(d));
              });
              cx.globalAlpha = 1;
              cx.fillStyle = token("danger");
              cx.fill(new Path2D(props.tl.failD));
              cx.restore();
            }}
          />
          <Each of={props.tl.moments}>
            {(m) => (
              <View
                class="absolute"
                style={{
                  left: x(m().v) - 5,
                  top: -9,
                  width: 0,
                  height: 0,
                  borderLeftWidth: 5,
                  borderRightWidth: 5,
                  borderTopWidth: 7,
                  borderLeftColor: "transparent",
                  borderRightColor: "transparent",
                  borderTopColor: props.markColor(m().kind),
                }}
              />
            )}
          </Each>
          <View testID="taskmap-head" class="absolute w-[2px] rounded-[1px] bg-ink" style={{ left: x(props.v) - 1, top: -4, height: 64 }} />
        </View>
      </View>
      <View class="flex-row mt-1">
        <View class="w-[40px] shrink-0" />
        <Slider
          testID="taskmap-scrub"
          class="flex-1"
          min={0}
          max={Math.max(0.1, props.tl.total)}
          step={0.1}
          value={props.v}
          accessibilityLabel={props.t.controls.scrub}
          trackClass="h-[16px] justify-center"
          indicatorClass="h-[4px] rounded-full bg-line"
          rangeClass="rounded-full bg-brand"
          thumbClass="w-[14px] h-[14px] rounded-full bg-brand"
          onChange={(e) => props.onSeek(e.value as number)}
        />
      </View>
    </View>
  );
}
