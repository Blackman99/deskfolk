/**
 * Your `agy acp` (Antigravity, ADR 0111) for what the app asks of it besides a run: starting it
 * where a run would, the protocol's `initialize`, and a short-lived server for a question (listing
 * or reading your sessions) that nothing goes to a model for.
 */
import { spawn } from "node:child_process";
import daemonPackage from "../../package.json";
import { claudeLaunch } from "../claude-code/spawn";
import { rpcPeer, type RpcPeer } from "../engine/agent/jsonrpc";
import type { ResolvedAgent } from "./runtime";

export const AGY_ASK_TIMEOUT_MS = 30_000;

/** What `initialize` answers that the app reads: whether sessions can be listed, loaded and resumed. */
export type AgyCapabilities = { list: boolean; load: boolean; resume: boolean; image: boolean };

/**
 * The protocol's handshake. The client offers no file system and no terminal: `agy` uses its own
 * tools, as in its terminal, and the app checks each call it reports (`project-runner-agy.ts`).
 */
export async function initializeAgy(rpc: RpcPeer, timeoutMs = AGY_ASK_TIMEOUT_MS): Promise<AgyCapabilities> {
  const answer = await rpc.request<{ agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: Record<string, unknown>; promptCapabilities?: { image?: boolean } } }>("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" },
  }, timeoutMs);
  const caps = answer?.agentCapabilities ?? {};
  const session = caps.sessionCapabilities ?? {};
  return { list: "list" in session, load: caps.loadSession === true || "load" in session, resume: "resume" in session, image: caps.promptCapabilities?.image === true };
}

/** Starts `agy acp` in `dir`, initializes it, runs `ask` on it, and ends it, however `ask` ends. */
export async function withAgyAcp<T>(agy: Extract<ResolvedAgent, { ok: true }>, dir: string, ask: (rpc: RpcPeer, caps: AgyCapabilities) => Promise<T>, timeoutMs = AGY_ASK_TIMEOUT_MS): Promise<T> {
  const launch = claudeLaunch(agy.executable, agy.args, agy.env);
  const child = spawn(launch.command, launch.args, { cwd: dir, env: agy.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: true });
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("agy exited before it answered")));
  });
  // Its exit after the answer, when it is ended below, is nobody's failure.
  exited.catch(() => undefined);
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  try {
    return await Promise.race([(async () => ask(rpc, await initializeAgy(rpc, timeoutMs)))(), exited]);
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}
