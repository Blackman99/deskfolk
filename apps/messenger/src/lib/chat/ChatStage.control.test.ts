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

test("the app's own lines read as the app's: its mark and name over them, no Bot's face or name, and they keep their buttons", () => {
  const session = aGroup();
  const receipt: MessageControl = { kind: "receipt", verb: "stop", hold_ids: ["hold-1"], offer: ["undo"], scopes: [{ scope: "bot", id: "bot-1" }] };
  const status: MessageControl = { kind: "status", hold_ids: [], offer: ["stop"], scopes: [{ scope: "bot", id: "bot-1" }] };
  const restart: MessageControl = { kind: "restart", cause: "dev", notes: [], offer: ["resume", "leave"] };
  const lines = [
    aMessage({ id: "receipt", session_id: session.id, kind: "system", author: "bot-1", body: "已停下视频导演的全部工作。", control: receipt, created_at: "2026-09-30T08:00:00.000Z" }),
    aMessage({ id: "status", session_id: session.id, kind: "system", author: "bot-1", body: "视频导演：没停。", control: status, created_at: "2026-09-30T08:01:00.000Z" }),
    aMessage({ id: "notice", session_id: session.id, kind: "system", author: "bot-1", body: "开发版守护进程重新启动了，这里的工作中断了。", control: restart, created_at: "2026-09-30T08:02:00.000Z" }),
    // The 「中断」 a Bot's turn leaves is still that Bot's line.
    aMessage({ id: "cut", session_id: session.id, kind: "system", author: "bot-1", body: "中断", turn_id: "turn-cut", created_at: "2026-09-30T08:03:00.000Z" }),
  ];
  const { host, close } = stage(session, { messages: lines, holds: [aHold()], holdsOn: true });
  try {
    for (const id of ["receipt", "status", "notice"]) {
      const row = host.querySelector(`[data-message-id="${id}"]`)!;
      expect(row.querySelector(".app-avatar .brand-mark")).not.toBeNull();
      expect(row.querySelector(".bot-avatar")).toBeNull();
      expect(row.querySelector(".msg-header .sender-name")?.textContent?.trim()).toBe("Deskfolk");
      expect(row.querySelector(".msg-header .app-badge")?.textContent).toBe("应用");
      expect(row.querySelector(".msg-header .bot-badge")).toBeNull();
      expect(row.querySelector(".msg-header")?.textContent).not.toContain("视频导演");
      expect(row.querySelector("article.msg")?.getAttribute("aria-label")).toBe("来自 Deskfolk 应用的消息");
      expect(row.querySelectorAll(".control-btn").length).toBeGreaterThan(0);
    }
    const cut = host.querySelector('[data-message-id="cut"]')!;
    expect(cut.querySelector(".app-avatar")).toBeNull();
    expect(cut.querySelector(".bot-avatar")).not.toBeNull();
    expect(cut.querySelector(".msg-header .sender-name")?.textContent?.trim()).toBe("视频导演");
    expect(cut.querySelector(".msg-header .bot-badge")?.textContent).toBe("Bot");
    expect(cut.querySelector("article.msg")?.hasAttribute("aria-label")).toBe(false);
  } finally {
    close();
  }
});

test("the app's answer to 「怎么样了」 reads as the app's too, with no buttons, even before stops exist", () => {
  const session = aGroup();
  const control: MessageControl = { kind: "status", hold_ids: [], offer: [], scopes: [] };
  const progress = aMessage({ id: "progress", session_id: session.id, kind: "system", author: "bot-1", body: "这件事：剪出预告片（进行中）\n正在做：\n- 视频导演 · 3 分钟", control });
  const { host, close } = stage(session, { messages: [progress], holdsOn: false });
  try {
    const row = host.querySelector('[data-message-id="progress"]')!;
    expect(row.querySelector(".app-avatar .brand-mark")).not.toBeNull();
    expect(row.querySelector(".bot-avatar")).toBeNull();
    expect(row.querySelector(".msg-header .sender-name")?.textContent?.trim()).toBe("Deskfolk");
    expect(row.querySelector(".msg-header .app-badge")?.textContent).toBe("应用");
    expect(row.querySelector(".msg-header .bot-badge")).toBeNull();
    expect(row.querySelector(".msg-header")?.textContent).not.toContain("视频导演");
    expect(row.querySelector("article.msg")?.getAttribute("aria-label")).toBe("来自 Deskfolk 应用的消息");
    expect(row.querySelector(".body")?.textContent).toContain("这件事：剪出预告片");
    expect(row.querySelector(".control-actions")).toBeNull();
  } finally {
    close();
  }
});

test("in your direct, where no line carries a face, the app's receipt still says it is the app's", () => {
  const session = aDirect();
  const control: MessageControl = { kind: "receipt", verb: "continue", hold_ids: ["hold-1"], offer: [], scopes: [{ scope: "bot", id: "bot-1" }] };
  const receipt = aMessage({ id: "receipt", session_id: session.id, kind: "system", author: "bot-1", body: "已解除叫停：视频导演的全部工作。", control });
  const { host, close } = stage(session, { messages: [receipt], holdsOn: true });
  try {
    const row = host.querySelector('[data-message-id="receipt"]')!;
    expect(row.querySelector(".avatar-col")).toBeNull();
    expect(row.querySelector(".msg-header .sender-name")?.textContent?.trim()).toBe("Deskfolk");
    expect(row.querySelector(".msg-header .bot-badge")).toBeNull();
    expect(row.querySelector("article.msg")?.getAttribute("aria-label")).toBe("来自 Deskfolk 应用的消息");
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

test("a check offered from your words: 确认 and 不要 go to the daemon, 改 starts your line with its words and sends nothing", async () => {
  const session = aDirect();
  const control: MessageControl = {
    kind: "check",
    event: "proposed",
    check_ids: ["check-1"],
    offer: ["confirm_check", "edit_check", "remove_check"],
    replacing: null,
    edit_draft: "片长改成 ",
  };
  const card = aMessage({ id: "card", session_id: session.id, kind: "system", author: "bot-1", body: "按你的话加检查：时长 108–132 秒？", control });
  const { host, runtime, close } = stage(session, { messages: [card], holdsOn: false });
  try {
    const row = host.querySelector('[data-message-id="card"]')! as HTMLElement;
    expect([...row.querySelectorAll(".control-btn")].map((button) => button.textContent?.trim())).toEqual(["确认", "改", "不要"]);
    click(buttonByText(row, "改"));
    expect(runtime.sessionView(session.id).draft).toBe("片长改成 ");
    // The row takes one press at a time.
    await new Promise((resolve) => setTimeout(resolve, 0));
    click(buttonByText(row, "确认"));
    expect(runtime.calls.filter((call) => call.name === "controlAction").map((call) => call.args)).toEqual([["card", "confirm_check", undefined]]);
  } finally {
    close();
  }
});
