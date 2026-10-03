import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER, type Locale } from "@real-bot/protocol";
import { createClosing } from "./engine/closing";
import type { Live } from "./engine/types";
import {
  claimsVerification,
  closingNote,
  deliveryExcerpt,
  describeFailingCheck,
  FAILING_CHECKS_LIMIT,
  promisesLaterWork,
} from "./closing-check";
import type { ChatMessage, CompletionOk } from "./completions";
import { TurnAdmission } from "./quiesce";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";
import { troubleCount } from "./engine/trouble";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function call(name: string, args: Record<string, unknown>): CompletionOk {
  return { ok: true, content: "", toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

// -------------------------------------------------------------------------------------------
// A `createClosing` harness with no working `completions` client: any rule that reached for a
// model call would fail the test outright, which is the point — the whole file exists to prove
// none of them do.
// -------------------------------------------------------------------------------------------

function closingHarness() {
  const root = mkdtempSync(join(tmpdir(), "closing-check-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  store.patchSettingsSync({ workspace_path: root });
  const judgeCalls: unknown[] = [];
  const completeCalls: unknown[] = [];
  const spendCalls: unknown[] = [];
  const admission = new TurnAdmission();
  const closing = createClosing({
    store,
    completions: {
      async complete(request) {
        completeCalls.push(request);
        throw new Error("complete must not be called by the closing check");
      },
      async judge(request) {
        judgeCalls.push(request);
        throw new Error("judge must not be called by the closing check");
      },
    },
    admission,
    lives: new Map(),
    active: () => true,
    publishTurn: () => {},
    publishMessage: () => {},
    recordResponseSpend: (input) => {
      spendCalls.push(input);
      return null;
    },
    spendOwner: (sessionId, botId) => ({ sessionId, sessionName: null, botId, botName: null }),
    executionOf: () => null,
    observeTicket: () => {},
  });
  return {
    root,
    store,
    closing,
    admission,
    judgeCalls,
    completeCalls,
    spendCalls,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeLive(overrides: Partial<Live> = {}): Live {
  return {
    abort: new AbortController(),
    loop: [],
    inbox: [],
    interrupt: false,
    burned: false,
    partial: "",
    parentId: null,
    writtenPaths: [],
    planDir: null,
    workDir: null,
    mentionWarned: new Set(),
    toolNames: new Set(),
    mcpTools: new Map(),
    spoke: false,
    drainRejection: false,
    closingChecked: false,
    routing: null,
    locale: "zh",
    hops: 0,
    toolCalls: 0,
    toolErrors: 0,
    repeatedFailures: 0,
    failures: [],
    failedCalls: new Set(),
    trouble: troubleCount(),
    ...overrides,
  };
}

/** A Bot with an open direct session and a plan, ready for a turn. */
function job(h: ReturnType<typeof closingHarness>) {
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const brief = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "写周报，交到 report.md" });
  const plan = h.store.openTask({ sessionId: session, title: "周报" });
  const turn = h.store.createTurn({ sessionId: session, botId: writer.bot.id, triggerMessageId: brief.id, taskId: plan.id });
  return { bot: writer.bot, session, plan, turn };
}

describe("closing check: failing acceptance checks", () => {
  test("a failing file check is named in the note, only for a delivery", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      h.store.createCheckByUser(plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "写好了，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toBe(
        "（应用提示）这件事自己的验收检查还没过：\n「交出 report.md」文件存在：report.md：文件不在\n要改的是交付物，不是检查本身：改好后再交一次；做不到的话，在收尾里说明现在为什么做不到。",
      );
      expect(h.judgeCalls).toHaveLength(0);
      expect(h.completeCalls).toHaveLength(0);
      expect(h.spendCalls).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  test("a pure 'still working' reply is not checked against the plan's file checks", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      h.store.createCheckByUser(plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, {
        body: "@Writer 正在核对数据，结论随后，@Writer 会跟进。",
        paths: [],
        sessionId: session,
      });
      // No delivery cited (paths is empty), so the failing file check never enters the note; the
      // promise is named to a Bot, so it is not unbacked either.
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a file check the Bot just fixed this turn passes fresh, no stale bounce", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      const check = h.store.createCheckByUser(plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
      // A stale stored run says it failed — the fresh, in-memory re-check must win over it.
      const staleRun = h.store.beginCheckRun(check.id, "settle");
      h.store.finishCheckRun(staleRun.id, { outcome: "fail", exitCode: null, detail: "文件不在", output: null });
      writeFileSync(join(h.root, "report.md"), "# 周报\n本周…\n");
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "写好了，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a command check re-run successfully this turn is skipped even though its stored run failed", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      const check = h.store.createCheckByUser(plan.id, { item: "跑测试", kind: "command", command: "true" });
      const staleRun = h.store.beginCheckRun(check.id, "settle");
      h.store.finishCheckRun(staleRun.id, { outcome: "fail", exitCode: 1, detail: "退出码 1，应为 0", output: null });
      h.store.recordTurnRun({ turnId: turn.id, tool: "shell", command: "true", exitCode: 0, ok: true });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "写好了，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a command check with no fresh run this turn stays named from its last stored run", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      const check = h.store.createCheckByUser(plan.id, { item: "跑测试", kind: "command", command: "true" });
      const staleRun = h.store.beginCheckRun(check.id, "settle");
      h.store.finishCheckRun(staleRun.id, { outcome: "fail", exitCode: 1, detail: "退出码 1，应为 0", output: null });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "写好了，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toContain("「跑测试」命令：true：退出码 1，应为 0");
    } finally {
      h.close();
    }
  });

  test("at most three failing checks are named, oldest-defined first", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      for (let i = 1; i <= 4; i += 1) {
        h.store.createCheckByUser(plan.id, { item: `第 ${i} 条`, kind: "exists", path: `f${i}.md` });
      }
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "写好了，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toContain("第 1 条");
      expect(note).toContain("第 2 条");
      expect(note).toContain("第 3 条");
      expect(note).not.toContain("第 4 条");
      expect(FAILING_CHECKS_LIMIT).toBe(3);
    } finally {
      h.close();
    }
  });
});

describe("closing check: an unbacked promise", () => {
  test("a promise with no check-back and nobody named is nudged", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "正在核对 18 张起止帧，结论随后。", paths: [], sessionId: session });
      expect(note).toBe(
        "（应用提示）你说了稍后还有下文，但这一轮一结束就没有人接手：现在做完、约一个 check_back，或者点名交给谁。",
      );
    } finally {
      h.close();
    }
  });

  test("a promise backed by a booked check-back is fine", async () => {
    const h = closingHarness();
    try {
      const { bot, turn, session } = job(h);
      h.store.scheduleCheckBack({ botId: bot.id, sessionId: session, turnId: turn.id, note: "回看数据", afterMinutes: 30 });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "正在核对 18 张起止帧，结论随后。", paths: [], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a promise handed off by @mention is fine", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, {
        body: "@Reviewer 麻烦接着跟一下，结论随后。",
        paths: [],
        sessionId: session,
      });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("closing check: an unverified claim", () => {
  test("a claim of a passed test with no run this turn is nudged", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "测试全部通过，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toBe(
        "（应用提示）你说已经跑过、测过或验证过，但这一轮没有跑任何命令：现在去跑，或者写明没有验证过以及原因。",
      );
    } finally {
      h.close();
    }
  });

  test("a claim backed by any run this turn is fine, even a failed one", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      h.store.recordTurnRun({ turnId: turn.id, tool: "shell", command: "bun test", exitCode: 1, ok: false });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "测试全部通过，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a claim disclaimed as 未验证 is fine", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, {
        body: "代码写完了，能测试通过，但这轮没跑，未验证，见 report.md",
        paths: ["report.md"],
        sessionId: session,
      });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("closing check: gating", () => {
  test("runs at most once per turn", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      const live = makeLive();
      const first = await h.closing.closingCheck(turn.id, live, turn, { body: "结论随后。", paths: [], sessionId: session });
      expect(first).not.toBeNull();
      const second = await h.closing.closingCheck(turn.id, live, turn, { body: "结论随后。", paths: [], sessionId: session });
      expect(second).toBeNull();
    } finally {
      h.close();
    }
  });

  test("no user present in the target session returns null", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      h.store.db.run(`UPDATE session_participants SET left_at = ? WHERE session_id = ? AND member = ?`, [new Date().toISOString(), session, USER_MEMBER]);
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "结论随后。", paths: [], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a turn with no task returns null", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      h.store.db.run(`UPDATE turns SET task_id = NULL WHERE id = ?`, [turn.id]);
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "结论随后。", paths: [], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("the closing-check ablation switch turns it off", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      h.store.createCheckByUser(plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
      const closingOff = createClosing({
        store: h.store,
        completions: {
          async complete() {
            throw new Error("complete must not be called");
          },
          async judge() {
            throw new Error("judge must not be called");
          },
        },
        admission: h.admission,
        lives: new Map(),
        active: () => true,
        publishTurn: () => {},
        publishMessage: () => {},
        recordResponseSpend: () => null,
        spendOwner: (sessionId, botId) => ({ sessionId, sessionName: null, botId, botName: null }),
        executionOf: () => null,
        observeTicket: () => {},
        ablation: new Set(["closing-check"]),
      });
      const live = makeLive();
      const note = await closingOff.closingCheck(turn.id, live, turn, { body: "写好了，见 report.md", paths: ["report.md"], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("draining returns null", async () => {
    const h = closingHarness();
    try {
      const { turn, session } = job(h);
      h.admission.pause();
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "结论随后。", paths: [], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });

  test("neither a delivery nor a promise skips the check entirely", async () => {
    const h = closingHarness();
    try {
      const { plan, turn, session } = job(h);
      h.store.createCheckByUser(plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
      const live = makeLive();
      const note = await h.closing.closingCheck(turn.id, live, turn, { body: "先这样，别的事我们再商量。", paths: [], sessionId: session });
      expect(note).toBeNull();
    } finally {
      h.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// Wiring through the real turn engine: a send_message delivery is bounced as the tool's own
// result, a loop reply is bounced as a line in the loop, and the next reply is final either way.
// -------------------------------------------------------------------------------------------

function engineHarness(root: string, script: (messages: ChatMessage[]) => CompletionOk) {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: ChatMessage[][] = [];
  const judgeCalls: unknown[] = [];
  const waiters: Array<() => void> = [];
  const nextCompletion = () => new Promise<void>((resolve) => waiters.push(resolve));
  const engine = createTurnEngine({
    store,
    publish(event) {
      if (event.event === "turn.upsert" && event.status === "completed") for (const wake of waiters.splice(0)) wake();
    },
    completions: {
      async complete(request) {
        seen.push(request.messages);
        return script(request.messages);
      },
      async judge(request) {
        judgeCalls.push(request);
        throw new Error("no routing agent");
      },
    },
  });
  const settle = () =>
    store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1", endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
  return { store, engine, seen, judgeCalls, nextCompletion, settle };
}

describe("the closing check wired into a turn", () => {
  test("a reply that says the work is still going, unbacked, is nudged in the loop; the next reply is final", async () => {
    const root = mkdtempSync(join(tmpdir(), "closing-loop-"));
    const h = engineHarness(root, (messages) => {
      if (messages.some((m) => m.role === "user" && textOf(m).startsWith("（应用提示）"))) {
        return say("18 张起止帧逐对看完：没有画风跳变。");
      }
      return say("正在逐对核验 18 张起止帧，结论随后。");
    });
    try {
      await h.settle();
      const reviewer = h.store.createBot({ name: "审片员", duties: "review", boundaries: "stay" });
      const session = reviewer.direct_session.id;
      const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "逐对核验 18 张起止帧，给出结论" });
      const done = h.nextCompletion();
      await h.engine.handleInboundMessage(trigger, { fromUser: true });
      await done;
      const posted = h.store.listMainMessages(session, 10).filter((m) => m.kind === "bot").map((m) => m.body);
      expect(posted).toEqual(["18 张起止帧逐对看完：没有画风跳变。"]);
    } finally {
      await h.engine.close();
      h.store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a send_message delivery claiming an unverified pass is bounced as the tool's result; the resend goes through", async () => {
    const root = mkdtempSync(join(tmpdir(), "closing-send-"));
    writeFileSync(join(root, "report.md"), "# 周报\n");
    const h = engineHarness(root, (messages) => {
      const results = messages.filter((m) => m.role === "tool").map(textOf);
      if (results.some((t) => t.includes("closing_check"))) {
        return call("send_message", { body: "周报见 report.md，写完就存了，没跑别的。", paths: ["report.md"] });
      }
      if (results.length === 0) return call("send_message", { body: "全部通过，周报见 report.md", paths: ["report.md"] });
      return say("");
    });
    try {
      await h.settle();
      const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
      const session = writer.direct_session.id;
      const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "写一份周报，交到 report.md" });
      const done = h.nextCompletion();
      await h.engine.handleInboundMessage(trigger, { fromUser: true });
      await done;
      const posted = h.store.listMainMessages(session, 10).filter((m) => m.kind === "bot").map((m) => m.body);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("写完就存了");
    } finally {
      await h.engine.close();
      h.store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------------------------------------------
// The pure building blocks, tested directly.
// -------------------------------------------------------------------------------------------

describe("closing check pieces", () => {
  test("promisesLaterWork recognises the work-still-going phrasing in either language", () => {
    expect(promisesLaterWork("正在逐对核验 18 张起止帧，先挂审片条，结论随后。")).toBe(true);
    expect(promisesLaterWork("初稿先放这，图稍后补")).toBe(true);
    expect(promisesLaterWork("Checking the frames now, results to follow.")).toBe(true);
    expect(promisesLaterWork("I'll get back to you with the verdict")).toBe(true);
    expect(promisesLaterWork("周报在 report.md，趋势图也在里面")).toBe(false);
    expect(promisesLaterWork("Done: the report is in report.md")).toBe(false);
  });

  test("claimsVerification is conservative and respects an explicit disclaimer", () => {
    expect(claimsVerification("测试全部通过")).toBe(true);
    expect(claimsVerification("跑通了，21/21 通过")).toBe(true);
    expect(claimsVerification("All tests passed, build succeeded.")).toBe(true);
    expect(claimsVerification("我验证过导出功能")).toBe(true);
    expect(claimsVerification("周报见 report.md")).toBe(false);
    expect(claimsVerification("能测试通过，但没跑，未验证")).toBe(false);
    expect(claimsVerification("not verified yet, still writing tests")).toBe(false);
  });

  test("describeFailingCheck reads in the turn's locale", () => {
    const check = { item: "交出 report.md", kind: "exists" as const, path: "report.md", pattern: null, negate: false, command: null, cwd: null };
    expect(describeFailingCheck(check, "zh", "文件不在")).toBe("「交出 report.md」文件存在：report.md：文件不在");
    expect(describeFailingCheck(check, "en", "missing file")).toBe('"交出 report.md" File exists: report.md: missing file');
  });

  test("closingNote combines whichever signals apply, in the app-note voice, and is null for none", () => {
    const zh: Locale = "zh";
    const en: Locale = "en";
    expect(closingNote(zh, { failingChecks: [], unbackedPromise: false, unverifiedClaim: false })).toBeNull();
    expect(closingNote(zh, { failingChecks: ["「x」文件存在：a.md：文件不在"], unbackedPromise: false, unverifiedClaim: false })).toBe(
      "（应用提示）这件事自己的验收检查还没过：\n「x」文件存在：a.md：文件不在\n要改的是交付物，不是检查本身：改好后再交一次；做不到的话，在收尾里说明现在为什么做不到。",
    );
    expect(closingNote(zh, { failingChecks: [], unbackedPromise: true, unverifiedClaim: false })).toBe(
      "（应用提示）你说了稍后还有下文，但这一轮一结束就没有人接手：现在做完、约一个 check_back，或者点名交给谁。",
    );
    expect(closingNote(en, { failingChecks: [], unbackedPromise: false, unverifiedClaim: true })).toBe(
      "(App note) You say it was run, tested, or verified, but this turn ran no command: run it now, or write that it was not verified and why.",
    );
    const both = closingNote(zh, { failingChecks: [], unbackedPromise: true, unverifiedClaim: true })!;
    expect(both.startsWith("（应用提示）你说了稍后还有下文")).toBe(true);
    expect(both).toContain("你说已经跑过、测过或验证过");
  });

  test("an excerpt is the head of a text file and nothing for binaries or paths outside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "bot-closing-excerpt-"));
    try {
      writeFileSync(join(root, "a.md"), "x".repeat(50));
      writeFileSync(join(root, "a.png"), "notreally");
      expect(deliveryExcerpt(root, "a.md", 10)).toEqual({ excerpt: "x".repeat(10), truncated: true });
      expect(deliveryExcerpt(root, "a.md")).toEqual({ excerpt: "x".repeat(50), truncated: false });
      expect(deliveryExcerpt(root, "a.png")).toEqual({ excerpt: null, truncated: false });
      expect(deliveryExcerpt(root, "../etc/passwd.txt")).toEqual({ excerpt: null, truncated: false });
      expect(deliveryExcerpt(root, "missing.md")).toEqual({ excerpt: null, truncated: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
