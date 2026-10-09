import { afterEach, expect, test } from "bun:test";
import {
  OPEN_KINDS,
  OPEN_PLACEMENT_DEFAULTS,
  OPEN_PLACEMENT_GROUPS,
  OPEN_PLACEMENTS,
  forgetOpenPlacements,
  loadOpenPlacements,
  openKindOf,
  saveOpenPlacements,
} from "./open-placement.ts";
import { openPlacements } from "./open-placement-store.svelte.ts";

afterEach(() => {
  forgetOpenPlacements();
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
    "bot-bot": "side-right",
    trace: "side-right",
    board: "side-right",
    spec: "side-right",
    preview: "side-right",
    workspace: "side-right",
    terminal: "side-down",
    routines: "tab",
    spend: "tab",
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

test("a Bot↔Bot direct and each of a job's views are kinds of their own", () => {
  const groupOf = (id: string) => (id === "bb" ? "bot-bot" : id === "g" ? "group" : null);
  expect(openKindOf({ kind: "chat", sessionId: "bb" }, groupOf)).toBe("bot-bot");
  expect(openKindOf({ kind: "chat", sessionId: "g" }, groupOf)).toBe("chat");
  expect(openKindOf({ kind: "chat", sessionId: "gone" }, groupOf)).toBe("chat");
  expect(openKindOf({ kind: "trace", sessionId: "g", taskId: null }, groupOf)).toBe("trace");
  expect(openKindOf({ kind: "trace", sessionId: "g", taskId: null, view: "board" }, groupOf)).toBe("board");
  expect(openKindOf({ kind: "trace", sessionId: "g", taskId: null, view: "spec" }, groupOf)).toBe("spec");
  expect(openKindOf({ kind: "terminal", terminalId: null }, groupOf)).toBe("terminal");
  expect(openKindOf({ kind: "preview", sessionId: "g", relpath: "a", attachmentId: null }, groupOf)).toBe("preview");
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
