import { expect, test } from "bun:test";
import type { SharedSkill, Skill } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import SharedSkillsCard from "./SharedSkillsCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const skill = (id: string, name: string, body = ""): Skill => ({ id, bot_id: "b1", name, description: "", body, uses: [], enabled: true, created_at: "", updated_at: "" }) as unknown as Skill;
const copyOf = (over: Partial<SharedSkill>): SharedSkill => ({ id: "s1", name: "镜头交界连贯性审查", description: "相邻两镜", body: "", uses: [], source_skill_id: "k1",
  source_bot_id: "b1", source_bot_name: "审片员", enabled: true, source_changed: false, confirmed_at: "", created_at: "", updated_at: "", ...over });

function fakeApi(items: SharedSkill[], available = true) {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    api: {
      listSharedSkills: async () => ({ items, available }),
      shareSkill: async (...args: unknown[]) => { calls.push(["share", args]); return copyOf({}); },
      setSharedSkillEnabled: async (...args: unknown[]) => { calls.push(["enabled", args]); return copyOf({}); },
      unshareSkill: async (...args: unknown[]) => { calls.push(["unshare", args]); },
    },
  };
}

test("nothing shows below level 8", async () => {
  const { api } = fakeApi([], false);
  const view = render(SharedSkillsCard, { api, botId: "b1", skills: [skill("k1", "审查")], t });
  await sleep(0);
  expect(view.host.querySelector(".shared-skills-card")).toBeNull();
  view.close();
});

test("sharing asks once more before every Bot sees the skill", async () => {
  const { api, calls } = fakeApi([]);
  const view = render(SharedSkillsCard, { api, botId: "b1", skills: [skill("k1", "镜头交界连贯性审查")], t });
  await sleep(0);
  click(buttonByText(view.host, t.sharedSkills.share));
  expect(calls).toEqual([]);
  expect(view.host.textContent).toContain(t.sharedSkills.confirmHint);
  click(buttonByText(view.host, t.sharedSkills.confirm));
  await sleep(0);
  expect(calls).toEqual([["share", ["k1"]]]);
  view.close();
});

test("a shared skill changed since shows what it would share before you update it; one from another Bot can be turned off or unshared", async () => {
  const { api, calls } = fakeApi([copyOf({ source_changed: true }), copyOf({ id: "s2", name: "字幕校对", source_skill_id: "k9", source_bot_id: "b2", source_bot_name: "字幕校对师" })]);
  const view = render(SharedSkillsCard, { api, botId: "b1", skills: [skill("k1", "镜头交界连贯性审查", "新的做法：用户喜欢暖色")], t });
  await sleep(0);
  const own = view.host.querySelector("[data-skill='k1']")!;
  expect(own.textContent).toContain(t.sharedSkills.changedSince);
  click(buttonByText(view.host, t.sharedSkills.update));
  expect(calls).toEqual([]);
  expect(own.querySelector(".shared-skill-body")?.textContent).toBe("新的做法：用户喜欢暖色");
  click(buttonByText(view.host, t.sharedSkills.confirmUpdate));
  await sleep(0);
  const other = view.host.querySelector("[data-shared='s2']")!;
  expect(other.textContent).toContain(t.sharedSkills.from("字幕校对师"));
  click([...other.querySelectorAll("button")].find((button) => button.textContent?.trim() === t.sharedSkills.turnOff)!);
  await sleep(0);
  expect(calls).toEqual([["share", ["k1"]], ["enabled", ["s2", false]]]);
  view.close();
});

test("the owner's row says whether its copy is on, and turns it off or on", async () => {
  const { api, calls } = fakeApi([copyOf({ enabled: false })]);
  const view = render(SharedSkillsCard, { api, botId: "b1", skills: [skill("k1", "镜头交界连贯性审查")], t });
  await sleep(0);
  const own = view.host.querySelector("[data-skill='k1']")!;
  expect(own.textContent).toContain(t.sharedSkills.sharedOff);
  click([...own.querySelectorAll("button")].find((button) => button.textContent?.trim() === t.sharedSkills.turnOn)!);
  await sleep(0);
  expect(calls).toEqual([["enabled", ["s1", true]]]);
  view.close();
});
