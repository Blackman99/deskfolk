import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFrame, ToolFrame } from "@real-bot/protocol";
import type { CompletionOk } from "./completions";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

/**
 * The delivery path a watcher depends on: a command announces itself, its bytes arrive while it
 * runs, and it says how it ended. Driven through the real socket rather than the publish
 * function, because the interesting failures are the ones where a frame is filtered out on the
 * way — `turn.tool` used to be dropped twice before it reached anyone.
 */
function call(name: string, args: Record<string, unknown>): CompletionOk {
  return {
    ok: true, content: "", toolCalls: [{ id: "call_1", name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null,
  };
}

test("a Bot's command is visible while it runs, and says how it ended", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bot-visible-")));
  const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
  let hops = 0;
  const api = createLocalApi({
    store, token: "fixture", schedule: false,
    completions: {
      async complete(request) {
        hops++;
        const results = request.messages.filter((m) => m.role === "tool");
        if (!results.length) return call("shell", { command: "echo LIVE_MARK; sleep 1; echo DONE_MARK", cwd: "." });
        return { ok: true, content: "ran it", toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
      },
      async judge() { throw new Error("direct turns do not judge"); },
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const origin = `http://${server.hostname}:${server.port}`;

  const tools: ToolFrame[] = [];
  const streams: StreamFrame[] = [];
  const socket = new WebSocket(`${origin.replace("http", "ws")}/v1/events`);
  await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
  socket.send(JSON.stringify({ type: "auth", token: "fixture", protocol: "sync-v1" }));
  let authed!: () => void;
  const ready = new Promise<void>((resolve) => { authed = resolve; });
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "ready") authed();
    if (frame.type === "tool") {
      tools.push(frame);
      // Watch as soon as it announces itself: nothing is sent to a client that never asks.
      if (frame.phase === "started") {
        void fetch(`${origin}/v1/streams/watch`, {
          method: "POST",
          headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
          body: JSON.stringify({ id: `${frame.turn_id}:${frame.id}`, from: 0 }),
        });
      }
    }
    if (frame.type === "stream") streams.push(frame);
  };

  try {
    // Frames are only delivered to an authenticated socket, so the turn must not start first.
    await ready;
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1",
      endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    const bot = store.createBot({ name: "Builder", duties: "build", boundaries: "stay" });
    const trigger = store.insertMessage({ sessionId: bot.direct_session.id, kind: "user", author: "user", body: "跑一下" });
    await api.engine.handleInboundMessage(trigger, { fromUser: true });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !tools.some((frame) => frame.phase === "exited")) await Bun.sleep(100);

    const started = tools.find((frame) => frame.phase === "started");
    const exited = tools.find((frame) => frame.phase === "exited");
    expect(started?.name).toBe("shell");
    // The command line rides along, so a folded row can name itself rather than say "shell".
    expect(started?.command).toContain("LIVE_MARK");
    expect(exited?.exit_code).toBe(0);
    expect(exited?.duration_ms).toBeGreaterThan(0);

    const text = streams.map((frame) => Buffer.from(frame.data, "base64").toString("utf8")).join("");
    expect(text).toContain("LIVE_MARK");
    expect(text).toContain("DONE_MARK");
    // The first bytes arrived before the command finished; that is the entire point.
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.at(-1)?.closed ?? streams.some((frame) => frame.closed)).toBe(true);
    expect(hops).toBe(2);
  } finally {
    socket.close();
    api.terminals.shutdown();
    await api.engine.close();
    store.close();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a client that never watches is sent nothing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bot-unwatched-")));
  const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
  const api = createLocalApi({
    store, token: "fixture", schedule: false,
    completions: {
      async complete(request) {
        const results = request.messages.filter((m) => m.role === "tool");
        if (!results.length) return call("shell", { command: "echo QUIET_MARK", cwd: "." });
        return { ok: true, content: "done", toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
      },
      async judge() { throw new Error("direct turns do not judge"); },
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const origin = `http://${server.hostname}:${server.port}`;
  const frames: Array<{ type?: string }> = [];
  const socket = new WebSocket(`${origin.replace("http", "ws")}/v1/events`);
  await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
  socket.send(JSON.stringify({ type: "auth", token: "fixture", protocol: "sync-v1" }));
  let authed2!: () => void;
  const ready2 = new Promise<void>((resolve) => { authed2 = resolve; });
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "ready") authed2();
    frames.push(frame);
  };

  try {
    await ready2;
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1",
      endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    const bot = store.createBot({ name: "Quiet", duties: "build", boundaries: "stay" });
    const trigger = store.insertMessage({ sessionId: bot.direct_session.id, kind: "user", author: "user", body: "跑一下" });
    await api.engine.handleInboundMessage(trigger, { fromUser: true });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !frames.some((frame) => frame.type === "tool" && (frame as ToolFrame).phase === "exited")) await Bun.sleep(100);

    expect(frames.some((frame) => frame.type === "tool")).toBe(true);
    expect(frames.some((frame) => frame.type === "stream")).toBe(false);
  } finally {
    socket.close();
    api.terminals.shutdown();
    await api.engine.close();
    store.close();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
