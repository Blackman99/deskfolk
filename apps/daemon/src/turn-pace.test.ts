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
import { checkInNote, TURN_CHECK_IN_HOPS, turnPace } from "./turn-pace";

test("a turn is asked every 40 hops whether it is getting anywhere, however long it runs", () => {
  expect(turnPace(1)).toBe("go");
  expect(turnPace(TURN_CHECK_IN_HOPS)).toBe("go");
  expect(turnPace(TURN_CHECK_IN_HOPS + 1)).toBe("check_in");
  expect(turnPace(2 * TURN_CHECK_IN_HOPS + 1)).toBe("check_in");
  expect(turnPace(1000)).toBe("go");
  expect(turnPace(25 * TURN_CHECK_IN_HOPS + 1)).toBe("check_in");
  // A check-in cannot ask for a progress message: sending one ends the turn.
  expect(checkInNote("zh", 40)).toContain("40 跳");
  expect(checkInNote("zh", 40)).toContain("不用回应这条");
  expect(checkInNote("en", 40)).toContain("do not answer this note");
  // Nor does it promise an end: the tools are never taken away (2026-10-17).
  expect(checkInNote("zh", 40)).not.toContain("收起工具");
  expect(checkInNote("en", 40)).not.toContain("taken away");
});

test("an engine's pacing moves the check-in", () => {
  expect(turnPace(21, 20)).toBe("check_in");
  expect(turnPace(41, 20)).toBe("check_in");
  expect(turnPace(61, 20)).toBe("check_in");
  expect(turnPace(62, 20)).toBe("go");
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

/** Past both hop limits the app had until 2026-10-17 (160, the video engine 200). */
const LONG_RUN = 210;

test("a turn that keeps calling tools is checked in on, and keeps its tools until it answers", async () => {
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
        // It polls the way a long render does, and answers once the job is through.
        const polls = requests.filter((r) => r.tools.length > 0).length;
        if (polls > LONG_RUN) return { ...base, content: "视频出来了，成片在 out/final.mp4。", toolCalls: [] };
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
  expect(turns).toHaveLength(LONG_RUN + 1);
  expect(lastUserLine(turns[TURN_CHECK_IN_HOPS]!)).toBe(checkInNote("zh", TURN_CHECK_IN_HOPS));
  expect(lastUserLine(turns[2 * TURN_CHECK_IN_HOPS]!)).toBe(checkInNote("zh", 2 * TURN_CHECK_IN_HOPS));
  expect(lastUserLine(turns[5 * TURN_CHECK_IN_HOPS]!)).toBe(checkInNote("zh", 5 * TURN_CHECK_IN_HOPS));
  expect(lastUserLine(turns[TURN_CHECK_IN_HOPS - 1]!)).not.toContain("应用提示");
  // Every hop is offered its tools, the last one too: the turn ends because it answered.
  expect(turns.every((turn) => turn.tools.length > 0)).toBe(true);
  const said = store.listMessages(director.direct_session.id).items.filter((m) => m.kind === "bot");
  expect(said.at(-1)?.body).toContain("视频出来了");
}, 30_000);
