import { afterEach, expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import { OPEN_KINDS, forgetOpenPlacements } from "../workbench/open-placement.ts";
import { openPlacements } from "../workbench/open-placement-store.svelte.ts";
import OpenPlacementCard from "./OpenPlacementCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  forgetOpenPlacements();
  openPlacements.reload();
});

async function choose(host: HTMLElement, kind: string, label: string): Promise<void> {
  const row = host.querySelector(`#open-placement-${kind}`)!.closest(".settings-row")!;
  click(row.querySelector(".real-select-trigger"));
  await sleep(0);
  const option = [...document.querySelectorAll(".real-select-option")].find((el) => el.textContent?.trim() === label);
  expect(option).toBeDefined();
  click(option!);
  await sleep(0);
}

test("every kind of window is a row with where it opens, the defaults first", () => {
  const { host, close } = render(OpenPlacementCard, { t });
  expect([...host.querySelectorAll(".settings-row-title")].map((el) => el.textContent)).toEqual(
    OPEN_KINDS.map((kind) => t.openPlacement.kinds[kind].name),
  );
  const shown = [...host.querySelectorAll(".real-select-trigger")].map((el) => el.textContent?.replace(/\s+/g, " ").trim());
  expect(shown).toEqual([
    t.openPlacement.placements.replace,
    t.openPlacement.placements["side-right"],
    t.openPlacement.placements["side-right"],
    t.openPlacement.placements["side-right"],
    t.openPlacement.placements["side-right"],
    t.openPlacement.placements["side-right"],
    t.openPlacement.placements["side-right"],
    t.openPlacement.placements["side-down"],
    t.openPlacement.placements.tab,
    t.openPlacement.placements.tab,
  ]);
  expect(host.querySelector(".open-placement-changed")).toBeNull();
  expect((host.querySelector(".open-placement-reset") as HTMLButtonElement).disabled).toBe(true);
  close();
});

test("the choices come under their four headings", async () => {
  const { host, close } = render(OpenPlacementCard, { t });
  click(host.querySelector("#open-placement-preview")!.closest(".settings-row")!.querySelector(".real-select-trigger"));
  await sleep(0);
  const text = document.body.textContent ?? "";
  for (const heading of Object.values(t.openPlacement.groups)) expect(text).toContain(heading);
  expect(document.querySelectorAll(".real-select-option")).toHaveLength(12);
  close();
});

test("a choice is kept on this machine, marked as changed, and back to defaults undoes it", async () => {
  const { host, close } = render(OpenPlacementCard, { t });
  await choose(host, "preview", t.openPlacement.placements.float);
  expect(openPlacements.get("preview")).toBe("float");
  expect(JSON.parse(window.localStorage.getItem("real-bot-open-placement")!)).toEqual({ preview: "float" });
  expect(host.querySelectorAll(".open-placement-changed")).toHaveLength(1);
  // On the name's line, after the name — not under the description, where it would make the row taller.
  const line = host.querySelector(".open-placement-changed")!.parentElement!;
  expect(line.classList.contains("settings-row-title-line")).toBe(true);
  expect(line.querySelector(".settings-row-title")?.textContent).toBe(t.openPlacement.kinds.preview.name);
  const reset = host.querySelector(".open-placement-reset") as HTMLButtonElement;
  expect(reset.disabled).toBe(false);
  click(reset);
  await sleep(0);
  expect(openPlacements.get("preview")).toBe("side-right");
  expect(window.localStorage.getItem("real-bot-open-placement")).toBeNull();
  expect(host.querySelector(".open-placement-changed")).toBeNull();
  close();
});
