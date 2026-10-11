import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { emptyPlaybookDiff, resolvePlaybook, type BuiltinPlaybookId, type Playbook } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aGroup, fakeRuntime } from "../test-fixtures.ts";
import { render } from "../test-render.ts";
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

test("where the Mac has no engines, there is nothing to choose", async () => {
  const runtime = fakeRuntime();
  runtime.client = { listPlaybooks: async () => { throw new Error("404"); } } as never;
  const view = render(PlaybookPicker, { runtime, sessionId: "s1", t });
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync();
  expect(view.host.querySelector("[data-playbook-picker]")).toBeNull();
  view.close();
});
