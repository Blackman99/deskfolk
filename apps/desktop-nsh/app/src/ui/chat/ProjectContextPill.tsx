/**
 * Context window usage indicator in a project session's composer toolbar: draws a small ring
 * showing how full the model's context window is (with percentage beside it when room allows),
 * or a dashed ring with the formatted token count when the model's window size is unknown.
 * Hidden until the session has reported usage, and cleared when the session is cleared or
 * started over.
 */
import { Canvas, Text, token, View } from "nsh";
import type { ProjectContextUsage } from "@real-bot/protocol";
import { usageUsed } from "../../m/usage/usage.ts";
import { tip } from "../tip";
import { drawRing, levelColor } from "../usage/ring";
import { contextReading } from "./project-context";

const TEXT_TONE = { normal: "text-ink-muted", warn: "text-warn-text", danger: "text-danger" } as const;

export function ProjectContextPill(props: {
  context: ProjectContextUsage | null | undefined;
  /** Narrow composer width: keep the ring alone. */
  compact?: boolean;
}) {
  const { ctx, percent, level, label, shortText } = contextReading(() => props.context);

  return (
    <If when={ctx()}>
      <View
        testID="project-context"
        tooltip={tip(label())}
        accessibilityLabel={label()}
        class="select-none shrink-0 flex-row items-center gap-[5px] h-[28px] px-[6px] rounded-full"
      >
        <Canvas
          testID="project-context-ring"
          accessible={false}
          style={{ width: 16, height: 16 }}
          draw={(cx) => {
            const p = percent();
            drawRing(cx, {
              box: 16,
              view: 24,
              radius: 9,
              width: 3,
              used: p !== null ? usageUsed(p) : null,
              color: levelColor(level(), "ink-secondary"),
              track: token("line"),
              dashed: p === null,
            });
          }}
        />
        <If when={!props.compact}>
          <Text testID="project-context-text" class={`text-[12px] font-medium tabular-nums ${TEXT_TONE[level()]}`}>
            {shortText()}
          </Text>
        </If>
      </View>
    </If>
  );
}
