/**
 * What lies over the town (`MapHud.svelte`, ADR 0096): the key of places to folders, or the picked
 * place's card; the controls to turn and zoom; and the chip that says the camera follows someone.
 * In the app's own colours, not the picture's.
 */
import { Canvas, PanResponder, Path2D, Text, View, token, type ViewRef } from "nsh";
import type { Copy } from "../../m/copy";
import type { PlaceDetail } from "../../m/taskmap/inspect";
import { cssColor, shadow } from "../styles";
import { tip } from "../tip";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";

type T = Copy["taskmap"];
type Legend = { name: string; path: string; color: string };

export function MapHud(props: {
  t: T;
  legend: readonly Legend[];
  hover: number;
  /** The picked place and its card, or null. */
  picked: { name: string; path: string; full: string; color: string; detail: PlaceDetail } | null;
  who: (b: number) => { short: string; color: string };
  when: (at: number) => string;
  verbOfCall: (call: number) => string;
  phi: number;
  needle: number;
  zoom: number;
  zoomMin: number;
  zoomMax: number;
  following: string | null;
  compact: boolean;
  onTurnBy: (dir: 1 | -1) => void;
  onTurn: (degrees: number) => void;
  onFace: () => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
  onStopFollow: () => void;
  onClosePlace: () => void;
  onJump: (v: number) => void;
}) {
  const deg = () => Math.round(props.phi) % 360;

  // The compass: drag it round to turn the map, press it to face the start again.
  let dial: ViewRef | null = null;
  let centre = { x: 0, y: 0 };
  let last = 0;
  let dragged = false;
  let dragEnd = 0;
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.hypot(g.dx, g.dy) >= 3,
    onPanResponderGrant: (_e, g) => {
      dragged = true;
      void dial?.measure().then((m) => {
        if (!m) return;
        centre = { x: m.pagePosition.x + m.bounds.size.width / 2, y: m.pagePosition.y + m.bounds.size.height / 2 };
        last = Math.atan2(g.moveY - centre.y, g.moveX - centre.x);
      });
    },
    onPanResponderMove: (_e, g) => {
      if (!centre.x && !centre.y) return;
      const a = Math.atan2(g.moveY - centre.y, g.moveX - centre.x);
      let da = ((a - last) * 180) / Math.PI;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      last = a;
      props.onTurn(da);
    },
    onPanResponderRelease: () => { dragEnd = Date.now(); dragged = false; },
    onPanResponderTerminate: () => { dragEnd = Date.now(); dragged = false; },
  });

  const dialLabel = () => props.t.controls.dial(deg());
  const picked = () => props.picked;

  return (
    <View class="absolute left-0 top-0 right-0 bottom-0" style={{ pointerEvents: "box-none", zIndex: 600 }}>
      <If when={!props.compact}>
        <View
          testID="taskmap-hint"
          class="absolute left-[10px] top-2 max-w-full px-[10px] py-[2px] rounded-full bg-pane border border-line-subtle opacity-90"
          style={{ pointerEvents: "none", maxWidth: "95%" }}
        >
          <Text class="text-[11px] text-ink-secondary line-clamp-1">{props.t.hint}</Text>
        </View>
      </If>

      <If when={props.following}>
        {(name) => (
          <View
            role="button"
            testID="taskmap-following"
            onPress={() => props.onStopFollow()}
            class="cursor-pointer select-none absolute right-[10px] top-2 px-[10px] py-1 rounded-(--radius-md) bg-pane border border-accent-border"
          >
            <Text class="text-[13px] text-ink">{props.t.following(name())}</Text>
          </View>
        )}
      </If>

      <If
        when={picked()}
        else={
          <If when={!props.compact}>
            <View
              role="region"
              testID="taskmap-legend"
              accessibilityLabel={props.t.legendHead}
              class="absolute left-[10px] bottom-[10px] w-[236px] px-[10px] py-2 bg-pane border border-line rounded-(--radius-md)"
              style={{ boxShadow: shadow("sm") }}
            >
              <View class="flex-row items-center justify-between gap-[6px] mb-1">
                <Text class="text-[13px] font-bold text-ink">{props.t.legendHead}</Text>
                <Text class="text-[13px] text-ink-muted">{props.t.legendHint}</Text>
              </View>
              <Each of={props.legend}>
                {(row, i) => (
                  <View
                    testID={`taskmap-legend-row-${i()}`}
                    class={`flex-row items-center gap-[6px] h-[14px] px-1 rounded-[4px] ${props.hover === i() ? "bg-accent-tint" : ""}`}
                    style={{ marginLeft: -4, marginRight: -4 }}
                  >
                    <View class="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ backgroundColor: cssColor(row().color) }} />
                    <Text class="w-[72px] shrink-0 text-[10.5px] font-semibold text-ink line-clamp-1">{row().name}</Text>
                    <Text class="flex-1 min-w-0 font-mono text-[9.5px] text-ink-muted line-clamp-1">{row().path}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        }
      >
        {(card) => (
          <View
            role="region"
            testID="taskmap-insp"
            accessibilityLabel={card().name}
            class="absolute left-[10px] bottom-[10px] w-[236px] px-[10px] py-2 bg-pane border border-ink rounded-(--radius-md)"
            style={{ boxShadow: shadow("sm") }}
          >
            <View class="flex-row items-center gap-[6px] mb-1">
              <View class="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ backgroundColor: cssColor(card().color) }} />
              <Text class="text-[13px] font-bold text-ink">{card().name}</Text>
              <Text tooltip={tip(card().full)} class="flex-1 min-w-0 font-mono text-[9.5px] text-ink-muted line-clamp-1">{card().path}</Text>
              <IconButton icon="x" label={props.t.insp.close} size="xs" testID="taskmap-insp-close" onPress={() => props.onClosePlace()} />
            </View>
            <Text class="my-[2px] text-[11.5px] text-ink">
              {props.t.insp.steps(card().detail.upto, card().detail.tripsNow, card().detail.total, card().detail.trips)}
            </Text>
            <View class="flex-row flex-wrap gap-2 my-[2px]">
              <Each of={card().detail.byWho}>
                {(entry) => (
                  <Text class="text-[11px] font-semibold" style={{ color: cssColor(props.who(entry()[0]).color) }}>
                    {`${props.who(entry()[0]).short} ${entry()[1]}`}
                  </Text>
                )}
              </Each>
              <Text class={`text-[11px] font-semibold ${card().detail.fails > 0 ? "text-danger-text" : "text-ink"}`}>
                {props.t.insp.fails(card().detail.fails)}
              </Text>
            </View>
            <Text class="my-[2px] text-[10.5px] text-ink-muted">
              {card().detail.tripsNow ? props.t.insp.recent(card().detail.recent.length) : props.t.insp.nobody(card().detail.next !== null)}
            </Text>
            <Each of={card().detail.recent}>
              {(trip) => (
                <View
                  role="button"
                  testID={`taskmap-visit-${trip().call}`}
                  onPress={() => props.onJump(trip().v)}
                  class="cursor-pointer select-none flex-row items-center gap-[6px] w-full h-[22px] px-[6px] rounded-(--radius-sm) hover:bg-row-hover"
                >
                  <Text class="font-mono text-[11px] text-ink-muted">{props.when(trip().at)}</Text>
                  <Text class="shrink-0 text-[11px] font-semibold" style={{ color: cssColor(props.who(trip().who).color) }}>
                    {props.who(trip().who).short}
                  </Text>
                  <Text class="flex-1 min-w-0 text-[11px] text-ink line-clamp-1">{props.verbOfCall(trip().call)}</Text>
                  <Text class="font-mono text-[11px] text-ink-muted">{props.t.insp.steps1(trip().steps)}</Text>
                </View>
              )}
            </Each>
            <View class="flex-row gap-[6px] mt-[6px]">
              <HudButton testID="taskmap-insp-prev" label={props.t.insp.prev} disabled={card().detail.prev === null} grow onPress={() => card().detail.prev !== null && props.onJump(card().detail.prev!)} />
              <HudButton testID="taskmap-insp-next" label={props.t.insp.next} disabled={card().detail.next === null} grow onPress={() => card().detail.next !== null && props.onJump(card().detail.next!)} />
            </View>
          </View>
        )}
      </If>

      <View
        testID="taskmap-controls"
        class="absolute right-[10px] bottom-[10px] flex-row items-center gap-1 p-1 bg-pane border border-line rounded-(--radius-lg)"
        style={{ boxShadow: shadow("sm") }}
      >
        <IconButton icon="rotate-ccw" label={props.t.controls.turnLeft} size="sm" testID="taskmap-turn-left" onPress={() => props.onTurnBy(-1)} />
        <View
          ref={(node) => (dial = node)}
          role="button"
          testID="taskmap-dial"
          accessibilityLabel={dialLabel()}
          tooltip={tip(dialLabel())}
          {...pan.panHandlers}
          onPress={() => { if (!dragged && Date.now() - dragEnd > 150) props.onFace(); }}
          class="cursor-pointer select-none w-[32px] h-[32px] rounded-full items-center justify-center border border-line bg-pane"
        >
          <Canvas
            style={{ width: 24, height: 24, pointerEvents: "none" }}
            draw={(cx) => {
              cx.strokeStyle = token("line");
              cx.lineWidth = 1.2;
              cx.beginPath();
              cx.arc(12, 12, 10.5, 0, Math.PI * 2);
              cx.stroke();
              cx.save();
              cx.translate(12, 12);
              cx.rotate((props.needle * Math.PI) / 180);
              cx.translate(-12, -12);
              cx.fillStyle = token("brand");
              cx.fill(new Path2D("M12 3.5l3.2 8.5h-6.4z"));
              cx.fillStyle = token("muted-light");
              cx.fill(new Path2D("M12 20.5l3.2-8.5h-6.4z"));
              cx.restore();
            }}
          />
        </View>
        <View style={{ transform: [{ scaleX: -1 }] }}>
          <IconButton icon="rotate-ccw" label={props.t.controls.turnRight} size="sm" testID="taskmap-turn-right" onPress={() => props.onTurnBy(1)} />
        </View>
        <Text testID="taskmap-readout-deg" class="min-w-[34px] text-center font-mono text-[11.5px] text-ink-secondary">{`${deg()}°`}</Text>
        <View class="w-px h-[20px] bg-line" />
        <IconButton icon="minus" label={props.t.controls.zoomOut} size="sm" testID="taskmap-zoom-out" disabled={props.zoom <= props.zoomMin + 1e-3} onPress={() => props.onZoom(1 / 1.25)} />
        <Text testID="taskmap-readout-zoom" class="min-w-[34px] text-center font-mono text-[11.5px] text-ink-secondary">{`${Math.round(props.zoom * 100)}%`}</Text>
        <IconButton icon="plus" label={props.t.controls.zoomIn} size="sm" testID="taskmap-zoom-in" disabled={props.zoom >= props.zoomMax - 1e-3} onPress={() => props.onZoom(1.25)} />
        <View
          role="button"
          testID="taskmap-reset"
          accessibilityLabel={props.t.controls.reset}
          onPress={() => props.onReset()}
          class="cursor-pointer select-none flex-row items-center gap-1 min-h-[28px] px-2 rounded-(--radius-sm) border border-line bg-pane hover:bg-row-hover"
        >
          <Icon name="fit" size={16} class="tint-ink" />
          <If when={!props.compact}>
            <Text class="text-[13px] font-semibold text-ink">{props.t.controls.reset}</Text>
          </If>
        </View>
      </View>
    </View>
  );
}

/** The card's small bordered button (`.tm-btn`). */
function HudButton(props: { label: string; disabled?: boolean; grow?: boolean; testID?: string; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default flex-row items-center justify-center min-h-[28px] px-2 rounded-(--radius-sm) border border-line bg-pane hover:bg-row-hover disabled:opacity-[0.45] ${props.grow ? "flex-1" : ""}`}
    >
      <Text class="text-[13px] font-semibold text-ink">{props.label}</Text>
    </View>
  );
}
