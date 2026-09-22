import { expect, test } from "bun:test";
import { offersRefresh, publishedVersion } from "./build-version.ts";
import { BuildUpdates } from "./build-version.svelte.ts";

test("a build is only offered when it is neither the running one nor the waved-off one", () => {
  expect(offersRefresh("1", "2", null)).toBe(true);
  expect(offersRefresh("1", "1", null)).toBe(false);
  expect(offersRefresh("1", null, null)).toBe(false);
  expect(offersRefresh("1", "2", "2")).toBe(false);
  // Waving off build 2 says nothing about build 3.
  expect(offersRefresh("1", "3", "2")).toBe(true);
});

test("a payload without a usable version is not a new build", () => {
  expect(publishedVersion({ version: "17" })).toBe("17");
  expect(publishedVersion({ version: "" })).toBeNull();
  expect(publishedVersion({ version: 17 })).toBeNull();
  expect(publishedVersion("17")).toBeNull();
  expect(publishedVersion(null)).toBeNull();
});

test("a failed check leaves the page on what it already knew", async () => {
  let answer: () => Promise<unknown> = async () => ({ version: "2" });
  const updates = new BuildUpdates("1", () => answer());
  await updates.poll();
  expect(updates.offered).toBe(true);
  answer = async () => {
    throw new Error("offline");
  };
  await updates.poll();
  expect(updates.published).toBe("2");
  expect(updates.offered).toBe(true);
});

test("dismissing this build still offers the one published after it", async () => {
  let latest = "2";
  const updates = new BuildUpdates("1", async () => ({ version: latest }));
  await updates.poll();
  updates.dismiss();
  expect(updates.offered).toBe(false);
  // A dev loop republishes every few minutes; the next one is news again.
  latest = "3";
  await updates.poll();
  expect(updates.offered).toBe(true);
});

test("stop ends the polling it started", async () => {
  let reads = 0;
  const updates = new BuildUpdates("1", async () => {
    reads += 1;
    return { version: "1" };
  });
  const stop = updates.start();
  stop();
  const afterStop = reads;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(reads).toBe(afterStop);
});
