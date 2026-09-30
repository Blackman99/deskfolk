import { expect, test } from "bun:test";
import type { MessageControl } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup, aHold, aMessage, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const t = copyFor("zh");

function stage(session: ReturnType<typeof aDirect>, over: Parameters<typeof fakeRuntime>[0]) {
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1", name: "视频导演" }), aBot({ id: "bot-2", name: "审片员" })], sessions: [session], ...over }, { selectedId: session.id }));
  const view = render(ChatStage, { runtime, t, selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  return { ...view, runtime };
}

test("the app's receipt carries its buttons, and a press goes to the daemon for that line", () => {
  const session = aDirect();
  const control: MessageControl = { kind: "receipt", verb: "stop", hold_ids: ["hold-1"], offer: ["undo", "stop_all"], scopes: [{ scope: "bot", id: "bot-1" }] };
  const receipt = aMessage({ id: "receipt", session_id: session.id, kind: "system", author: "bot-1", body: "已停下视频导演的全部工作。", control });
  const { host, runtime, close } = stage(session, { messages: [receipt], holds: [aHold()], holdsOn: true });
  try {
    const row = host.querySelector('[data-message-id="receipt"]')!;
    expect([...row.querySelectorAll(".control-btn")].map((button) => button.textContent?.trim())).toEqual(["撤销", "扩大到所有 Bot"]);
    click(buttonByText(row as HTMLElement, "撤销"));
    expect(runtime.calls.filter((call) => call.name === "controlAction").map((call) => call.args)).toEqual([["receipt", "undo", undefined]]);
  } finally {
    close();
  }
});

test("your line that might have meant a stop asks under it, on its side", () => {
  const session = aDirect();
  const line = aMessage({ id: "line", session_id: session.id, body: "先停，把第三镜换成夜景", control: { kind: "possible_control", offer: ["stop"], scopes: [{ scope: "bot", id: "bot-1" }] } });
  const { host, runtime, close } = stage(session, { messages: [line], holdsOn: true });
  try {
    const bar = host.querySelector('[data-message-id="line"] .control-actions')!;
    expect(bar.classList.contains("is-end")).toBe(true);
    expect(bar.textContent).toContain("这句像是要停下视频导演：");
    click(buttonByText(bar as HTMLElement, "停下视频导演"));
    expect(runtime.calls.filter((call) => call.name === "controlAction").map((call) => call.args)).toEqual([["line", "stop", undefined]]);
  } finally {
    close();
  }
});

test("a Bot's reply in a group can be stopped once the daemon has stops, and the Stop names that turn", () => {
  const session = aGroup();
  const turns = [aTurn({ id: "turn-9", session_id: session.id, bot_id: "bot-2", partial_text: "正在审第三镜" })];
  const off = stage(session, { turns });
  expect(off.host.querySelector(".btn-mini-stop")).toBeNull();
  off.close();
  const { host, runtime, close } = stage(session, { turns, holdsOn: true });
  try {
    click(host.querySelector(".btn-mini-stop"));
    expect(runtime.calls.filter((call) => call.name === "stopTurn").map((call) => call.args)).toEqual([[session.id, "turn-9"]]);
  } finally {
    close();
  }
});

test("a restart notice carries 继续 and 不续, and the 「中断」 line it names offers no Continue of its own until it is answered", () => {
  const session = aDirect();
  const note = aMessage({ id: "cut", session_id: session.id, kind: "system", author: "bot-1", body: "中断", turn_id: "turn-cut" });
  const control: MessageControl = { kind: "restart", cause: "dev", notes: ["cut"], offer: ["resume", "leave"] };
  const notice = aMessage({ id: "notice", session_id: session.id, kind: "system", author: "bot-1", body: "开发版守护进程重新启动了，「EP01」这件事中断了。", control });
  const turns = [aTurn({ id: "turn-cut", session_id: session.id, bot_id: "bot-1", status: "interrupted" })];
  const { host, runtime, close } = stage(session, { messages: [note, notice], turns });
  try {
    expect(host.querySelector('[data-message-id="cut"] .btn-continue-turn')).toBeNull();
    const row = host.querySelector('[data-message-id="notice"]')!;
    expect([...row.querySelectorAll(".control-btn")].map((button) => button.textContent?.trim())).toEqual(["继续", "不续"]);
    click(buttonByText(row as HTMLElement, "继续"));
    expect(runtime.calls.filter((call) => call.name === "controlAction").map((call) => call.args)).toEqual([["notice", "resume", undefined]]);
  } finally {
    close();
  }
  const answered = aMessage({ ...notice, control: { ...control, acted: ["leave"] } });
  const after = stage(session, { messages: [note, answered], turns });
  try {
    expect(after.host.querySelector('[data-message-id="cut"] .btn-continue-turn')).not.toBeNull();
    expect(after.host.querySelector('[data-message-id="notice"] .control-done')?.textContent).toBe("先放着");
  } finally {
    after.close();
  }
});
