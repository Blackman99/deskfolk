import { expect, test } from "bun:test";
import type { Bot, Provider, RouteRecord } from "@real-bot/protocol";
import { routeLogRows, type RouteLogLabels } from "./route-log.ts";

const LABELS: RouteLogLabels = {
  fault: { model: "模型的问题", task: "事情本身难", prompt: "需求没说清", none: "没有不满" },
  direction: { stronger: "该更强", lighter: "该更轻", faster: "该更快", cheaper: "该更便宜", same: "不用动" },
  outcome: {
    live: "进行中",
    completed: "干净完成",
    failed: "失败",
    stopped: "被 Stop",
    redirected: "改道",
    interrupted: "中断",
  },
  signature: {
    coding: "写代码",
    writing: "写文案",
    reasoning: "推理",
    simple: "闲聊",
    general: "通用",
  },
  failReason: {
    unreachable: "连不上端点",
    refused: "端点拒绝了这次补全",
    incomplete: "回复不完整",
  },
  thinking: { none: "不思考", low: "低", medium: "中", high: "高" },
  unknownBot: "已删除",
};

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    duties: "",
    boundaries: "",
    avatar: null,
    model: null,
    provider_id: null,
    thinking_level: null,
    archived_at: null,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
  } as unknown as Bot;
}

function record(over: Partial<RouteRecord> = {}): RouteRecord {
  return {
    turn_id: "t1",
    session_id: "s1",
    bot_id: "b1",
    trigger_message_id: "m1",
    provider_id: "p1",
    model: "gpt-5",
    thinking_level: "medium",
    signature: "coding",
    outcome: "completed",
    fail_kind: null,
    reason: null,
    chain_id: "t1",
    created_at: "2026-09-18T01:00:00.000Z",
    finished_at: "2026-09-18T01:00:12.000Z",
    hops: null,
    tool_calls: null,
    tool_errors: null,
    repeated_failures: null,
    files_written: null,
    feedback: [],
    ...over,
  };
}

const BOTS = [bot("b1", "Writer"), bot("b2", "Reviewer")];

test("a finished choice reads as bot, model, thinking level, kind and how it ended", () => {
  const [row] = routeLogRows([record()], { bots: BOTS, providers: [], labels: LABELS });
  expect(row.botName).toBe("Writer");
  expect(row.botKnown).toBe(true);
  expect(row.model).toBe("gpt-5");
  expect(row.thinkingLevel).toBe("medium");
  expect(row.thinkingLabel).toBe("中");
  expect(row.signature).toBe("coding");
  expect(row.signatureLabel).toBe("写代码");
  expect(row.outcome).toBe("completed");
  expect(row.outcomeLabel).toBe("干净完成");
  expect(row.failReason).toBeNull();
  expect(row.triggerMessageId).toBe("m1");
  expect(row.durationMs).toBe(12000);
});

test("a live turn has no outcome yet and no duration", () => {
  const [row] = routeLogRows([record({ outcome: null, finished_at: null })], {
    bots: BOTS,
    providers: [],
    labels: LABELS,
  });
  expect(row.outcome).toBe("live");
  expect(row.outcomeLabel).toBe("进行中");
  expect(row.durationMs).toBeNull();
});

test("a failed turn carries the fail reason, and an unknown kind falls back to the raw kind", () => {
  const [known] = routeLogRows([record({ outcome: "failed", fail_kind: "refused" })], {
    bots: BOTS,
    providers: [],
    labels: LABELS,
  });
  expect(known.failReason).toBe("端点拒绝了这次补全");

  const [unknown] = routeLogRows([record({ outcome: "failed", fail_kind: "teapot" })], {
    bots: BOTS,
    providers: [],
    labels: LABELS,
  });
  expect(unknown.failReason).toBe("teapot");
});

test("only a failed turn shows a fail reason", () => {
  const [row] = routeLogRows([record({ outcome: "stopped", fail_kind: "refused" })], {
    bots: BOTS,
    providers: [],
    labels: LABELS,
  });
  expect(row.outcomeLabel).toBe("被 Stop");
  expect(row.failReason).toBeNull();
});

test("newest choice comes first", () => {
  const rows = routeLogRows(
    [
      record({ turn_id: "t1", created_at: "2026-09-18T01:00:00.000Z" }),
      record({ turn_id: "t2", created_at: "2026-09-18T02:00:00.000Z" }),
      record({ turn_id: "t3", created_at: "2026-09-18T03:00:00.000Z" }),
    ],
    { bots: BOTS, providers: [], labels: LABELS },
  );
  expect(rows.map((r) => r.turnId)).toEqual(["t3", "t2", "t1"]);
});

test("a deleted bot keeps its rows and is not clickable", () => {
  const [row] = routeLogRows([record({ bot_id: "gone" })], {
    bots: BOTS,
    providers: [],
    labels: LABELS,
  });
  expect(row.botName).toBe("已删除");
  expect(row.botKnown).toBe(false);
});

