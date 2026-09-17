import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMcpHost, type McpHost } from "./mcp-host";

const fixture = join(import.meta.dir, "mcp-fixture.ts");

const hosts: McpHost[] = [];
const procs: Array<{ kill: () => void }> = [];

afterEach(async () => {
  while (hosts.length) await hosts.pop()?.close();
  while (procs.length) procs.pop()?.kill();
});

function server(name: string, flag?: string) {
  return {
    id: name,
    name,
    command: process.execPath,
    args: flag ? [fixture, flag] : [fixture],
    enabled: true,
    instructions: null,
  };
}

function start(servers: ReturnType<typeof server>[], builtin: string[] = []) {
  const host = createMcpHost({
    listServers: () => servers,
    builtinNames: builtin,
    probeTimeoutMs: 400,
    requestTimeoutMs: 2000,
    shutdownWaitMs: 200,
  });
  hosts.push(host);
  return host;
}

function pidFrom(result: Awaited<ReturnType<McpHost["call"]>>): number {
  expect(result.ok).toBe(true);
  if (!result.ok) return 0;
  const content = result.data.content as Array<{ text: string }>;
  const pid = Number(content[0]?.text);
  expect(pid).toBeGreaterThan(0);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidsMatching(token: string): Promise<number[]> {
  const proc = Bun.spawn(["ps", "-ax", "-o", "pid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space < 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const command = trimmed.slice(space + 1);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!command.includes("mcp-fixture.ts") || !command.includes(token)) continue;
    pids.push(pid);
  }
  return pids;
}

async function waitForTaggedPids(token: string, expected: number): Promise<number[]> {
  const deadline = Date.now() + 1_000;
  let pids = await pidsMatching(token);
  while (Date.now() < deadline && pids.length !== expected) {
    await Bun.sleep(50);
    pids = await pidsMatching(token);
  }
  return pids;
}

describe("MCP stdio host", () => {
  test("modern handshake lists prefixed tools and echo returns ok data", async () => {
    const host = start([server("probe")]);
    const tools = await host.listChatTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("mcp_probe_echo");
    expect(names).toContain("mcp_probe_boom");
    const echo = tools.find((t) => t.function.name === "mcp_probe_echo");
    expect(echo?.function.description).toBe("echo text");
    expect(echo?.function.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });

    const result = await host.call("mcp_probe_echo", { text: "ping" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.data.content as Array<{ type: string; text: string }>;
    expect(content[0]).toEqual({ type: "text", text: "ping" });
  });

  test("legacy initialize still lists and calls", async () => {
    const host = start([server("legacy", "--legacy-only")]);
    const tools = await host.listChatTools();
    expect(tools.map((t) => t.function.name)).toContain("mcp_legacy_echo");
    const result = await host.call("mcp_legacy_echo", { text: "hi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.data.content as Array<{ text: string }>;
    expect(content[0]?.text).toBe("hi");
  });

  test("probe process that exits on discover falls back to initialize", async () => {
    const host = start([server("old", "--exit-on-discover")]);
    const tools = await host.listChatTools();
    expect(tools.map((t) => t.function.name)).toContain("mcp_old_echo");
    const result = await host.call("mcp_old_echo", { text: "ok" });
    expect(result.ok).toBe(true);
  });

  test("MCP isError stays ok true with the original payload", async () => {
    const host = start([server("probe")]);
    await host.listChatTools();
    const result = await host.call("mcp_probe_boom", {});
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
    });
  });

  test("child exit during call is failed, not ok", async () => {
    const host = start([server("probe", "--crash-on-call")]);
    await host.listChatTools();
    const result = await host.call("mcp_probe_echo", { text: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("failed");
  });

  test("close ends the child process", async () => {
    const host = start([server("probe")]);
    await host.listChatTools();
    const pidResult = await host.call("mcp_probe_pid", {});
    expect(pidResult.ok).toBe(true);
    if (!pidResult.ok) return;
    const content = pidResult.data.content as Array<{ text: string }>;
    const pid = Number(content[0]?.text);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 0);
    await host.close();
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("disabled servers are not listed", async () => {
    const host = createMcpHost({
      listServers: () => [{ ...server("probe"), enabled: false }],
      probeTimeoutMs: 400,
      requestTimeoutMs: 2000,
      shutdownWaitMs: 200,
    });
    hosts.push(host);
    expect(await host.listChatTools()).toEqual([]);
  });

  test("inspect captures handshake instructions and tool catalog", async () => {
    const host = start([server("probe")]);
    const inspected = await host.inspect(server("probe"));
    expect(inspected.instructions).toContain("Echo text");
    expect(inspected.tools.map((t) => t.name)).toEqual(["echo", "boom", "pid"]);
  });

  test("listForTurn can keep only selected servers", async () => {
    const host = start([server("probe"), server("github", "--github")]);
    const listed = await host.listForTurn({ serverIds: ["github"] });
    expect(listed.tools.map((t) => t.function.name)).toEqual(["mcp_github_get_issue"]);
    expect(listed.guides).toHaveLength(1);
    expect(listed.guides[0]?.name).toBe("github");
    expect(listed.guides[0]?.instructions).toContain("GitHub");
  });

  test("collision suffixes stay stable when a turn lists a subset", async () => {
    const host = start([server("a-b"), server("a_b")]);
    const all = await host.listForTurn();
    const allNames = all.tools.map((t) => t.function.name);
    expect(allNames).toContain("mcp_a_b_echo");
    expect(allNames).toContain("mcp_a_b_echo_2");

    const subset = await host.listForTurn({ serverIds: ["a_b"] });
    const subsetNames = subset.tools.map((t) => t.function.name);
    expect(subsetNames).toContain("mcp_a_b_echo_2");
    expect(subsetNames).not.toContain("mcp_a_b_echo");
    expect(subset.guides).toHaveLength(1);
    expect(subset.guides[0]?.name).toBe("a_b");

    const second = await host.call("mcp_a_b_echo_2", { text: "n" });
    expect(second.ok).toBe(true);
    const first = await host.call("mcp_a_b_echo", { text: "m" });
    expect(first.ok).toBe(true);
  });

  test("listing a subset does not close another server's live connection", async () => {
    const host = start([server("probe"), server("github", "--github")]);
    await host.listForTurn();
    const pid = pidFrom(await host.call("mcp_probe_pid", {}));
    expect(isAlive(pid)).toBe(true);

    const listed = await host.listForTurn({ serverIds: ["github"] });
    expect(listed.tools.map((t) => t.function.name)).toEqual(["mcp_github_get_issue"]);
    expect(isAlive(pid)).toBe(true);

    const again = await host.call("mcp_probe_pid", {});
    expect(pidFrom(again)).toBe(pid);
  });

  test("disabled servers refuse calls and drop their live connection", async () => {
    const servers = [server("probe")];
    const host = start(servers);
    await host.listForTurn();
    const pid = pidFrom(await host.call("mcp_probe_pid", {}));
    expect(isAlive(pid)).toBe(true);

    servers[0] = { ...servers[0]!, enabled: false };
    const refused = await host.call("mcp_probe_pid", {});
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("unknown tool");
    expect(isAlive(pid)).toBe(false);
    expect(await host.listForTurn()).toEqual({ tools: [], guides: [] });
  });

  test("deleted servers refuse calls and drop their live connection", async () => {
    const servers = [server("probe"), server("github", "--github")];
    const host = start(servers);
    await host.listForTurn();
    const pid = pidFrom(await host.call("mcp_probe_pid", {}));
    expect(isAlive(pid)).toBe(true);

    servers.splice(0, 1);
    const refused = await host.call("mcp_probe_pid", {});
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("unknown tool");
    expect(isAlive(pid)).toBe(false);

    const listed = await host.listForTurn();
    expect(listed.tools.map((t) => t.function.name)).toEqual(["mcp_github_get_issue"]);
  });

  test("parallel listForTurn reuses one live session", async () => {
    const token = `reuse-${crypto.randomUUID()}`;
    const host = start([{ ...server("probe"), args: [fixture, token] }]);
    const [a, b] = await Promise.all([host.listForTurn(), host.listForTurn()]);
    const names = (listed: { tools: Array<{ function: { name: string } }> }) =>
      listed.tools.map((t) => t.function.name).sort();
    expect(names(a)).toEqual(names(b));
    expect(names(a)).toContain("mcp_probe_echo");

    const children = await waitForTaggedPids(token, 1);
    expect(children).toHaveLength(1);
    const pid = pidFrom(await host.call("mcp_probe_pid", {}));
    expect(children).toContain(pid);
    expect(pidFrom(await host.call("mcp_probe_pid", {}))).toBe(pid);
  });

  test("a connection update during handshake uses the updated server spec", async () => {
    const servers = [server("probe")];
    const host = start(servers);
    const original = host.inspect(servers[0]!);
    servers[0] = server("probe", "--github");
    const updated = host.inspect(servers[0]);
    const [, inspected] = await Promise.all([original, updated]);
    expect(inspected.tools.map((tool) => tool.name)).toEqual(["get_issue"]);
    expect(inspected.instructions).toContain("GitHub");
  });

  test("collision with a taken builtin name adds _2", async () => {
    const host = start([server("probe")], ["mcp_probe_echo"]);
    const tools = await host.listChatTools();
    expect(tools.map((t) => t.function.name)).toContain("mcp_probe_echo_2");
    const result = await host.call("mcp_probe_echo_2", { text: "n" });
    expect(result.ok).toBe(true);
  });
});

describe("MCP HTTP host", () => {
  async function startHttp(auth?: string, extraFlag?: string): Promise<{ url: string; close: () => void }> {
    const args = [process.execPath, fixture, "--http"];
    if (extraFlag) args.push(extraFlag);
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(auth ? { MCP_HTTP_AUTH: auth } : {}),
      },
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let port = 0;
    while (port === 0) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl < 0) continue;
      const line = buf.slice(0, nl).trim();
      const parsed = JSON.parse(line) as { port?: number };
      port = Number(parsed.port);
    }
    reader.releaseLock();
    procs.push(proc);
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      close: () => {
        proc.kill();
      },
    };
  }

  test("HTTP fixture lists prefixed tools and echo returns ok data", async () => {
    const http = await startHttp();
    try {
      const host = createMcpHost({
        listServers: () => [
          {
            id: "remote",
            name: "remote",
            transport: "http",
            command: "",
            args: [],
            url: http.url,
            headers: [],
            enabled: true,
            instructions: null,
          },
        ],
        probeTimeoutMs: 400,
        requestTimeoutMs: 2000,
        shutdownWaitMs: 200,
      });
      hosts.push(host);
      const tools = await host.listChatTools();
      expect(tools.map((t) => t.function.name)).toContain("mcp_remote_echo");
      const result = await host.call("mcp_remote_echo", { text: "hi" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const content = result.data.content as Array<{ text: string }>;
      expect(content[0]?.text).toBe("hi");
    } finally {
      http.close();
    }
  });

  test("HTTP fixture requires Authorization when configured", async () => {
    const http = await startHttp("Bearer secret");
    try {
      const denied = createMcpHost({
        listServers: () => [
          {
            id: "remote",
            name: "remote",
            transport: "http",
            command: "",
            args: [],
            url: http.url,
            headers: [],
            enabled: true,
            instructions: null,
          },
        ],
        probeTimeoutMs: 400,
        requestTimeoutMs: 2000,
        shutdownWaitMs: 200,
      });
      hosts.push(denied);
      expect(await denied.listChatTools()).toEqual([]);
      const allowed = createMcpHost({
        listServers: () => [
          {
            id: "remote",
            name: "remote",
            transport: "http",
            command: "",
            args: [],
            url: http.url,
            headers: [],
            auth: "Bearer secret",
            enabled: true,
            instructions: null,
          },
        ],
        probeTimeoutMs: 400,
        requestTimeoutMs: 2000,
        shutdownWaitMs: 200,
      });
      hosts.push(allowed);
      const tools = await allowed.listChatTools();
      expect(tools.map((t) => t.function.name)).toContain("mcp_remote_echo");
    } finally {
      http.close();
    }
  });

  test("HTTP legacy SSE after a 400 discover still lists tools", async () => {
    const http = await startHttp(undefined, "--http-legacy-sse");
    try {
      const host = createMcpHost({
        listServers: () => [
          {
            id: "remote",
            name: "remote",
            transport: "http",
            command: "",
            args: [],
            url: http.url,
            headers: [],
            enabled: true,
            instructions: null,
          },
        ],
        probeTimeoutMs: 400,
        requestTimeoutMs: 2000,
        shutdownWaitMs: 200,
      });
      hosts.push(host);
      const inspected = await host.inspect({
        id: "remote",
        name: "remote",
        transport: "http",
        command: "",
        args: [],
        url: http.url,
        headers: [],
        enabled: true,
        instructions: null,
      });
      expect(inspected.instructions).toContain("Echo text");
      expect(inspected.tools.map((t) => t.name)).toContain("echo");
      const result = await host.call("mcp_remote_echo", { text: "sse" });
      expect(result.ok).toBe(true);
    } finally {
      http.close();
    }
  });
});
