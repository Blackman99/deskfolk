import { expect, test } from "nsh/test";
import type { GestureResponderEvent, ResponderGestureState, ViewRef } from "nsh";
import { pressWorkspacePaths, workspaceDrag, workspaceDropTarget, type WorkspaceDragItem } from "./workspace-drag";

// The screen tests' `dragAndHold` is a finger, and a finger drags no row, so the mouse's drag is
// driven here, through the row's responder handlers, with events of our own (`PanResponder` takes
// them, as React Native's does).

type Pointer = "mouse" | "pen" | "touch";
let clock = 0;
/** One finger, the mouse or a pen at (x, y), a frame after the last event. */
function at(x: number, y: number, pointerType: Pointer): GestureResponderEvent {
  clock += 16;
  const point = { identifier: 1, locationX: x, locationY: y, pageX: x, pageY: y, target: 0, timestamp: clock, pointerType, pressure: 0.5, tiltX: 0, tiltY: 0 };
  const event = { ...point, touches: [point], changedTouches: [point], modifiers: {}, stopPropagation() {} };
  return { ...event, nativeEvent: event } as unknown as GestureResponderEvent;
}
const NO_STATE = undefined as unknown as ResponderGestureState;

const items: WorkspaceDragItem[] = [{ path: "docs/notes.md", isDir: false }];
function row(hosted = false) {
  const handlers = pressWorkspacePaths({ items: () => items, label: (picked) => picked[0]!.path.split("/").pop() ?? "" }, hosted).panHandlers;
  return {
    down: (e: GestureResponderEvent) => handlers.onStartShouldSetResponderCapture!(e, NO_STATE),
    /** Whether the row takes the move as a drag. */
    moves: (e: GestureResponderEvent) => handlers.onMoveShouldSetResponder!(e, NO_STATE),
    grant: (e: GestureResponderEvent) => handlers.onResponderGrant!(e),
    move: (e: GestureResponderEvent) => handlers.onResponderMove!(e),
    release: (e: GestureResponderEvent) => handlers.onResponderRelease!(e),
  };
}

test("the mouse drags a row once it passes the threshold, and letting go over a target hands the paths over", async () => {
  const dropped: string[] = [];
  const box = { measure: async () => ({ bounds: { origin: { x: 0, y: 0 }, size: { width: 400, height: 400 } }, pagePosition: { x: 200, y: 0 } }) };
  const off = workspaceDropTarget(() => box as unknown as ViewRef, { accepts: () => true, drop: (taken) => void dropped.push(...taken.map((item) => item.path)) });
  try {
    const r = row();
    r.down(at(20, 20, "mouse"));
    expect(r.moves(at(23, 21, "mouse"))).toBe(false);
    expect(r.moves(at(40, 22, "mouse"))).toBe(true);
    r.grant(at(40, 22, "mouse"));
    expect(workspaceDrag.current?.label).toBe("notes.md");
    expect(workspaceDrag.current?.items).toEqual(items);
    r.move(at(300, 60, "mouse"));
    r.release(at(300, 60, "mouse"));
    expect(workspaceDrag.current).toBe(null);
    await new Promise((done) => setTimeout(done, 0));
    expect(dropped).toEqual(["docs/notes.md"]);
  } finally {
    off();
  }
});

test("a pen drags a row as the mouse does", () => {
  const r = row();
  r.down(at(20, 20, "pen"));
  expect(r.moves(at(40, 20, "pen"))).toBe(true);
});

test("a finger never drags a row, whichever way it goes: it scrolls the tree", () => {
  const r = row();
  r.down(at(20, 300, "touch"));
  expect(r.moves(at(21, 260, "touch"))).toBe(false);
  expect(r.moves(at(22, 100, "touch"))).toBe(false);
  const sideways = row();
  sideways.down(at(20, 300, "touch"));
  expect(sideways.moves(at(200, 302, "touch"))).toBe(false);
  expect(workspaceDrag.current).toBe(null);
});

test("on the phone's page no row drags, whatever presses it: the web's touches say no pointer, and no composer is beside the tree", () => {
  for (const pointer of ["mouse", "pen", "touch"] as const) {
    const r = row(true);
    r.down(at(20, 300, pointer));
    expect(r.moves(at(22, 100, pointer))).toBe(false);
  }
  // As the web runtime sends a finger: no `pointerType` at all.
  const r = row(true);
  const bare = (x: number, y: number) => ({ ...at(x, y, "touch"), pointerType: undefined }) as unknown as GestureResponderEvent;
  r.down(bare(20, 300));
  expect(r.moves(bare(22, 100))).toBe(false);
});
