import { afterEach, expect, test } from "bun:test";
import {
  OPEN_KINDS,
  OPEN_PLACEMENT_DEFAULTS,
  OPEN_PLACEMENT_GROUPS,
  OPEN_PLACEMENTS,
  forgetFloatFrames,
  forgetOpenPlacements,
  loadFloatFrames,
  loadOpenPlacements,
  rememberFloatFrame,
  openKindOf,
  saveOpenPlacements,
} from "./open-placement.ts";
import { openPlacements } from "./open-placement-store.svelte.ts";

afterEach(() => {
  forgetOpenPlacements();
  forgetFloatFrames();
  openPlacements.reload();
});

test("every kind of window has a default, and every choice sits under one heading", () => {
  expect(Object.keys(OPEN_PLACEMENT_DEFAULTS).sort()).toEqual([...OPEN_KINDS].sort());
  expect(new Set(OPEN_PLACEMENTS).size).toBe(OPEN_PLACEMENTS.length);
  expect(OPEN_PLACEMENT_GROUPS.flatMap((row) => row.placements)).toEqual([...OPEN_PLACEMENTS]);
  for (const kind of OPEN_KINDS) expect(OPEN_PLACEMENTS).toContain(OPEN_PLACEMENT_DEFAULTS[kind]);
});

test("the defaults keep the conversation in view: its things beside it, terminals under it", () => {
  expect(OPEN_PLACEMENT_DEFAULTS).toEqual({
    chat: "replace",
    trace: "side-right",
    preview: "side-right",
    workspace: "side-right",
    terminal: "side-down",
    routines: "tab",
    spend: "tab",
    usage: "tab",
    roles: "tab",
    map: "side-right",
  });
});

test("only what differs from the defaults is kept, and it comes back as it was", () => {
  saveOpenPlacements({ ...OPEN_PLACEMENT_DEFAULTS, preview: "float", terminal: "tab" });
  expect(JSON.parse(window.localStorage.getItem("real-bot-open-placement")!)).toEqual({ preview: "float", terminal: "tab" });
  expect(loadOpenPlacements()).toEqual({ ...OPEN_PLACEMENT_DEFAULTS, preview: "float", terminal: "tab" });
  saveOpenPlacements({ ...OPEN_PLACEMENT_DEFAULTS });
  expect(window.localStorage.getItem("real-bot-open-placement")).toBeNull();
});

test("a kind or a choice this build does not know, or a broken value, falls back to the default", () => {
  window.localStorage.setItem("real-bot-open-placement", JSON.stringify({ preview: "sideways", spend: "float", hologram: "tab" }));
  expect(loadOpenPlacements()).toEqual({ ...OPEN_PLACEMENT_DEFAULTS, spend: "float" });
  window.localStorage.setItem("real-bot-open-placement", "{not json");
  expect(loadOpenPlacements()).toEqual(OPEN_PLACEMENT_DEFAULTS);
  window.localStorage.setItem("real-bot-open-placement", "[\"float\"]");
  expect(loadOpenPlacements()).toEqual(OPEN_PLACEMENT_DEFAULTS);
});

test("a job is one kind, whatever a saved tab asked to open on; a Bot↔Bot direct is no kind (it opens in a popup)", () => {
  expect(OPEN_KINDS).not.toContain("bot-bot");
  expect(openKindOf({ kind: "chat", sessionId: "g" })).toBe("chat");
  expect(openKindOf({ kind: "trace", sessionId: "g", taskId: null })).toBe("trace");
  expect(openKindOf({ kind: "trace", sessionId: "g", taskId: null, view: "board" })).toBe("trace");
  expect(openKindOf({ kind: "trace", sessionId: "g", taskId: null, view: "spec" })).toBe("trace");
  expect(openKindOf({ kind: "terminal", terminalId: null })).toBe("terminal");
  expect(openKindOf({ kind: "preview", sessionId: "g", relpath: "a", attachmentId: null })).toBe("preview");
});

test("a Bot↔Bot direct kept from an older build falls back to nothing", () => {
  window.localStorage.setItem("real-bot-open-placement", JSON.stringify({ "bot-bot": "float" }));
  expect(loadOpenPlacements()).toEqual(OPEN_PLACEMENT_DEFAULTS);
});

test("the shared value is what the next open reads, and back to defaults clears it", () => {
  expect(openPlacements.changed).toBe(false);
  openPlacements.set("preview", "float");
  expect(openPlacements.get("preview")).toBe("float");
  expect(openPlacements.isDefault("preview")).toBe(false);
  expect(openPlacements.changed).toBe(true);
  expect(loadOpenPlacements().preview).toBe("float");
  openPlacements.reset();
  expect(openPlacements.get("preview")).toBe("side-right");
  expect(window.localStorage.getItem("real-bot-open-placement")).toBeNull();
});

test("where a kind last floated is kept per kind, and a broken or unknown entry is dropped", () => {
  expect(loadFloatFrames()).toEqual({});
  rememberFloatFrame("preview", { x: 120, y: 80, width: 640, height: 480 });
  rememberFloatFrame("spend", { x: 10, y: 20, width: 300, height: 200 });
  rememberFloatFrame("preview", { x: 200, y: 90, width: 600, height: 500 });
  expect(loadFloatFrames()).toEqual({
    preview: { x: 200, y: 90, width: 600, height: 500 },
    spend: { x: 10, y: 20, width: 300, height: 200 },
  });
  window.localStorage.setItem(
    "real-bot-open-float-frames",
    JSON.stringify({ preview: { x: 1, y: 2, width: 0, height: 5 }, spend: { x: "a" }, hologram: { x: 1, y: 1, width: 9, height: 9 }, terminal: { x: 5, y: 6, width: 400, height: 300 } }),
  );
  expect(loadFloatFrames()).toEqual({ terminal: { x: 5, y: 6, width: 400, height: 300 } });
  window.localStorage.setItem("real-bot-open-float-frames", "nope");
  expect(loadFloatFrames()).toEqual({});
});

test("back to defaults forgets where windows last floated as well", () => {
  rememberFloatFrame("preview", { x: 120, y: 80, width: 640, height: 480 });
  openPlacements.set("preview", "float");
  openPlacements.reset();
  expect(loadFloatFrames()).toEqual({});
});

