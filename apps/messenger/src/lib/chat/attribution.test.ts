import { expect, test } from "bun:test";
import { aMessage } from "../test-fixtures.ts";
import { attributable, attributionChipIds, filingKey, filingLabel, filingParts, rankPlans, type AttributionPlan } from "./attribution.ts";

const plans: AttributionPlan[] = [
  { id: "p1", title: "让审片员回复视频导演", tickets: [{ id: "t1", title: "回复视频导演" }] },
  { id: "p2", title: "海报", tickets: [] },
  { id: "p3", title: "把「你好」译成英文", tickets: [] },
  { id: "p4", title: "写一段 Python 代码", tickets: [{ id: "t4", title: "测试" }] },
];

function filed(id: string, at: string, filings: { task_id: string; ticket_id?: string | null; part_key?: string | null }[], over = {}) {
  return Object.assign(aMessage({ id, created_at: `2026-10-02T00:00:${at}.000Z`, ...over }), {
    filing_state: filings.length ? "filed" : "undetermined",
    filings: filings.map((row) => ({ ticket_id: null, part_key: null, ...row })),
  });
}

test("a filing is told by the job's title, then the ticket and part; an unloaded or missing job has no title rather than an id", () => {
  expect(filingParts({ task_id: "p1", ticket_id: "t1", part_key: "Shot 01" }, plans)).toEqual({ plan: "让审片员回复视频导演", ticket: "回复视频导演", part: "Shot 01" });
  expect(filingParts({ task_id: "gone", ticket_id: "t1", part_key: null }, plans)).toEqual({ plan: null, ticket: null, part: null });
  expect(filingLabel({ task_id: "p1", ticket_id: "t1", part_key: "Shot 01" }, plans)).toBe("让审片员回复视频导演 · 回复视频导演 · Shot 01");
  expect(filingLabel({ task_id: "gone", ticket_id: null, part_key: null }, plans, "一件事")).toBe("一件事");
});

test("only your lines and a Bot's are filed; the app's control lines are not", () => {
  expect(attributable(aMessage({ kind: "user" }))).toBe(true);
  expect(attributable(aMessage({ kind: "bot" }))).toBe(true);
  expect(attributable(aMessage({ kind: "user", control: { kind: "status_answer" } as never }))).toBe(false);
  expect(attributable(aMessage({ kind: "system" }))).toBe(false);
});

test("the key of a filing ignores order, and tells jobs, tickets and parts apart", () => {
  expect(filingKey(filed("a", "01", [{ task_id: "p1" }, { task_id: "p2" }]))).toBe(filingKey(filed("b", "02", [{ task_id: "p2" }, { task_id: "p1" }])));
  expect(filingKey(filed("a", "01", [{ task_id: "p1" }]))).not.toBe(filingKey(filed("b", "02", [{ task_id: "p1", ticket_id: "t1" }])));
  expect(filingKey(filed("a", "01", []))).toBe("");
});

test("a run of lines about the same thing shows its tag once, on the first line; a change starts a new run", () => {
  const messages = [
    filed("m1", "01", [{ task_id: "p1" }]),
    filed("m2", "02", [{ task_id: "p1" }], { kind: "bot", author: "bot-1" }),
    filed("m3", "03", [{ task_id: "p1" }]),
    filed("m4", "04", [{ task_id: "p2" }]),
    filed("m5", "05", [{ task_id: "p1" }]),
    filed("m6", "06", []),
    filed("m7", "07", []),
    aMessage({ id: "ctl", created_at: "2026-10-02T00:00:03.500Z", control: { kind: "status_answer" } as never }),
  ];
  expect([...attributionChipIds(messages)].sort()).toEqual(["m1", "m4", "m5", "m6"]);
});

test("runs are counted per conversation, and in time order whatever the order they arrive in", () => {
  const messages = [
    filed("b2", "02", [{ task_id: "p1" }], { session_id: "s-2" }),
    filed("a2", "02", [{ task_id: "p1" }], { session_id: "s-1" }),
    filed("a1", "01", [{ task_id: "p1" }], { session_id: "s-1" }),
    filed("b1", "01", [{ task_id: "p1" }], { session_id: "s-2" }),
  ];
  expect([...attributionChipIds(messages)].sort()).toEqual(["a1", "b1"]);
});

test("the list to choose from: chosen on top, then this conversation's jobs, then the rest; search reaches all of them", () => {
  const base = { plans, inConversation: new Set(["p2"]) };
  const ids = (list: AttributionPlan[]) => list.map((plan) => plan.id);
  const plain = rankPlans({ ...base, chosen: ["p1"], query: "" });
  expect([ids(plain.chosen), ids(plain.here), ids(plain.others)]).toEqual([["p1"], ["p2"], ["p3", "p4"]]);
  const found = rankPlans({ ...base, chosen: ["p1"], query: "python" });
  expect([ids(found.chosen), ids(found.here), ids(found.others)]).toEqual([["p1"], [], ["p4"]]);
  const byTicket = rankPlans({ ...base, chosen: [], query: " 测试 " });
  expect(ids(byTicket.others)).toEqual(["p4"]);
  const none = rankPlans({ ...base, chosen: [], query: "zzz" });
  expect([ids(none.chosen), ids(none.here), ids(none.others)]).toEqual([[], [], []]);
});
