import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import {
  dangerCopy,
  shouldDropConfirm,
  visibleDangerKind,
  type DangerConfirmState,
} from "./danger-confirm.ts";

const group = { kind: "group" as const };
const direct = { kind: "direct" as const };
const sessions = new Map<string, { kind: string }>([
  ["g1", group],
  ["d1", direct],
]);
const botIds = new Set(["writer"]);
const ctx = {
  selectedId: "d1" as string | null,
  sessions,
  botIds,
};

test("a group confirm stays up for the named session even when another chat is open", () => {
  const confirm: DangerConfirmState = { kind: "group", sessionId: "g1", source: "menu" };
  expect(visibleDangerKind(confirm, ctx)).toBe("group");
});

test("a group confirm hides once that session is gone", () => {
  const confirm: DangerConfirmState = { kind: "group", sessionId: "g1" };
  expect(visibleDangerKind(confirm, { ...ctx, sessions: new Map([["d1", direct]]) })).toBeNull();
});

test("a group confirm without a named session follows the open group", () => {
  expect(
    visibleDangerKind({ kind: "group" }, { ...ctx, selectedId: "g1" }),
  ).toBe("group");
  expect(visibleDangerKind({ kind: "group" }, ctx)).toBeNull();
});

test("a history confirm follows the named session, not the open one", () => {
  const confirm: DangerConfirmState = { kind: "history", sessionId: "g1", source: "menu" };
  expect(visibleDangerKind(confirm, ctx)).toBe("history");
  expect(
    visibleDangerKind(confirm, { ...ctx, sessions: new Map([["d1", direct]]) }),
  ).toBeNull();
});

test("a history confirm without a named session follows the open session", () => {
  expect(visibleDangerKind({ kind: "history" }, ctx)).toBe("history");
  expect(visibleDangerKind({ kind: "history" }, { ...ctx, selectedId: null })).toBeNull();
});

test("a bot confirm hides after that Bot leaves the roster", () => {
  expect(visibleDangerKind({ kind: "bot", botId: "writer" }, ctx)).toBe("bot");
  expect(visibleDangerKind({ kind: "bot", botId: "writer" }, { ...ctx, botIds: new Set() })).toBeNull();
});

test("closing the session drawer does not drop a sidebar-menu confirm", () => {
  expect(
    shouldDropConfirm("session-settings-closed", { kind: "group", source: "menu" }),
  ).toBe(false);
  expect(
    shouldDropConfirm("session-settings-closed", { kind: "bot", source: "menu" }),
  ).toBe(false);
  expect(
    shouldDropConfirm("session-changed", { kind: "history", source: "menu" }),
  ).toBe(false);
});

test("closing the session drawer still drops a drawer confirm", () => {
  expect(
    shouldDropConfirm("session-settings-closed", { kind: "group", source: "drawer" }),
  ).toBe(true);
  expect(shouldDropConfirm("session-settings-closed", { kind: "bot" })).toBe(true);
  expect(shouldDropConfirm("session-changed", { kind: "history", source: "drawer" })).toBe(true);
  expect(shouldDropConfirm("no-session", { kind: "group", source: "drawer" })).toBe(true);
  expect(shouldDropConfirm("settings-closed", { kind: "provider", source: "settings" })).toBe(true);
  expect(shouldDropConfirm("settings-closed", { kind: "group", source: "drawer" })).toBe(false);
});

test("dangerCopy matches the session delete / clear strings", () => {
  const t = copyFor("zh");
  expect(dangerCopy("group", t)).toEqual({
    title: t.detail.deleteGroup,
    body: t.detail.deleteGroupBody,
    confirm: t.detail.confirmDeleteGroup,
    cancel: t.detail.cancel,
  });
  expect(dangerCopy("bot", t).confirm).toBe(t.sidebar.confirmDelete);
  expect(dangerCopy("history", t).confirm).toBe(t.detail.confirmClearHistory);
});
