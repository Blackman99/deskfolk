import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
import { memoryKeyStore } from "./secrets";
import { createTurnEngine } from "./turn-engine";
import type { CompletionOk } from "./completions";
import type { McpHost } from "./mcp-host";

function call(name: string, args: Record<string, unknown>): CompletionOk {
  return { ok: true, content: "", toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

test("a turn recovers a large MCP image through the saved JSON without asking the user", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-recovery-turn-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const bytes = Buffer.alloc(900000, 42);
  const output = { content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }, { type: "text", text: "https://example.test/image.png" }] };
  let mcpCalls = 0;
  let hops = 0;
  const mcp: McpHost = {
    async listChatTools() { return []; },
    async listForTurn() { return { tools: [], guides: [] }; },
    async inspect() { return { instructions: null, tools: [] }; },
    async call() { mcpCalls++; return { ok: true, data: output }; },
    async close() {},
  };
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const engine = createTurnEngine({ store, publish(event) {
    if (event.event === "turn.upsert" && event.status === "completed") finished();
  }, mcp, completions: {
    async complete(request) {
      hops++;
      const results = request.messages.filter((m) => m.role === "tool");
      if (!results.length) return call("mcp_fixture_image", {});
      const latest = JSON.parse(String(results.at(-1)?.content));
      if (results.length === 1) {
        expect(latest.full_result_saved).toBe(true);
        expect(latest.full_result_path).toBeTruthy();
        expect(JSON.parse(readFileSync(join(root, latest.full_result_path), "utf8"))).toEqual({ ok: true, data: output });
        const script = `const fs=require('fs'); const r=JSON.parse(fs.readFileSync(${JSON.stringify(latest.full_result_path)},'utf8')); fs.writeFileSync('recovered.png',Buffer.from(r.data.content[0].data,'base64')); console.log(fs.statSync('recovered.png').size);`;
        return call("write_file", { path: "recover.js", content: script });
      }
      // `full_result_path` and write_file are both workspace-root relative; the shell is not.
      if (results.length === 2) return call("shell", { command: "bun recover.js", cwd: "." });
      expect(latest.ok).toBe(true);
      expect(latest.data.exit_code).toBe(0);
      expect(latest.data.stdout.trim()).toBe("900000");
      return call("send_message", { body: "已恢复图片：recovered.png" });
    },
    async judge() { throw new Error("direct turns do not judge"); },
  } });
  try {
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1", endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    const bot = store.createBot({ name: "Recovery", duties: "recover", boundaries: "stay" });
    const trigger = store.insertMessage({ sessionId: bot.direct_session.id, kind: "user", author: "user", body: "生成并保存图片" });
    await engine.handleInboundMessage(trigger, { fromUser: true });
    await done;
    expect(mcpCalls).toBe(1);
    expect(hops).toBe(4);
    expect(readFileSync(join(root, "recovered.png"))).toEqual(bytes);
    const messages = store.listMainMessages(bot.direct_session.id, 20);
    expect(messages.filter((m) => m.kind === "ask" || m.kind === "approval")).toHaveLength(0);
    expect(messages.some((m) => m.kind === "bot" && m.body.includes("已恢复图片"))).toBe(true);
  } finally {
    await engine.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
