import { expect, test } from "bun:test";
import { READ_BOT_LINE_SYSTEM, READ_FILING_SYSTEM, READ_SCALE_SYSTEM, READ_USER_LINE_SYSTEM } from "../src/prompts/reader";
import { turnSystemPrompt } from "../src/prompts/system";
import { classify, rpcKey } from "./demo-tape-keys";

const side = (system: string, payload: unknown) => ({
  messages: [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(payload) },
  ],
});

test("a Bot's turn is keyed by the name in its profile, in either language", () => {
  for (const locale of ["zh", "en"] as const) {
    const system = turnSystemPrompt({ locale, name: "Producer", duties: "make it", boundaries: "stay in the workspace" } as never);
    expect(classify({ stream: true, messages: [{ role: "system", content: system }] })).toBe("turn:Producer");
  }
});

test("each kind of line reading is keyed by the line it reads, and keeps its kind", () => {
  const said = "先停一下";
  const user = classify(side(READ_USER_LINE_SYSTEM, { said, where: "group", replying_to: null, recent: [] }));
  const filing = classify(side(READ_FILING_SYSTEM, { said, where: "group", jobs: [] }));
  const bot = classify(side(READ_BOT_LINE_SYSTEM, { said }));
  expect(user).toMatch(/^read_user:[0-9a-f]{12}$/);
  expect(filing).toMatch(/^read_filing:[0-9a-f]{12}$/);
  expect(bot).toMatch(/^read_bot:[0-9a-f]{12}$/);
  // The same words read for what they mean and for which job they are about stay two keys.
  expect(user.split(":")[1]).toBe(filing.split(":")[1]);
  expect(user).not.toBe(filing);
  // Another line, another key; the same line in another run (fresh ids) the same key.
  expect(classify(side(READ_USER_LINE_SYSTEM, { said: "继续" }))).not.toBe(user);
  const withId = (id: string) => classify(side(READ_BOT_LINE_SYSTEM, { said: `交付 ${id} 已提交` }));
  expect(withId("01M42ZB96V7PFZ978Z9W5RF8WW")).toBe(withId("01M43006B01TC5KWSXYG0TCNGA"));
});

test("a job's size is read by the lines you said about it", () => {
  const said = ["给「晨光」手冲壶做一支宣传短片：时长 6 秒"];
  const first = classify(side(READ_SCALE_SYSTEM, { job: { title: "晨光", goal: null }, said }));
  expect(first).toMatch(/^read_scale:[0-9a-f]{12}$/);
  // Read again later, as segments go by, from the same lines: the same key, told apart by order.
  expect(classify(side(READ_SCALE_SYSTEM, { job: { title: "晨光", goal: null }, said, facts: { segments: 3, handed_back: 0 } }))).toBe(first);
  expect(classify(side(READ_SCALE_SYSTEM, { job: { title: "晨光", goal: null }, said: [...said, "再加一版"] }))).not.toBe(first);
});

test("a call nothing recognises stays 'other'", () => {
  expect(classify(side("Something new the app asks a model", { said: "x" }))).toBe("other");
});

test("a check on a render is keyed by the job it asks about; other calls by the tool alone", () => {
  const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  expect(rpcKey(call("check_video", { request_id: "99d4fc0f" }))).toBe("call:check_video:99d4fc0f");
  expect(rpcKey(call("check_video", { job_id: 42 }))).toBe("call:check_video:42");
  expect(rpcKey(call("check_video", {}))).toBe("call:check_video");
  expect(rpcKey(call("submit_video", { prompt: "6 秒短片" }))).toBe("call:submit_video");
  expect(rpcKey({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe("tools/list");
});
