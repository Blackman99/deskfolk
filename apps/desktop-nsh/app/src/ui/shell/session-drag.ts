/**
 * A conversation pulled out of the sidebar, the rail or the pinned roster onto the workbench
 * (`Shell.svelte`'s `dragSession`). The rows report the drag (`sidebar/session-drag.ts`); this turns
 * it into the workbench's `dragIn(from, label, point)` and drives the session it returns. Until the
 * workbench has handed over its api (it is only mounted where the window is wide) there is no drag.
 */
import type { SessionSummary } from "@real-bot/protocol";
import type { IncomingTab } from "../../m/workbench/tab-drag.ts";
import type { SessionDragHandler } from "../sidebar/session-drag";
import type { DragSession } from "../workbench/workbench-drag";
import type { WorkbenchApi } from "../workbench/Workbench";

export function createSessionDrag(deps: { source: (sessionId: string) => IncomingTab; titleOf: (session: SessionSummary) => string }) {
  let api: WorkbenchApi | null = null;
  let session: DragSession | null = null;
  const drag: SessionDragHandler = (phase, point, row) => {
    if (phase === "start") {
      session?.end(true);
      session = api?.dragIn(deps.source(row.id), deps.titleOf(row), { x: point.x, y: point.y }) ?? null;
    } else if (phase === "move") {
      session?.move({ x: point.x, y: point.y });
    } else {
      session?.end(phase === "cancel");
      session = null;
    }
  };
  return { drag, setApi: (next: WorkbenchApi) => (api = next) };
}
