import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const t = copyFor("zh");

function stage(sendRefused: "too_many_files" | "refused") {
  const session = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot()], sessions: [session] }, { selectedId: session.id }));
  const view = runtime.sessionView(session.id);
  view.sendRefused = sendRefused;
  view.stagedAttachments = [{ id: "a1", file: new File(["a"], "a.jpg"), previewUrl: null }] as typeof view.stagedAttachments;
  const rendered = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  return { ...rendered, view };
}

test("the composer says why the Mac did not take a message, and keeps what was staged", () => {
  const many = stage("too_many_files");
  expect(many.host.querySelector(".composer-refused")?.textContent).toBe(t.composer.tooManyFiles);
  expect(many.host.querySelector(".composer-refused")?.getAttribute("role")).toBe("alert");
  expect(many.view.stagedAttachments).toHaveLength(1);
  many.close();
  const other = stage("refused");
  expect(other.host.querySelector(".composer-refused")?.textContent).toBe(t.composer.sendRefused);
  other.close();
});

test("taking a file away clears it: the words were about the files that were there", () => {
  const s = stage("too_many_files");
  const remove = s.host.querySelector<HTMLButtonElement>(`button[aria-label^="${t.composer.removeAttachment}"]`);
  expect(remove).not.toBeNull();
  click(remove!);
  flushSync();
  expect(s.host.querySelector(".composer-refused")).toBeNull();
  s.close();
});
