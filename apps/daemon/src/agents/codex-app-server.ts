/**
 * A short-lived Codex app-server for a question that is not a run (ADR 0099): listing or reading
 * your threads, rebuilding one under another account. Started where a run would start it, asked,
 * and closed; nothing goes to a model.
 */
import { spawn } from "node:child_process";
import daemonPackage from "../../package.json";
import { claudeLaunch } from "../claude-code/spawn";
import { rpcPeer, type RpcPeer } from "../engine/agent/jsonrpc";
import type { ResolvedAgent } from "./runtime";

export const CODEX_ASK_TIMEOUT_MS = 20_000;

/** Starts Codex's app-server in `dir`, initializes it, runs `ask` on it, and closes it, however `ask` ends. */
export async function withCodexAppServer<T>(codex: Extract<ResolvedAgent, { ok: true }>, dir: string, ask: (rpc: RpcPeer) => Promise<T>, timeoutMs = CODEX_ASK_TIMEOUT_MS): Promise<T> {
  const launch = claudeLaunch(codex.executable, codex.args, codex.env);
  const child = spawn(launch.command, launch.args, { cwd: dir, env: codex.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: false });
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Codex exited before it answered")));
  });
  // Its exit after the answer, when it is closed below, is nobody's failure.
  exited.catch(() => undefined);
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  try {
    const asking = (async () => {
      await rpc.request("initialize", {
        clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, timeoutMs);
      rpc.notify("initialized");
      return ask(rpc);
    })();
    return await Promise.race([asking, exited]);
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}
