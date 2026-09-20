import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aGroup, aMemory, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import MemoryCard from "./MemoryCard.svelte";

const t = copyFor("zh");

function open(memories: ReturnType<typeof aMemory>[], sessions = [aGroup({ id: "sess-1", name: "视频组" })]) {
  const bot = aBot({ id: "bot-1", name: "Writer" });
  const runtime = fakeRuntime({
    bots: [bot, aBot({ id: "bot-2", name: "Researcher" })],
    sessions,
    memories,
  });
  const danger: { kind: string; run: (isCurrent: () => boolean) => Promise<void> }[] = [];
  const view = render(MemoryCard, {
    runtime,
    bot,
    t,
    openDangerConfirm: (kind: string, run: (isCurrent: () => boolean) => Promise<void>) => danger.push({ kind, run }),
    clearDanger: () => {},
  });
  return { ...view, runtime, danger };
}

test("only this Bot's memories are listed", () => {
  const { host, close } = open([
    aMemory({ id: "m-1", bot_id: "bot-1", subject: "我的" }),
    aMemory({ id: "m-2", bot_id: "bot-2", subject: "别人的" }),
  ]);
  const subjects = [...host.querySelectorAll(".memory-subject")].map((el) => el.textContent);
  expect(subjects).toEqual(["我的"]);
  close();
});

/** The provenance line is the only place the boundary is visible, so it has to be right. */
test("the origin line names where it was formed and jumps to that message", () => {
  const { host, runtime, close } = open([aMemory()]);
  expect(host.querySelector(".memory-origin-link")?.textContent?.trim()).toBe(
    t.sidebar.memoryFormedIn("视频组"),
  );
  click(host.querySelector(".memory-origin-link"));
  const jump = runtime.calls.find((c) => c.name === "selectSession");
  expect(jump?.args).toEqual(["sess-1", { messageId: "msg-1" }]);
  close();
});

test("a memory formed in a Bot to Bot direct says so", () => {
  const { host, close } = open([aMemory({ source_session_id: "botbot-1" })], [aBotDirect({ id: "botbot-1" })]);
  expect(host.querySelector(".memory-origin-link")?.textContent).toContain(t.sidebar.botBot);
  close();
});

test("a memory whose source is gone says so and offers no jump", () => {
  const { host, close } = open([aMemory({ source_session_id: null, source_message_id: null })]);
  expect(host.querySelector(".memory-origin-missing")?.textContent).toBe(t.sidebar.memoryOriginMissing);
  expect(host.querySelector(".memory-origin-link")).toBeNull();
  close();
});

/** The Bot writes memories; the user only corrects them. */
test("there is no way to add a memory by hand", () => {
  const { host, close } = open([aMemory()]);
  expect(host.querySelector(".memory-head-add-btn")).toBeNull();
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(labels).not.toContain(t.sidebar.memorySave);
  expect(host.querySelector(".panel-card-head button")).toBeNull();
  close();
});

test("the toggle disables a memory without deleting it", () => {
  const { host, runtime, close } = open([aMemory()]);
  const box = host.querySelector(".memory-toggle input") as HTMLInputElement;
  box.checked = false;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  const call = runtime.calls.find((c) => c.name === "patchMemory");
  expect(call?.args).toEqual(["mem-1", { enabled: false }]);
  expect(runtime.calls.some((c) => c.name === "deleteMemory")).toBe(false);
  close();
});

test("editing saves the trimmed fields", async () => {
  const { host, runtime, close } = open([aMemory()]);
  click(host.querySelector(".memory-icon-btn"));
  fill(host.querySelector("#memory-body"), "  改过的正文  ");
  click(buttonByText(host, t.sidebar.memorySave));
  await Promise.resolve();
  const call = runtime.calls.find((c) => c.name === "patchMemory");
  expect(call?.args).toEqual(["mem-1", { subject: "用户的回复偏好", body: "改过的正文" }]);
  close();
});

test("delete goes through the danger confirm", async () => {
  const { host, runtime, danger, close } = open([aMemory()]);
  click(host.querySelectorAll(".memory-icon-btn")[1]);
  expect(danger[0]?.kind).toBe("memory");
  await danger[0]!.run(() => true);
  expect(runtime.calls.find((c) => c.name === "deleteMemory")?.args).toEqual(["mem-1"]);
  close();
});

test('an obsolete memory delete cannot clear the replacement confirmation', async () => {
  const bot = aBot();
  let release!: (value: null) => void;
  const runtime = fakeRuntime({ bots: [bot], memories: [aMemory()] }, { deleteMemory: () => new Promise<null>((resolve) => { release = resolve; }) });
  let run!: (isCurrent: () => boolean) => Promise<void>;
  let cleared = 0;
  const { host, close } = render(MemoryCard, { runtime, bot, t,
    openDangerConfirm: (_kind, action) => { run = action; }, clearDanger: () => { cleared++; } });
  click(host.querySelector('.memory-icon-btn.is-danger'));
  let current = true;
  const pending = run(() => current);
  current = false; release(null); await pending;
  expect(cleared).toBe(0); close();
});

test("a long list folds until it is expanded", () => {
  const many = Array.from({ length: 8 }, (_, i) => aMemory({ id: `m-${i}`, subject: `事实 ${i}` }));
  const { host, close } = open(many);
  expect(host.querySelectorAll(".memory-row")).toHaveLength(5);
  click(buttonByText(host, t.sidebar.memoryShowAll(8)));
  expect(host.querySelectorAll(".memory-row")).toHaveLength(8);
  close();
});

test("an empty card explains who writes these", () => {
  const { host, close } = open([]);
  expect(host.querySelector(".memory-empty")?.textContent).toBe(t.sidebar.memoriesEmpty);
  close();
});
