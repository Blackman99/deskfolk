import { expect, test } from "nsh/test";
import { pageBuild, pageBuildUpdates, reloadPage } from "./page-build";

test("the page knows its build only from the params phone-package.ts serves it with", () => {
  expect(pageBuild({ build: "3182d29d8cb48200" })).toBe("3182d29d8cb48200");
  // The desktop's shell: a window id, no build.
  expect(pageBuild({ windowId: 1 })).toBe(null);
  expect(pageBuild({ build: "" })).toBe(null);
  expect(pageBuild({ build: 7 })).toBe(null);
  expect(pageBuild(undefined)).toBe(null);
  expect(pageBuildUpdates({ windowId: 1 })).toBe(null);
});

test("a newer build on the relay is offered; this page's own is not", async () => {
  const updates = pageBuildUpdates({ build: "a" })!;
  expect(updates.offered).toBe(false);
  updates.published = "a";
  expect(updates.offered).toBe(false);
  updates.published = "b";
  expect(updates.offered).toBe(true);
  updates.dismiss();
  expect(updates.offered).toBe(false);
});

test("a reload loads the page, not only the app's frame", () => {
  const reloaded: string[] = [];
  const page = { location: { reload: () => reloaded.push("page") } };
  reloadPage({ top: page, location: { reload: () => reloaded.push("frame") } });
  expect(reloaded).toEqual(["page"]);
  // A page that runs the app in its own realm is its own top.
  reloadPage({ top: null, location: { reload: () => reloaded.push("realm") } });
  expect(reloaded).toEqual(["page", "realm"]);
});
