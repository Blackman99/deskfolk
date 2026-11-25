/**
 * A project session's context window usage at the right of a phone's header: the ring with what it
 * reads beside it, a button the height of the header. A press brings up a sheet with the figures:
 * how much is used, the window, what is left, the model. On a phone the composer's row has no room
 * for a ring worth reading, and a hint cannot be hovered there. Hidden until the session reports
 * usage, as the composer's ring is on a desktop.
 */
import { Canvas, signal, Text, token, View } from "nsh";
import type { ProjectContextUsage } from "@real-bot/protocol";
import { formatTokens } from "../../m/spend-format.ts";
import { usageUsed } from "../../m/usage/usage.ts";
import { copy } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { tip } from "../tip";
import { drawRing, levelColor } from "../usage/ring";
import { contextReading } from "./project-context";

const TOP_TONE = { normal: "text-ink-secondary", warn: "text-warn-text", danger: "text-danger-text" } as const;
const SHEET_TONE = { normal: "text-ink", warn: "text-warn-text", danger: "text-danger-text" } as const;

type Reading = ReturnType<typeof contextReading>;

export function ProjectContextTop(props: { context: ProjectContextUsage | null | undefined }) {
  const reading = contextReading(() => props.context);
  return (
    <If when={reading.ctx()}>
      <TopButton reading={reading} />
    </If>
  );
}

/** Mounted only while there is usage, so a sheet left open goes with it and does not come back. */
function TopButton(props: { reading: Reading }) {
  const t = () => copy();
  const r = props.reading;
  const open = signal(false);
  return (
    <View class="shrink-0">
      <View
        role="button"
        testID="top-context"
        accessibilityLabel={r.label()}
        accessibilityState={{ expanded: open() }}
        tooltip={tip(r.label())}
        onPress={() => open.set(!open())}
        class={`cursor-pointer select-none flex-row items-center justify-center gap-[6px] min-w-[48px] min-h-[64px] h-full px-[12px] active:bg-line-subtle ${
          open() ? "bg-line-subtle" : ""
        }`}
      >
        <Canvas
          testID="top-context-ring"
          accessible={false}
          style={{ width: 20, height: 20 }}
          draw={(cx) => {
            const p = r.percent();
            drawRing(cx, {
              box: 20,
              view: 24,
              radius: 9,
              width: 3,
              used: p !== null ? usageUsed(p) : null,
              color: levelColor(r.level(), "ink-secondary"),
              track: token("line"),
              dashed: p === null,
            });
          }}
        />
        <Text testID="top-context-text" class={`text-[13px] font-semibold tabular-nums ${TOP_TONE[r.level()]}`}>
          {r.shortText()}
        </Text>
      </View>
      <If when={open()}>
        <BottomSheet title={t().project.contextLabel} closeLabel={t().common.close} onClose={() => open.set(false)} testID="context-sheet">
          <ContextFigures reading={r} />
        </BottomSheet>
      </If>
    </View>
  );
}

function ContextFigures(props: { reading: Reading }) {
  const t = () => copy().project;
  const r = props.reading;
  const tokens = (n: number) => t().contextTokens(formatTokens(n));
  const used = () => r.ctx()?.used ?? 0;
  const limit = () => r.ctx()?.limit ?? null;
  const model = () => r.ctx()?.model ?? null;
  /** A figure's row. Its words are read where they are drawn: a run that reports again while the sheet is up changes them in place. */
  const row = (testID: string, name: () => string, value: () => string) => (
    <View testID={testID} class="flex-row items-center justify-between gap-3 min-h-[44px] px-3">
      <Text class="text-[15px] text-ink-muted">{name()}</Text>
      <Text class="shrink min-w-0 text-[15px] font-medium text-ink tabular-nums text-right line-clamp-1">{value()}</Text>
    </View>
  );
  return (
    <View testID="context-figures" class="gap-2 pt-1">
      <View class="self-center w-[88px] h-[88px] items-center justify-center" accessible={false}>
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, width: 88, height: 88 }}
          draw={(cx) => {
            const p = r.percent();
            drawRing(cx, {
              box: 88,
              view: 88,
              radius: 36,
              width: 7,
              used: p !== null ? usageUsed(p) : null,
              color: levelColor(r.level(), "ink-secondary"),
              track: token("line"),
              dashed: p === null,
            });
          }}
        />
        <Text testID="context-sheet-short" class={`text-[18px] font-semibold tabular-nums ${SHEET_TONE[r.level()]}`}>
          {r.shortText()}
        </Text>
      </View>
      <View>
        {row("context-used", () => t().contextUsed, () => tokens(used()))}
        {row("context-window", () => t().contextWindow, () => {
          const l = limit();
          return l ? tokens(l) : t().contextWindowUnknown;
        })}
        <If when={limit() !== null}>{row("context-left", () => t().contextLeft, () => tokens(Math.max(0, (limit() ?? 0) - used())))}</If>
        <If when={model() !== null}>{row("context-model", () => t().contextModel, () => model() ?? "")}</If>
        <If when={limit() === null}>
          <Text testID="context-window-unknown" class="px-3 pt-1 text-[13px] text-ink-muted">
            {t().contextWindowUnknownNote}
          </Text>
        </If>
      </View>
    </View>
  );
}
