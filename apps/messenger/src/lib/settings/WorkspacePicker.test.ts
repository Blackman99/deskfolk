import { expect, test } from "bun:test";
import { settle } from "../test-async.ts";
import { click, render } from "../test-render.ts";
import WorkspacePicker from "./WorkspacePicker.svelte";

type Page = { path: string; parent: string | null; truncated: boolean; items: Array<{ name: string; path: string; kind: "file" | "dir" }> };

function open(pages: Record<string, Page | Error>, extra: Record<string, unknown> = {}) {
  let chosen = "";
  const api = { hostTree: async (path: string) => { const page = pages[path]; if (!page || page instanceof Error) throw page ?? new Error("missing"); return page; } };
  const view = render(WorkspacePicker, {
    path: "", chooseLabel: "Choose", changeLabel: "Change", emptyLabel: "None yet", unavailableLabel: "Could not read it",
    dialogTitle: "Pick", remote: true, api, useLabel: "Use this folder", onChange: (next: string) => (chosen = next), ...extra,
  });
  return { ...view, chosen: () => chosen };
}

const home: Page = { path: "/Users/a", parent: "/Users", truncated: false, items: [{ name: "locked", path: "/Users/a/locked", kind: "dir" }, { name: "work", path: "/Users/a/work", kind: "dir" }] };
const work: Page = { path: "/Users/a/work", parent: "/Users/a", truncated: false, items: [] };

test("a folder that could not be read stops saying so once another opens", async () => {
  const { host, close } = open({ "": home, "/Users/a/locked": new Error("denied"), "/Users/a/work": work });
  click(host.querySelector("#workspace"));
  await settle();
  const item = (name: string) => [...host.querySelectorAll(".host-browse-item")].find((b) => b.textContent?.trim() === name);
  click(item("locked"));
  await settle();
  expect(host.textContent).toContain("Could not read it");
  click(item("work"));
  await settle();
  expect(host.querySelector(".host-browse-path")?.textContent).toBe("/Users/a/work");
  expect(host.textContent).not.toContain("Could not read it");
  close();
});

test("the chosen path can read shorter on the button, the whole of it on hover", async () => {
  const { host, close } = open({}, { path: "/Users/a/work/deep/project", shown: (path: string) => `…/${path.split("/").slice(-2).join("/")}` });
  const button = host.querySelector("#workspace");
  expect(button?.textContent?.trim()).toBe("…/deep/project");
  expect(button?.getAttribute("title")).toBe("/Users/a/work/deep/project");
  close();
});
