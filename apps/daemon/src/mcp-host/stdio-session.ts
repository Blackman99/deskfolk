/** An MCP server run as a child process speaking JSON-RPC over stdio, and how it is spawned (Windows cmd escaping included). */
import { childEnv, listMcpTools, type Era, type McpServerSpec, type Pending } from "../mcp-host";
import type { McpListedTool } from "../mcp-names";
import { killProcessTree } from "../platform";
import { drain, modernMeta, RpcError, waitFor } from "./rpc";

// Windows argv/cmd.exe escaping below, ported from cross-spawn (MIT,
// github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js) — a battle-tested
// answer to a real CVE class (Node's own GHSA-hhm8-gxrj-9xpr): quoting an argument for the MSVCRT
// argv parser is not enough, because cmd.exe's *own* metacharacters (`&|<>^%` and friends) are
// still live inside a quoted `.cmd`/`.bat` invocation unless escaped again with `^`.
const CMD_META_CHARS = /([()[\]%!^"`<>&|;, *?])/g;

function windowsCmdEscapeCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

function windowsCmdEscapeArgument(arg: string): string {
  let escaped = arg;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  return escaped;
}

/**
 * `npx` on Windows is `npx.cmd`, a batch file — you cannot `CreateProcess` a `.cmd`/`.bat`
 * directly, only through `cmd.exe /c`. `Bun.which` resolves the command the way a shell would
 * (honouring `PATHEXT`), and only a resolved `.cmd`/`.bat` target is routed through `cmd.exe`;
 * a real executable (`.exe`) still spawns directly, unchanged. MCP server command/args come from
 * config the user reviewed and approved, but that is still attacker-adjacent input (a shared MCP
 * config, a compromised registry package), so every argument is escaped rather than trusted.
 */
export function windowsSpawnPlan(
  command: string,
  args: string[],
  env: Record<string, string>,
  which: (name: string, opts: { PATH?: string }) => string | null = (name, opts) => Bun.which(name, opts) ?? null,
): { command: string; args: string[]; verbatim: boolean } {
  const resolved = which(command, { PATH: env.PATH }) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, verbatim: false };
  const shellCommand = [windowsCmdEscapeCommand(resolved), ...args.map(windowsCmdEscapeArgument)].join(" ");
  const comspec = env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  return { command: comspec, args: ["/d", "/s", "/c", `"${shellCommand}"`], verbatim: true };
}

export function spawnChild(server: McpServerSpec): Bun.Subprocess | null {
  try {
    const env = childEnv();
    if (process.platform === "win32") {
      const plan = windowsSpawnPlan(server.command, server.args, env);
      return Bun.spawn([plan.command, ...plan.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
        windowsVerbatimArguments: plan.verbatim,
      });
    }
    return Bun.spawn([server.command, ...server.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  } catch {
    return null;
  }
}

export class StdioSession {
  dead = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly encoder = new TextEncoder();
  private closing: Promise<void> | null = null;
  private readonly deadHooks: Array<() => void> = [];
  private readonly era: Era;
  private readonly requestTimeoutMs: number;
  private readonly shutdownWaitMs: number;
  private readonly proc: Bun.Subprocess;

  constructor(
    proc: Bun.Subprocess,
    opts: { era: Era; requestTimeoutMs: number; shutdownWaitMs: number },
  ) {
    this.proc = proc;
    this.era = opts.era;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.shutdownWaitMs = opts.shutdownWaitMs;
    void this.readStdout();
    void drain(this.proc.stderr);
    void this.proc.exited.then(() => this.markDead(new Error("mcp server exited")));
  }

  onDead(hook: () => void): void {
    this.deadHooks.push(hook);
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", method, params: this.withMeta(method, params, false) });
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.dead) throw new Error("mcp server exited");
    if (signal?.aborted) throw new Error("mcp call aborted");
    const id = this.nextId++;
    const payload = this.withMeta(method, params, true);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
        finish(() => reject(new Error("mcp call aborted")));
      };
      const timer = setTimeout(() => {
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        finish(() => reject(new Error("mcp request timed out")));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        timer,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params: payload });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error("mcp write failed")));
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async listTools(): Promise<McpListedTool[]> {
    return listMcpTools((params) => this.request("tools/list", params));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.shutdown();
    return this.closing;
  }

  private withMeta(
    method: string,
    params: Record<string, unknown>,
    isRequest: boolean,
  ): Record<string, unknown> {
    if (this.era !== "modern" || method === "notifications/cancelled") return params;
    if (!isRequest && method.startsWith("notifications/")) return params;
    const existing =
      params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
        ? (params._meta as Record<string, unknown>)
        : {};
    return { ...params, _meta: { ...modernMeta(), ...existing } };
  }

  private write(obj: unknown): void {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("mcp stdin is closed");
    stdin.write(this.encoder.encode(`${JSON.stringify(obj)}\n`));
  }

  private async readStdout(): Promise<void> {
    const stdout = this.proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const decoder = new TextDecoder();
    let buf = "";
    const reader = stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        while (true) {
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.onLine(line);
        }
      }
    } catch {
      // process ended
    }
    this.markDead(new Error("mcp server exited"));
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as {
      id?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.error && typeof msg.error === "object") {
      const code = typeof msg.error.code === "number" ? msg.error.code : -32603;
      const message = typeof msg.error.message === "string" ? msg.error.message : "mcp error";
      pending.reject(new RpcError(code, message));
      return;
    }
    const result =
      msg.result && typeof msg.result === "object" && !Array.isArray(msg.result)
        ? (msg.result as Record<string, unknown>)
        : {};
    pending.resolve(result);
  }

  private markDead(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const hook of this.deadHooks) hook();
  }

  private async shutdown(): Promise<void> {
    this.markDead(new Error("mcp server closed"));
    const stdin = this.proc.stdin;
    try {
      if (stdin && typeof stdin !== "number") stdin.end();
    } catch {
      // already closed
    }
    const exited = await waitFor(this.proc.exited, this.shutdownWaitMs);
    if (!exited) {
      // On win32 a signal only ever reaches the direct child; an npx-launched `cmd → node` chain
      // would outlive it. killProcessTree walks the whole tree there instead.
      if (process.platform === "win32") {
        killProcessTree(this.proc.pid);
      } else {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          // gone
        }
      }
      const afterTerm = await waitFor(this.proc.exited, this.shutdownWaitMs);
      if (!afterTerm) {
        if (process.platform === "win32") {
          killProcessTree(this.proc.pid);
        } else {
          try {
            this.proc.kill("SIGKILL");
          } catch {
            // gone
          }
        }
        await this.proc.exited;
      }
    }
  }
}
