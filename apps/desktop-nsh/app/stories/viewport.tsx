/**
 * How often a reader of the window's breakpoints runs again (`platform/viewport.ts`): one effect on
 * `narrowWindow()`, one on a width `matchMedia` query, one on a query that is not about the width.
 * A resize that crosses no breakpoint must run none of them again.
 */
import { effect, signal, Text, View } from "nsh";
import { narrowWindow } from "../src/ui/Modal";

/** The shim `platform/globals.ts` installs; NSH has no `window`, so it is a global of its own. */
const matchMedia = (query: string) => (globalThis as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia(query);

export default function ViewportStory() {
  const narrowRuns = signal(0);
  const widthQueryRuns = signal(0);
  const motionQueryRuns = signal(0);
  let n = 0;
  let w = 0;
  let m = 0;
  effect(() => {
    narrowWindow();
    narrowRuns.set(++n);
  });
  effect(() => {
    void matchMedia("(max-width: 720px)").matches;
    widthQueryRuns.set(++w);
  });
  effect(() => {
    void matchMedia("(prefers-reduced-motion: reduce)").matches;
    motionQueryRuns.set(++m);
  });
  return (
    <View class="flex-1 p-4">
      <Text testID="viewport-runs">{`narrow:${narrowRuns()} width:${widthQueryRuns()} motion:${motionQueryRuns()} phone:${narrowWindow() ? 1 : 0}`}</Text>
    </View>
  );
}
