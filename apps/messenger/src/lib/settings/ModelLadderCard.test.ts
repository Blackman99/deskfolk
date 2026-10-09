import { expect, test } from "bun:test";
import type { ModelLadderRung, Provider } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import ModelLadderCard from "./ModelLadderCard.svelte";
import { ModelLadder, type ModelLadderApi } from "./model-ladder.svelte.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const providers = [
  { id: "p1", name: "Default", models: ["light", "mid"] },
  { id: "p2", name: "Other", models: ["heavy"] },
] as unknown as Provider[];

function fakeApi(items: ModelLadderRung[], opts: { available?: boolean; fail?: boolean } = {}) {
  const saved: ModelLadderRung[][] = [];
  return {
    saved,
    api: {
      modelLadder: async () => ({ items, available: opts.available ?? true }),
      setModelLadder: async (next: ModelLadderRung[]) => {
        saved.push(next);
        if (opts.fail) throw new Error("409");
        return { items: next, available: true };
      },
    },
  };
}

/** The card as Models shows it: the ladder read by the page that holds it. */
function card(api: ModelLadderApi) {
  const ladder = new ModelLadder(() => api);
  void ladder.load();
  return render(ModelLadderCard, { ladder, providers, t });
}

const names = (host: HTMLElement) => [...host.querySelectorAll(".ladder-name")].map((el) => el.textContent);

test("nothing shows below level 7", async () => {
  const { api } = fakeApi([], { available: false });
  const view = card(api);
  await sleep(0);
  expect(view.host.querySelector("[data-model-ladder]")).toBeNull();
  view.close();
});

test("rungs read weaker to stronger, move and come off, each change saved in your order", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }, { provider_id: "p2", model: "heavy" }]);
  const view = card(api);
  await sleep(0);
  expect(names(view.host)).toEqual(["light · Default", "mid · Default", "heavy · Other"]);
  expect(view.host.querySelector(`[aria-label="${t.modelLadder.up("light")}"]`)?.hasAttribute("disabled")).toBe(true);
  click(view.host.querySelector(`[aria-label="${t.modelLadder.down("light")}"]`)!);
  await sleep(0);
  expect(names(view.host)).toEqual(["mid · Default", "light · Default", "heavy · Other"]);
  click(view.host.querySelector(`[aria-label="${t.modelLadder.remove("heavy")}"]`)!);
  await sleep(0);
  expect(saved).toEqual([
    [{ provider_id: "p1", model: "mid" }, { provider_id: "p1", model: "light" }, { provider_id: "p2", model: "heavy" }],
    [{ provider_id: "p1", model: "mid" }, { provider_id: "p1", model: "light" }],
  ]);
  view.close();
});

test("a model is added at the strong end from what is listed and not on it yet", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }]);
  const view = card(api);
  await sleep(0);
  click(view.host.querySelector(".ladder-add .real-select-trigger")!);
  await sleep(0);
  const options = [...view.host.querySelectorAll(".real-select-option")];
  expect(options.map((el) => el.textContent?.trim())).toEqual(["mid · Default", "heavy · Other"]);
  click(options[1]!);
  await sleep(0);
  expect(saved).toEqual([[{ provider_id: "p1", model: "light" }, { provider_id: "p2", model: "heavy" }]]);
  view.close();
});

test("a change that is not saved goes back, and says so", async () => {
  const { api } = fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }], { fail: true });
  const view = card(api);
  await sleep(0);
  click(view.host.querySelector(`[aria-label="${t.modelLadder.remove("light")}"]`)!);
  await sleep(0);
  expect(names(view.host)).toEqual(["light · Default", "mid · Default"]);
  expect(view.host.querySelector(".ladder-error")?.textContent).toBe(t.modelLadder.failed);
  view.close();
});
