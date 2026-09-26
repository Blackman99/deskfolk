import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, CompletionOk, CompletionRequest, JudgeResult } from "./completions";
import type { McpHost } from "./mcp-host";
import type { ChatTool } from "./prompts/tool-schema";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";
import { checkInNote, lastHopNote, TURN_CHECK_IN_HOPS, TURN_HOP_LIMIT, turnPace } from "./turn-pace";

test("a turn is asked every 40 hops whether it is getting anywhere, and past 160 its tools go", () => {
  expect(turnPace(1)).toBe("go");
  expect(turnPace(TURN_CHECK_IN_HOPS)).toBe("go");
  expect(turnPace(TURN_CHECK_IN_HOPS + 1)).toBe("check_in");
  expect(turnPace(2 * TURN_CHECK_IN_HOPS + 1)).toBe("check_in");
  expect(turnPace(TURN_HOP_LIMIT)).toBe("go");
  expect(turnPace(TURN_HOP_LIMIT + 1)).toBe("last");
  expect(turnPace(TURN_HOP_LIMIT + 2)).toBe("last");
  // Past the longest real turn seen (a video Bot's 141 polling hops), so real work is not cut off.
  expect(TURN_HOP_LIMIT).toBeGreaterThan(141);
  // A check-in cannot ask for a progress message: sending one ends the turn.
  expect(checkInNote("zh", 40)).toContain("40 跳");
  expect(checkInNote("zh", 40)).toContain("不用回应这条");
  expect(checkInNote("en", 40)).toContain("do not answer this note");
  expect(lastHopNote("zh")).toContain(`${TURN_HOP_LIMIT} 跳上限`);
});

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

const studio: ChatTool = {
  type: "function",
  function: {
    name: "studio__check_video",
    description: "Poll a video job",
    parameters: { type: "object", properties: { request_id: { type: "string" } } },
  },
};

function fakeMcp(): McpHost {
  return {
    async listChatTools() {
      return [studio];
    },
    async listForTurn() {
      return { tools: [studio], guides: [{ name: "studio", instructions: null, tools: [{ modelName: studio.function.name, description: "Poll a video job" }] }] };
    },
    async inspect() {
      return { instructions: null, tools: [] };
    },
    async call() {
      return { ok: true, data: { status: "pending" } };
    },
    async close() {},
  };
}

function lastUserLine(request: CompletionRequest): string {
  const users = request.messages.filter((m: ChatMessage) => m.role === "user");
  const last = users.at(-1)?.content;
  return typeof last === "string" ? last : "";
}

test("a turn that never stops calling tools is checked in on, then made to report and end", async () => {
  const root = mkdtempSync(join(tmpdir(), "pace-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const requests: CompletionRequest[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => (done = resolve));
  const engine = createTurnEngine({
    store,
    settleQuietMs: 60_000,
    mcp: fakeMcp(),
    publish(event) {
      if (event.event === "turn.upsert" && event.status === "completed") done();
    },
    completions: {
      async complete(request: CompletionRequest): Promise<CompletionOk> {
        requests.push(request);
        const base = { ok: true as const, finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
        // It polls forever, the way the runaway turn kept re-encoding: it only stops when it has to.
        if (request.tools.length === 0) return { ...base, content: "做完了轮询，卡在视频一直没出来，需要你看一下服务。", toolCalls: [] };
        return {
          ...base,
          content: "",
          toolCalls: [{ id: `call-${requests.length}`, name: studio.function.name, arguments: '{"request_id":"r1"}' }],
        };
      },
      async judge(): Promise<JudgeResult> {
        return { content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
      },
    },
  });
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  const director = store.createBot({ name: "视频导演", duties: "make videos", boundaries: "stay" });
  const trigger = store.insertMessage({ sessionId: director.direct_session.id, kind: "user", author: "user", body: "出成片" });
  await engine.handleInboundMessage(trigger, { fromUser: true });
  await finished;

  const turns = requests.filter((request) => request.messages.some((m) => m.role === "system"));
  expect(turns).toHaveLength(TURN_HOP_LIMIT + 1);
  expect(lastUserLine(turns[TURN_CHECK_IN_HOPS]!)).toBe(checkInNote("zh", TURN_CHECK_IN_HOPS));
  expect(lastUserLine(turns[2 * TURN_CHECK_IN_HOPS]!)).toBe(checkInNote("zh", 2 * TURN_CHECK_IN_HOPS));
  expect(lastUserLine(turns[TURN_CHECK_IN_HOPS - 1]!)).not.toContain("应用提示");
  expect(turns[TURN_HOP_LIMIT - 1]!.tools.length).toBeGreaterThan(0);
  expect(turns[TURN_HOP_LIMIT]!.tools).toEqual([]);
  expect(lastUserLine(turns[TURN_HOP_LIMIT]!)).toBe(lastHopNote("zh"));
  const said = store.listMessages(director.direct_session.id).items.filter((m) => m.kind === "bot");
  expect(said.at(-1)?.body).toContain("卡在视频一直没出来");
}, 30_000);
