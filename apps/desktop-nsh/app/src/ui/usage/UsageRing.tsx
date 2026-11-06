/** A small ring as full as what is used of a window, in its level's colour (`UsageRing.svelte`). */
import { Canvas, token } from "nsh";
import { usageLevel, usageUsed } from "../../m/usage/usage.ts";
import { drawRing, levelColor } from "./ring";

export function UsageRing(props: {
  /** How much of the window is used, 0–100. */
  percent: number;
  size?: number;
  testID?: string;
}) {
  const size = () => props.size ?? 14;
  return (
    <Canvas
      testID={props.testID}
      accessible={false}
      style={{ width: size(), height: size(), flexShrink: 0 }}
      draw={(cx) =>
        drawRing(cx, {
          box: size(),
          view: 12,
          radius: 4.25,
          width: 1.75,
          used: usageUsed(props.percent),
          color: levelColor(usageLevel(props.percent)),
          track: token("line"),
        })
      }
    />
  );
}
