import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import {
  CLOSING_CHECK_SYSTEM,
  CLOSING_ITEMS_LIMIT,
  closingCheckNote,
  closingCheckPayload,
  deliveryExcerpt,
  parseClosingCheck,
} from "./closing-check";
import type { ChatMessage, CompletionOk, JudgeResult } from "./completions";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function call(name: string, args: Record<string, unknown>): CompletionOk {
  return { ok: true, content: "", toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function verdict(items: Array<{ text: string; why: string }>): JudgeResult {
  return { content: JSON.stringify({ unaddressed: items }), toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

/**
 * An engine whose model writes a report, closes without the chart the brief asked for, and — when
 * nudged — closes again saying why. The closing judge answers once with the missing chart; every
 * other judge call (the route pick) fails so routing falls back to the rules.
 */
function harness(root: string, script: (messages: ChatMessage[]) => CompletionOk) {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: ChatMessage[][] = [];
  const closingCalls: Array<Record<string, unknown>> = [];
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
        if (textOf(request.messages[0]!) !== CLOSING_CHECK_SYSTEM) throw new Error("no routing agent");
        closingCalls.push(JSON.parse(textOf(request.messages[1]!)) as Record<string, unknown>);
        return verdict([{ text: "附上一张趋势图", why: "没看到图，收尾也没提" }]);
      },
    },
  });
  const settle = () =>
    store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1", endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
  return { store, engine, seen, closingCalls, nextCompletion, settle };
}

