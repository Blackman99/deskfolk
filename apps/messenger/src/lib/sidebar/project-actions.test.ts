import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { newProjectIn, newProjectInFolder } from "./project-actions.ts";

const t = copyFor("zh");

test("a new session in a folder: the Mac's dialog where there is one, the session opens in what you picked", async () => {
  const runtime = fakeRuntime();
  await newProjectInFolder(runtime, t, { available: () => true, pick: async () => "/Users/a/proj" });
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "claude_code", dir: "/Users/a/proj" }]);
  expect(runtime.calls.some((c) => c.name === "openCreateProject")).toBe(false);
});

test("closing the dialog does nothing; no dialog, or one that fails, opens the sheet to pick there", async () => {
  const cancelled = fakeRuntime();
  await newProjectInFolder(cancelled, t, { available: () => true, pick: async () => null });
  expect(cancelled.calls.map((c) => c.name)).toEqual([]);
  for (const dialog of [{ available: () => false, pick: async () => "/x" }, { available: () => true, pick: async () => { throw new Error("no"); } }]) {
    const runtime = fakeRuntime();
    await newProjectInFolder(runtime, t, dialog);
    expect(runtime.calls.map((c) => [c.name, c.args])).toEqual([["openCreateProject", ["new"]]]);
  }
});

test("a new session in a listed directory; one the daemon will not take opens the sheet instead", async () => {
  const runtime = fakeRuntime();
  await newProjectIn(runtime, "/Users/a/proj");
  expect(runtime.calls.map((c) => c.name)).toEqual(["createProjectSession"]);
  const asked: unknown[] = [];
  const gone = fakeRuntime({}, { createProjectSession: (body: unknown) => (asked.push(body), Promise.resolve(Object.assign(new Error("gone"), { status: 422 }))) });
  await newProjectIn(gone, "/Users/a/gone");
  expect(asked).toEqual([{ agent: "claude_code", dir: "/Users/a/gone" }]);
  expect(gone.calls.filter((c) => c.name === "openCreateProject").map((c) => c.args)).toEqual([["new"]]);
});
