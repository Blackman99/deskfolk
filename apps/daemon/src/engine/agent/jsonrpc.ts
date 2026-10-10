/**
 * JSON-RPC over newline-delimited JSON on a child's stdin and stdout: how the Agent Client Protocol
 * and Codex's app-server both talk (ADR 0079). Either side may ask and answer. Codex leaves out the
 * `"jsonrpc": "2.0"` field and ACP agents expect it, so whether to write it is the caller's.
 */
import type { Readable, Writable } from "node:stream";

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null };

export type RpcPeer = {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** Requests from the other side; what the handler returns is the answer, what it throws the error. */
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** Settles every pending request with the error; no more are sent. */
  close(error?: Error): void;
  readonly closed: boolean;
};

export function rpcPeer(input: Readable, output: Writable, options: { jsonrpc: boolean; onUnparsed?: (line: string) => void; trace?: (direction: "in" | "out", message: unknown) => void }): RpcPeer {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number | string, Pending>();
  let requestHandler: (method: string, params: unknown) => Promise<unknown> = async () => {
    throw new RpcError(-32601, "method not found");
  };
  let notificationHandler: (method: string, params: unknown) => void = () => {};
  const write = (message: Record<string, unknown>) => {
    if (closed) return;
    try {
      options.trace?.("out", message);
      output.write(`${JSON.stringify(options.jsonrpc ? { jsonrpc: "2.0", ...message } : message)}\n`);
    } catch {
      // the child is gone; its exit settles what is pending
    }
  };
  let buffer = "";
  input.setEncoding?.("utf8");
  input.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        options.onUnparsed?.(line);
        continue;
      }
      options.trace?.("in", message);
      dispatch(message);
    }
  });
  const fail = (error: Error) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  };
  input.on("end", () => peer.close(new Error("the agent closed its output")));
  input.on("error", (error: Error) => peer.close(error));

  function dispatch(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : null;
    const id = message.id as number | string | undefined;
    if (method && id !== undefined && id !== null) {
      void requestHandler(method, message.params).then(
        (result) => write({ id, result: result ?? null }),
        (error: unknown) => {
          const rpc = error instanceof RpcError ? error : new RpcError(-32603, error instanceof Error ? error.message : String(error));
          write({ id, error: { code: rpc.code, message: rpc.message, ...(rpc.data !== undefined ? { data: rpc.data } : {}) } });
        },
      );
      return;
    }
    if (method) {
      try {
        notificationHandler(method, message.params);
      } catch (error) {
        console.error(`[agent rpc] notification ${method} failed`, error);
      }
      return;
    }
    if (id === undefined || id === null) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (error) entry.reject(new RpcError(typeof error.code === "number" ? error.code : -32603, typeof error.message === "string" ? error.message : "error", error.data));
    else entry.resolve(message.result);
  }

  const peer: RpcPeer = {
    request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      if (closed) return Promise.reject(new Error("the agent is gone"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} got no answer in ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs) : null;
        timer?.unref?.();
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        write({ id, method, ...(params !== undefined ? { params } : {}) });
      });
    },
    notify(method: string, params?: unknown): void {
      write({ method, ...(params !== undefined ? { params } : {}) });
    },
    onRequest(handler) {
      requestHandler = handler;
    },
    onNotification(handler) {
      notificationHandler = handler;
    },
    close(error = new Error("the agent is gone")) {
      if (closed) return;
      closed = true;
      fail(error);
    },
    get closed() {
      return closed;
    },
  };
  return peer;
}