test("feedback rides along with the choice it landed on", () => {
  const [row] = routeLogRows(
    [
      record({
        feedback: [
          { message_id: "m9", body: "太慢了，换个模型", created_at: "2026-09-18T01:05:00.000Z" },
        ],
      }),
    ],
    { bots: BOTS, providers: [], labels: LABELS },
  );
  expect(row.feedback).toHaveLength(1);
  expect(row.feedback[0].body).toBe("太慢了，换个模型");
});

test("the endpoint name is resolved, and an old record without one has none", () => {
  const providers = [{ id: "p1", name: "OpenRouter" } as unknown as Provider];
  const [named] = routeLogRows([record()], { bots: BOTS, providers, labels: LABELS });
  expect(named.providerName).toBe("OpenRouter");

  const [legacy] = routeLogRows([record({ provider_id: null })], {
    bots: BOTS,
    providers,
    labels: LABELS,
  });
  expect(legacy.providerName).toBeNull();

  const [missing] = routeLogRows([record({ provider_id: "gone" })], {
    bots: BOTS,
    providers,
    labels: LABELS,
  });
  expect(missing.providerName).toBeNull();
});

test("an unknown signature or thinking level falls back to the raw value", () => {
  const [row] = routeLogRows(
    [record({ signature: "poetry", thinking_level: "extreme" as never })],
    { bots: BOTS, providers: [], labels: LABELS },
  );
  expect(row.signatureLabel).toBe("poetry");
  expect(row.thinkingLabel).toBe("extreme");
});

test("the picker's reason rides along with the row it explains", () => {
  const [row] = routeLogRows([record({ reason: "  要多步推理  " })], {
    bots: BOTS,
    providers: [],
    labels: LABELS,
  });
  expect(row.reason).toBe("要多步推理");
  // A turn the rules picked has nobody to explain it.
  const [plain] = routeLogRows([record()], { bots: BOTS, providers: [], labels: LABELS });
  expect(plain.reason).toBeNull();
});

test("a verdict shows on the turn that started the chain, and only blames the model when it did", () => {
  const review = {
    chain_id: "t1",
    turn_id: "t1",
    session_id: "s1",
    bot_id: "b1",
    signature: "coding",
    model: "gpt-5",
    thinking_level: "medium",
    rounds: 3,
    confidence: 0.9,
    reason: "反复改不对",
    created_at: "2026-09-18T02:00:00.000Z",
    retired_at: null,
    effect: null,
  };
  const [blamed] = routeLogRows([record()], {
    bots: BOTS,
    providers: [],
    reviews: [{ ...review, fault: "model" as const, direction: "stronger" as const }],
    labels: LABELS,
  });
  expect(blamed.review).toEqual({
    faultLabel: "模型的问题",
    directionLabel: "该更强",
    rounds: 3,
    reason: "反复改不对",
    blamedModel: true,
    effect: null,
    cleaner: false,
    retired: false,
  });

  // The @-mention correction case: the request was the problem, so there is no direction to give.
  const [spared] = routeLogRows([record()], {
    bots: BOTS,
    providers: [],
    reviews: [{ ...review, fault: "prompt" as const, direction: "same" as const }],
    labels: LABELS,
  });
  expect(spared.review).toMatchObject({ faultLabel: "需求没说清", directionLabel: null, blamedModel: false });

  // A review of some other chain does not attach itself here.
  const [none] = routeLogRows([record()], {
    bots: BOTS,
    providers: [],
    reviews: [{ ...review, turn_id: "other", fault: "model" as const, direction: "stronger" as const }],
    labels: LABELS,
  });
  expect(none.review).toBeNull();
});

test("a row carries the counted work, a retired review, and what the chain remembered", () => {
  const [row] = routeLogRows(
    [record({ hops: 4, tool_errors: 2, repeated_failures: 1, files_written: 0 })],
    {
      bots: BOTS,
      providers: [],
      reviews: [
        {
          chain_id: "t1",
          turn_id: "t1",
          session_id: "s1",
          bot_id: "b1",
          signature: "coding",
          model: "gpt-5",
          thinking_level: "medium",
          fault: "model",
          direction: "stronger",
          rounds: 2,
          confidence: 0.9,
          reason: "答得浅",
          created_at: "2026-09-18T02:00:00.000Z",
          retired_at: "2026-09-18T03:00:00.000Z",
          effect: { followed: "followed", cleaner: false },
        },
      ],
      learnings: [
        {
          chain_id: "t1",
          bot_id: "b1",
          session_id: "s1",
          kind: "memory",
          label: "重构先读现有函数",
          created_at: "2026-09-18T02:00:00.000Z",
          outcome: { later: 0, shorter: 0 },
        },
      ],
      labels: LABELS,
    },
  );
  expect(row.hops).toBe(4);
  expect(row.toolErrors).toBe(2);
  expect(row.review).toMatchObject({ retired: true, effect: "followed", cleaner: false });
  expect(row.learning).toEqual({ kind: "memory", label: "重构先读现有函数" });
});
