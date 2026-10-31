import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { emptyPlaybookDiff, resolvePlaybook, type BuiltinPlaybookId, type Playbook } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aGroup, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import PlaybookPicker from "./PlaybookPicker.svelte";

const t = copyFor("zh");
const engine = (id: BuiltinPlaybookId): Playbook => ({ id, builtin: true, base_id: id, name: null, revision: 0, revision_id: null, diff: emptyPlaybookDiff(), resolved: resolvePlaybook(id, null), updated_at: null });

test("a conversation follows the default engine until one is chosen for it; the Mac's answer is what shows", async () => {
  const group = { ...aGroup(), playbook_id: null };
  const runtime = fakeRuntime({ sessions: [group] } as never);
  const chosen: Array<[string, string | null]> = [];
  runtime.client = {
    listPlaybooks: async () => ({ default_id: "general", items: [engine("general"), engine("video"), engine("coding")] }),
    setSessionPlaybook: async (sessionId: string, playbookId: string | null) => { chosen.push([sessionId, playbookId]); return {}; },
  } as never;
  const view = render(PlaybookPicker, { runtime, sessionId: group.id, t });
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync();
  const select = view.host.querySelector("[data-playbook-picker] .select-trigger, [data-playbook-picker] button");
  expect(select?.textContent).toContain("跟默认（通用）");
  view.host.querySelector<HTMLButtonElement>("[data-playbook-picker] button")!.click();
  flushSync();
  const video = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((option) => option.textContent?.includes("视频"));
  video!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(chosen).toEqual([[group.id, "video"]]);
  view.close();
});

/** The picker on a group with `open` jobs, and what it was asked and told to do. */
async function picking(open: number) {
  const group = { ...aGroup(), playbook_id: null };
  const runtime = fakeRuntime({ sessions: [group] } as never);
  const chosen: Array<string | null> = [];
  const asked: Array<string | null | undefined> = [];
  runtime.client = {
    listPlaybooks: async () => ({ default_id: "general", items: [engine("general"), engine("plain")] }),
    playbookImpact: async (sessionId?: string | null) => { asked.push(sessionId); return { sessions: 1, open_jobs: open }; },
    setSessionPlaybook: async (_sessionId: string, playbookId: string | null) => { chosen.push(playbookId); return {}; },
  } as never;
  const view = render(PlaybookPicker, { runtime, sessionId: group.id, t });
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync();
  view.host.querySelector<HTMLButtonElement>("[data-playbook-picker] button")!.click();
  flushSync();
  [...document.querySelectorAll<HTMLElement>("[role='option']")].find((option) => option.textContent?.includes(t.playbooks.builtin.plain!))!.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  flushSync();
  return { group, view, chosen, asked };
}

test("moving a conversation with open jobs to an engine with none says so first", async () => {
  const { group, view, chosen, asked } = await picking(2);
  expect(asked).toEqual([group.id]);
  expect(chosen).toEqual([]);
  const dialog = document.querySelector("dialog.confirm-backdrop");
  expect(dialog?.textContent).toContain(t.playbooks.moveBody(2));
  click(dialog!.querySelector<HTMLButtonElement>(".modal-foot button.deny"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  flushSync();
  expect(chosen).toEqual(["plain"]);
  expect(document.querySelector("dialog.confirm-backdrop")).toBeNull();
  view.close();
});

test("with none open it just moves", async () => {
  const { view, chosen } = await picking(0);
  expect(document.querySelector("dialog.confirm-backdrop")).toBeNull();
  expect(chosen).toEqual(["plain"]);
  view.close();
});

test("where the Mac has no engines, there is nothing to choose", async () => {
  const runtime = fakeRuntime();
  runtime.client = { listPlaybooks: async () => { throw new Error("404"); } } as never;
  const view = render(PlaybookPicker, { runtime, sessionId: "s1", t });
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync();
  expect(view.host.querySelector("[data-playbook-picker]")).toBeNull();
  view.close();
});
