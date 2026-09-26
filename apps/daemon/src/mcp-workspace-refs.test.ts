import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionOk, CompletionRequest, JudgeResult } from "./completions";
import type { McpHost } from "./mcp-host";
import { inlineWorkspaceRefs } from "./mcp-workspace-refs";
import type { ChatTool } from "./prompts/tool-schema";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

/** A 1×1 PNG. */
const DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-refs-"));
  dirs.push(root);
  mkdirSync(join(root, "frames"));
  writeFileSync(join(root, "frames", "c01.png"), DOT);
  writeFileSync(join(root, "notes.md"), "# notes");
  return root;
}

test("a workspace:// picture goes out as its data URI, wherever it sits in the arguments", () => {
  const root = workspace();
  const uri = `data:image/png;base64,${DOT.toString("base64")}`;
  const out = inlineWorkspaceRefs(
    { prompt: "start from workspace://frames/c01.png", image: "workspace://frames/c01.png", reference_images: ["workspace://frames/c01.png", "https://example.com/a.png"], nested: { at: ["workspace://frames/c01.png"] }, n: 2 },
    root,
  );
  expect(out).toEqual({
    ok: true,
    inlined: 3,
    args: {
      // Only a string that is the reference itself is replaced, never one that mentions it.
      prompt: "start from workspace://frames/c01.png",
      image: uri,
      reference_images: [uri, "https://example.com/a.png"],
      nested: { at: [uri] },
      n: 2,
    },
  });
});

test("arguments with no reference go out untouched, as the same object", () => {
  const args = { prompt: "a cat", image: "https://example.com/a.png" };
  const out = inlineWorkspaceRefs(args, workspace());
  expect(out.ok && out.args).toBe(args);
});

test("a reference that cannot be honoured fails the call with a reason, instead of sending a broken URL", () => {
  const root = workspace();
  const reason = (ref: string, at: string | null = root) => {
    const out = inlineWorkspaceRefs({ image: ref }, at);
    return out.ok ? "sent" : out.message;
  };
  expect(reason("workspace://frames/missing.png")).toContain("no such file");
  expect(reason("workspace://notes.md")).toContain("only pictures");
  expect(reason("workspace://../../etc/hosts.png")).toContain("outside the workspace");
  expect(reason("workspace://frames")).toContain("only pictures");
  expect(reason("workspace://")).toContain("write the picture's path");
  expect(reason("workspace://frames/c01.png", null)).toContain("no workspace");
});

test.skipIf(process.platform !== "darwin")("a large picture goes as the smaller copy a vision model gets", () => {
  const root = workspace();
  // A noisy 2400×1350 frame, far past the half-megabyte a picture goes out as it is.
  const raw = join(root, "frames", "noise.bmp");
  const width = 2400;
  const height = 1350;
  const row = width * 3 + ((4 - ((width * 3) % 4)) % 4);
  const header = Buffer.alloc(54);
  header.write("BM", 0);
  header.writeUInt32LE(54 + row * height, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  const pixels = Buffer.alloc(row * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) >>> 24;
  writeFileSync(raw, Buffer.concat([header, pixels]));
  const png = join(root, "frames", "big.png");
  expect(spawnSync("sips", ["-s", "format", "png", raw, "--out", png]).status).toBe(0);
  const out = inlineWorkspaceRefs({ image: "workspace://frames/big.png" }, root);
  expect(out.ok).toBe(true);
  const uri = out.ok ? String(out.args.image) : "";
  expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").byteLength).toBeLessThan(statSync(png).size);
});

test("the MCP server gets the picture while the model's own call keeps the short reference", async () => {
  const root = workspace();
  const tool: ChatTool = {
    type: "function",
    function: {
      name: "studio__submit_video",
      description: "Submit a video job",
      parameters: { type: "object", properties: { image: { type: "string" } } },
    },
  };
  const sent: Array<Record<string, unknown>> = [];
  const mcp: McpHost = {
    listChatTools: async () => [tool],
    listForTurn: async () => ({ tools: [tool], guides: [{ name: "studio", instructions: null, tools: [{ modelName: tool.function.name, description: "Submit a video job" }] }] }),
    inspect: async () => ({ instructions: null, tools: [] }),
    call: async (_name, args) => {
      sent.push(args);
      return { ok: true, data: { request_id: "r1" } };
    },
    close: async () => {},
  };
  const store = new Store({ endpointKey: memoryKeyStore() });
  const requests: CompletionRequest[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => (done = resolve));
  const engine = createTurnEngine({
    store,
    settleQuietMs: 60_000,
    mcp,
    publish(event) {
      if (event.event === "turn.upsert" && event.status === "completed") done();
    },
    completions: {
      async complete(request: CompletionRequest): Promise<CompletionOk> {
        requests.push(request);
        const base = { ok: true as const, finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
        const hop = requests.filter((row) => row.tools.length > 0).length;
        if (hop === 1) {
          return { ...base, content: "", toolCalls: [{ id: "call-1", name: tool.function.name, arguments: '{"image":"workspace://frames/c01.png"}' }] };
        }
        if (hop === 2) {
          return { ...base, content: "", toolCalls: [{ id: "call-2", name: tool.function.name, arguments: '{"image":"workspace://frames/none.png"}' }] };
        }
        return { ...base, content: "已提交，等视频出来。", toolCalls: [] };
      },
      async judge(): Promise<JudgeResult> {
        return { content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
      },
    },
  });
  closes.push(async () => {
    await engine.close();
    store.close();
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  const director = store.createBot({ name: "视频导演", duties: "make videos", boundaries: "stay" });
  const trigger = store.insertMessage({ sessionId: director.direct_session.id, kind: "user", author: "user", body: "用 C01 首帧出视频" });
  await engine.handleInboundMessage(trigger, { fromUser: true });
  await finished;

  // The first call reached the server as pixels; the second, pointing at nothing, never left.
  expect(sent).toEqual([{ image: `data:image/png;base64,${DOT.toString("base64")}` }]);
  const third = requests.filter((row) => row.tools.length > 0)[2]!;
  const seen = JSON.stringify(third.messages);
  expect(seen).toContain("workspace://frames/c01.png");
  expect(seen).not.toContain("data:image/png;base64");
  const results = third.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  expect(results.at(-1)).toContain("no such file in the workspace");
  // The prompt tells the Bot how to hand a picture over.
  const system = String(third.messages.find((m) => m.role === "system")?.content ?? "");
  expect(system).toContain("workspace://<相对工作区根的路径>");
});
