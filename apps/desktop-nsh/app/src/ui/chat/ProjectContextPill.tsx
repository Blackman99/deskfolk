/**
 * Context window usage indicator in a project session's composer toolbar: draws a small ring
 * showing how full the model's context window is (with percentage beside it when room allows),
 * or a dashed ring with the formatted token count when the model's window size is unknown.
 * Hidden until the session has reported usage, and cleared when the session is cleared or
 * started over.
 */
import { Canvas, Text, token, View } from "nsh";
import type { ProjectContextUsage } from "@real-bot/protocol";
import { formatTokens } from "../../m/spend-format.ts";
import { usageLevel, usageUsed, usageUsedText } from "../../m/usage/usage.ts";
import { copy } from "../../runtime";
import { tip } from "../tip";
import { drawRing, levelColor } from "../usage/ring";

const TEXT_TONE = { normal: "text-ink-muted", warn: "text-warn-text", danger: "text-danger" } as const;

export function ProjectContextPill(props: {
  context: ProjectContextUsage | null | undefined;
  /** Narrow composer width: keep the ring alone. */
  compact?: boolean;
}) {
  const t = () => copy();
  const ctx = () => {
    const c = props.context;
    return c && c.used > 0 ? c : null;
  };
  const percent = () => {
    const c = ctx();
    return c && c.limit && c.limit > 0 ? (c.used / c.limit) * 100 : null;
  };
  const level = () => {
    const p = percent();
    return p !== null ? usageLevel(p) : "normal";
  };
  const label = () => {
    const c = ctx();
    if (!c) return "";
    const p = percent();
    if (p !== null && c.limit) return t().project.contextHint(formatTokens(c.used), formatTokens(c.limit), usageUsedText(p));
    return t().project.contextUsedOnlyHint(formatTokens(c.used));
  };
  const shortText = () => {
    const c = ctx();
    if (!c) return "";
    const p = percent();
    return p !== null ? usageUsedText(p) : formatTokens(c.used);
  };

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
