/**
 * Stdio MCP fixture for daemon tests. One JSON-RPC object per line on stdin/stdout.
 *
 * Flags:
 *   --legacy-only       reject server/discover (stay alive)
 *   --exit-on-discover  exit on server/discover (legacy servers that die on probe)
 *   --modern-only       reject initialize
 *   --crash-on-call     exit on tools/call
 *   --github            GitHub-shaped tools and instructions
 *   --media             Image and video tools with English descriptions
 *   --http              Streamable HTTP fixture; prints { port } then serves JSON-RPC
 */

const flags = new Set(process.argv.slice(2));
const legacyOnly = flags.has("--legacy-only") || flags.has("--exit-on-discover");
const exitOnDiscover = flags.has("--exit-on-discover");
const modernOnly = flags.has("--modern-only");
const crashOnCall = flags.has("--crash-on-call");
const github = flags.has("--github");
const media = flags.has("--media");

const tools = media
  ? [
      {
        name: "generate_image",
        description: "Generate an image from a prompt",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      },
      {
        name: "submit_video",
        description: "Submit a video generation job, then call check_video with its job_id",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      },
      {
        name: "check_video",
        description: "Check a video generation job and return its result",
        inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
      },
    ]
  : github
  ? [
      {
        name: "get_issue",
        description: "read a GitHub issue",
        inputSchema: {
          type: "object",
          properties: { number: { type: "number" } },
          required: ["number"],
        },
      },
    ]
  : [
      {
        name: "echo",
        description: "echo text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: "boom",
        description: "tool execution error",
        inputSchema: { type: "object" },
      },
      {
        name: "pid",
        description: "this process pid",
        inputSchema: { type: "object" },
      },
    ];

const instructions = media
  ? "Create images and videos. Use generate_image for pictures; submit_video then check_video for movies."
  : github
    ? "GitHub issues, pull requests, and repositories. Call get_issue to read an issue."
    : "Echo text back to the caller. Use echo for ping tests.";

let emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

function send(obj: unknown): void {
  emit(obj);
}

function listResult(modern: boolean): Record<string, unknown> {
  if (modern) {
    return { resultType: "complete", tools, ttlMs: 0, cacheScope: "private" };
  }
  return { tools };
}

function hasModernMeta(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const meta = (params as { _meta?: Record<string, unknown> })._meta;
  return Boolean(meta && meta["io.modelcontextprotocol/protocolVersion"]);
}

function handle(msg: {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}): void {
  const { id, method, params } = msg;
  if (!method) return;

  if (method === "server/discover") {
    if (exitOnDiscover) process.exit(1);
    if (legacyOnly) {
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          instructions,
          ttlMs: 0,
          cacheScope: "private",
        },
      });
    }
    return;
  }

  if (method === "initialize") {
    if (modernOnly) {
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "0.0.0" },
          instructions,
        },
      });
    }
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (method === "tools/list") {
    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, result: listResult(hasModernMeta(params) || !legacyOnly) });
    }
    return;
  }

  if (method === "tools/call") {
    if (crashOnCall) process.exit(1);
    const name = typeof params?.name === "string" ? params.name : "";
    const args =
      params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const modern = hasModernMeta(params);
    if (media && tools.some((tool) => tool.name === name)) {
      const text = name === "submit_video"
        ? JSON.stringify({ job_id: "fixture-video", status: "pending" })
        : name === "check_video"
          ? JSON.stringify({ job_id: args.job_id, status: "completed" })
          : `generate_image: ${String(args.prompt ?? "")}`;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          ...(modern ? { resultType: "complete" } : {}),
          content: [{ type: "text", text }],
        },
      });
      return;
    }
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          ...(modern ? { resultType: "complete" } : {}),
          content: [{ type: "text", text: String(args.text ?? "") }],
        },
      });
      return;
    }
    if (name === "boom") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          ...(modern ? { resultType: "complete" } : {}),
          isError: true,
          content: [{ type: "text", text: "boom" }],
        },
      });
      return;
    }
    if (name === "pid") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          ...(modern ? { resultType: "complete" } : {}),
          content: [{ type: "text", text: String(process.pid) }],
        },
      });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

const decoder = new TextDecoder();
let buf = "";

function consume(chunk: string): void {
  buf += chunk;
  while (true) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") {
      handle(parsed as { id?: string | number; method?: string; params?: Record<string, unknown> });
    }
  }
}

if (flags.has("--http")) {
  const requiredAuth = process.env.MCP_HTTP_AUTH ?? null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.MCP_HTTP_PORT ?? "0"),
    async fetch(request) {
      if (request.method === "DELETE") return new Response(null, { status: 202 });
      if (requiredAuth) {
        const got = request.headers.get("Authorization");
        if (got !== requiredAuth && got !== `Bearer ${requiredAuth}`) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await request.text());
      } catch {
        return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }, { status: 400 });
      }
      const msg = parsed as { id?: string | number; method?: string; params?: Record<string, unknown> };
      if (flags.has("--http-legacy-sse") && msg.method === "server/discover") {
        return Response.json(
          { jsonrpc: "2.0", id: "server-error", error: { code: -32600, message: "Bad Request: Missing session ID" } },
          { status: 400, headers: { "MCP-Session-Id": "bad-session" } },
        );
      }
      const replies: unknown[] = [];
      const previous = emit;
      emit = (obj) => {
        replies.push(obj);
      };
      try {
        handle(msg);
      } finally {
        emit = previous;
      }
      const reply = replies.at(-1);
      if (!reply) return new Response(null, { status: 202 });
      if (flags.has("--http-legacy-sse")) {
        const payload = `event: message\ndata: ${JSON.stringify(reply)}\n\n`;
        return new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "MCP-Session-Id": "fixture-session",
          },
        });
      }
      return Response.json(reply, {
        headers: { "MCP-Session-Id": "fixture-session" },
      });
    },
  });
  process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
} else {
  process.stdin.on("data", (chunk: Buffer | string) => {
    consume(typeof chunk === "string" ? chunk : decoder.decode(chunk));
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
  process.stdin.resume();
}
