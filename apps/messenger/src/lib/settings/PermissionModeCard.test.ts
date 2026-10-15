import { expect, test } from "bun:test";
import type { Bot, PermissionMode } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { render } from "../test-render.ts";
import PermissionModeCard from "./PermissionModeCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bot = (name: string, permission_mode: PermissionMode | null, archived_at: string | null = null) =>
  ({ id: name, name, duties: "d", boundaries: "b", avatar: null, model: null, provider_id: null, thinking_level: null, permission_mode, archived_at, created_at: "t", updated_at: "t" }) as Bot;

function choose(host: HTMLElement, mode: PermissionMode): void {
  const input = host.querySelector<HTMLInputElement>(`input[value='${mode}']`)!;
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

test("four modes, the app's one checked and auto marked default; the Bots with their own are named (ADR 0092)", () => {
  const view = render(PermissionModeCard, {
    t, mode: "ask_first", bots: [bot("开发助手", "allow_all"), bot("审片员", null), bot("旧的", "read_only", "t")], onChoose: async () => true,
  });
  const rows = [...view.host.querySelectorAll("[data-testid='permission-modes'] label")];
  expect(rows.map((row) => row.querySelector(".permission-mode-label")?.textContent)).toEqual(["只读", "改动先问", "自动", "全部允许"]);
  expect(rows.map((row) => row.querySelector(".permission-mode-tag")?.textContent ?? null)).toEqual([null, null, "默认", null]);
  expect(view.host.querySelector<HTMLInputElement>("input:checked")?.value).toBe("ask_first");
  // Archived Bots are not listed.
  expect(view.host.querySelector("[data-testid='permission-overrides']")?.textContent).toBe("自己选了模式的 Bot：开发助手（全部允许）");
  expect(view.host.textContent).toContain(t.permissions.alwaysRefused);
  view.close();
});

test("picking a mode saves it; one that did not save says so", async () => {
  const chosen: PermissionMode[] = [];
  const view = render(PermissionModeCard, { t, mode: "auto", bots: [], onChoose: async (mode: PermissionMode) => { chosen.push(mode); return mode !== "read_only"; } });
  choose(view.host, "allow_all");
  await sleep(0);
  expect(chosen).toEqual(["allow_all"]);
  expect(view.host.querySelector(".field-error")).toBeNull();
  choose(view.host, "read_only");
  await sleep(0);
  expect(view.host.querySelector(".field-error")?.textContent).toBe(t.permissions.saveFailed);
  // Not saved: the card goes back to the app's mode (its prop, never updated here), not the one picked.
  expect(view.host.querySelector<HTMLInputElement>("input:checked")?.value).toBe("auto");
  expect(view.host.querySelector("[data-testid='permission-overrides']")).toBeNull();
  view.close();
});