describe("the closing check in a turn", () => {
  test("a reply that hands over a file is checked once, bounced with what the request still lacks, and the next reply is final", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-closing-"));
    const h = harness(root, (messages) => {
      if (messages.some((m) => m.role === "user" && textOf(m).startsWith("收尾自检"))) {
        return say("趋势图这次没做：数据源还没给我，给了就补。周报见 report.md");
      }
      if (!messages.some((m) => m.role === "tool")) return call("write_file", { path: "report.md", content: "# 周报\n本周…\n" });
      return say("写好了，见 report.md");
    });
    try {
      await h.settle();
      const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
      const session = writer.direct_session.id;
      const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "写一份周报，附上一张趋势图，交到 report.md" });
      const done = h.nextCompletion();
      await h.engine.handleInboundMessage(trigger, { fromUser: true });
      await done;

      // One check, fed the request, this turn's file with its head, and the reply about to go out.
      expect(h.closingCalls).toHaveLength(1);
      expect(h.closingCalls[0]).toMatchObject({
        brief: "写一份周报，附上一张趋势图，交到 report.md",
        reply: "写好了，见 report.md",
        deliveries: [{ path: "report.md", excerpt: "# 周报\n本周…\n" }],
      });
      // The bounce reached the model as a user line naming the item, and the third hop closed for real.
      expect(h.seen).toHaveLength(3);
      const nudge = h.seen[2]!.filter((m) => m.role === "user").map(textOf).find((t) => t.startsWith("收尾自检"))!;
      expect(nudge).toContain("- 附上一张趋势图（没看到图，收尾也没提）");
      expect(nudge).toContain("这一轮只提示这一次");
      const posted = h.store.listMainMessages(session, 10).filter((m) => m.kind === "bot").map((m) => m.body);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("趋势图这次没做");
      // A nudge is not a tool error.
      const route = h.store.db.query<{ tool_errors: number | null }, [string]>("SELECT tool_errors FROM turn_route_decisions WHERE session_id = ?").get(session);
      expect(route?.tool_errors).toBe(0);
    } finally {
      await h.engine.close();
      h.store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a send_message delivery in a group is bounced as the tool's result, and the resend goes through untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-closing-group-"));
    writeFileSync(join(root, "report.md"), "# 周报\n");
    const h = harness(root, (messages) => {
      const results = messages.filter((m) => m.role === "tool").map(textOf);
      if (results.some((t) => t.includes("closing_check"))) {
        return call("send_message", { body: "初稿在 report.md，@Reviewer 请看。趋势图等数据到了再补。", paths: ["report.md"] });
      }
      if (results.length === 0) return call("send_message", { body: "初稿在 report.md，@Reviewer 请看", paths: ["report.md"] });
      return say("");
    });
    try {
      await h.settle();
      const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }).bot;
      const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
      const group = h.store.createGroup({ name: "Brief", members: [writer.id, reviewer.id] });
      const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "@Writer 写一份周报，附上一张趋势图，交到 report.md，然后让 Reviewer 过一遍" });
      const done = h.nextCompletion();
      await h.engine.handleInboundMessage(trigger, { fromUser: true });
      await done;

      expect(h.closingCalls).toHaveLength(1);
      // The first send did not go out; the model saw the bounce as that call's result.
      const bounce = h.seen[1]!.filter((m) => m.role === "tool").map(textOf)[0]!;
      expect(bounce).toContain('"code":"closing_check"');
      expect(bounce).toContain("附上一张趋势图");
      const posted = h.store.listMainMessages(group.id, 10).filter((m) => m.kind === "bot" && m.author === writer.id);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body).toContain("趋势图等数据到了再补");
      const route = h.store.db.query<{ tool_errors: number | null; tool_calls: number | null }, [string]>("SELECT tool_errors, tool_calls FROM turn_route_decisions WHERE bot_id = ?").get(writer.id);
      expect(route).toEqual({ tool_errors: 0, tool_calls: 2 });
    } finally {
      await h.engine.close();
      h.store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a reply with nothing handed over, and a handoff into a Bot↔Bot direct, are not checked", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-closing-skip-"));
    writeFileSync(join(root, "report.md"), "# 周报\n");
    const h = harness(root, (messages) => {
      const results = messages.filter((m) => m.role === "tool").map(textOf);
      if (results.length === 0) return call("create_direct", { name: "Reviewer" });
      if (results.length === 1) {
        const opened = JSON.parse(results[0]!) as { data: { session_id: string } };
        return call("send_message", { session_id: opened.data.session_id, body: "请看 report.md，按最初要求过一遍", paths: ["report.md"] });
      }
      return say("好的，交给 Reviewer 了。");
    });
    try {
      await h.settle();
      const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
      h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
      const session = writer.direct_session.id;
      const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "写一份周报，附上一张趋势图，交到 report.md" });
      const done = h.nextCompletion();
      await h.engine.handleInboundMessage(trigger, { fromUser: true });
      await done;
      // The handoff went to a session the user is not in, and the closing line cites no file.
      expect(h.closingCalls).toHaveLength(0);
    } finally {
      await h.engine.close();
      h.store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("closing check pieces", () => {
  test("the payload puts this turn's files first, reads their heads, and carries the job's history", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-closing-payload-"));
    writeFileSync(join(root, "report.md"), "# 周报\n");
    writeFileSync(join(root, "chart.png"), Buffer.from([0x89, 0x50]));
    const store = new Store();
    try {
      await store.patchSettings({ workspace_path: root });
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }).bot;
      const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
      const group = store.createGroup({ name: "Brief", members: [writer.id, reviewer.id] });
      const brief = store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "写周报，附趋势图" });
      const first = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: brief.id });
      const handoff = store.insertMessage({ sessionId: group.id, turnId: first.id, kind: "bot", author: writer.id, body: "初稿 report.md", paths: ["report.md"] });
      store.setTurnStatus(first.id, "completed");
      const second = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: handoff.id });
      const payload = closingCheckPayload(store, {
        taskId: second.task_id!,
        turnId: second.id,
        botId: reviewer.id,
        sessionId: group.id,
        reply: "图在 chart.png",
        paths: ["chart.png"],
        locale: "zh",
      })!;
      expect(payload.brief).toBe("写周报，附趋势图");
      expect(payload.deliveries).toEqual([
        { path: "chart.png", excerpt: null },
        { path: "report.md", excerpt: "# 周报\n" },
      ]);
      expect(payload.so_far).toEqual(["【user】写周报，附趋势图", "【Writer】初稿 report.md"]);
      // No brief, nothing to check against.
      store.db.run(`UPDATE tasks SET brief = NULL WHERE id = ?`, [second.task_id!]);
      expect(closingCheckPayload(store, { taskId: second.task_id!, turnId: second.id, botId: reviewer.id, sessionId: group.id, reply: "", paths: ["chart.png"], locale: "zh" })).toBeNull();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
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

  test("a verdict parses through a fence, drops blank items, caps the list, and rejects the wrong shape", () => {
    expect(parseClosingCheck('```json\n{"unaddressed":[{"text":" 附 图 ","why":"没看到"},{"text":"","why":"x"}]}\n```')).toEqual([
      { text: "附 图", why: "没看到" },
    ]);
    expect(parseClosingCheck('{"unaddressed":[]}')).toEqual([]);
    expect(parseClosingCheck('{"unaddressed":"none"}')).toBeNull();
    expect(parseClosingCheck('{"unaddressed":[1]}')).toBeNull();
    expect(parseClosingCheck("nope")).toBeNull();
    const many = Array.from({ length: CLOSING_ITEMS_LIMIT + 3 }, (_, i) => ({ text: `r${i}`, why: "" }));
    expect(parseClosingCheck(JSON.stringify({ unaddressed: many }))).toHaveLength(CLOSING_ITEMS_LIMIT);
  });

  test("the note reads in the turn's locale", () => {
    expect(closingCheckNote("zh", [{ text: "附趋势图", why: "没看到" }, { text: "交到 report.md", why: "" }])).toBe(
      "收尾自检：对照这件事最初的要求，下面这些既没有交出，收尾里也没有交代去向：\n- 附趋势图（没看到）\n- 交到 report.md\n补上，或在收尾里说明交给谁、为什么不交、什么时候做，再结束。这一轮只提示这一次。",
    );
    expect(closingCheckNote("en", [{ text: "a chart", why: "none seen" }])).toContain("- a chart (none seen)");
    expect(closingCheckNote("en", [{ text: "a chart", why: "" }])).toContain("Closing check:");
  });
});
