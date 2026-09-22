import { expect, test } from "bun:test";
import BuildUpdateNotice from "./BuildUpdateNotice.svelte";
import { BuildUpdates } from "./build-version.svelte.ts";
import { copyFor } from "./copy.ts";
import { click, render } from "./test-render.ts";

function open(running: string, published: string) {
  const updates = new BuildUpdates(running, async () => ({ version: published }));
  return { updates, show: () => render(BuildUpdateNotice, { t: copyFor("en"), updates }) };
}

test("the running build gets no notice", async () => {
  const { updates, show } = open("1", "1");
  await updates.poll();
  const { host, close } = show();
  expect(host.querySelector("[data-testid=build-update]")).toBeNull();
  close();
});

test("a newer build offers a reload and can be waved off", async () => {
  const { updates, show } = open("1", "2");
  await updates.poll();
  const { host, close } = show();
  const notice = host.querySelector("[data-testid=build-update]");
  expect(notice?.textContent).toContain("A new version is ready");
  expect(notice?.textContent).toContain("Reload");
  click(host.querySelector("[data-testid=build-update-dismiss]"));
  expect(host.querySelector("[data-testid=build-update]")).toBeNull();
  close();
});

test("the notice comes back for the build published after the dismissed one", async () => {
  let latest = "2";
  const updates = new BuildUpdates("1", async () => ({ version: latest }));
  await updates.poll();
  const { host, close } = render(BuildUpdateNotice, { t: copyFor("en"), updates });
  click(host.querySelector("[data-testid=build-update-dismiss]"));
  latest = "3";
  await updates.poll();
  expect(host.querySelector("[data-testid=build-update]")).not.toBeNull();
  close();
});
