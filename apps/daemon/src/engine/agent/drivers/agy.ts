/**
 * Your Antigravity CLI (`agy acp`, ADR 0079 addendum of 2026-11-12): the Agent Client Protocol it
 * serves from 1.5.0, run as any ACP agent is (`acp.ts`): the app's tools reach it as the `deskfolk`
 * stdio MCP server, a Bot's model and effort are set over the protocol, Stop and insert-now cut its
 * step, and it sees pictures. It runs under `agy`'s own terminal sandbox (`--sandbox`, its
 * commands' reads kept out of `~/.ssh` and the like) and in its `default` mode, which asks before
 * edits and commands as your `agy` settings say; the app never changes those settings, and
 * `agy acp` takes none per launch (`--settings` is the terminal's only).
 *
 * Under `always-proceed` it asks about nothing and runs its own file and command tools rather than
 * the app's `fs`/`terminal` (measured 2026-11-12, 1.5.6): each call is reported once under way
 * (`in_progress`), so it is checked then (`checkUnaskedAtStart`), and one its permission mode would
 * have asked about stops the turn, as in its print mode before. What it does ask about is answered by
 * the app's rules, as for any ACP agent.
 *
 * An `agy` older than 1.5.4 is not started: before it, cancelling or closing a session mid-prompt
 * could hang (fixed in 1.5.1) and so could a call that asked for permission twice (1.5.4). Its turn
 * fails as `agent_outdated`, saying which version it found.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { claudeLaunch } from "../../../claude-code/spawn";
import { agyServesAcp, agyTooOld } from "../../../agents/agy-version";
import type { AgentDriver } from "../driver";
import { acpDriver, AgentStartError } from "./acp";

const VERSION_TIMEOUT_MS = 15_000;

export type AgyDeps = {
  /** A test's stand-in for `agy --version`. */
  version?: (executable: string, env: Record<string, string>) => Promise<string>;
};

/** `agy --version` per executable, kept while the file is the same one (an update replaces it). */
const versions = new Map<string, { stamp: string; text: string }>();

export function agyDriver(deps: AgyDeps = {}): AgentDriver {
  const inner = acpDriver({
    args: (_host, base) => [...base, "--sandbox"],
    // `agy models` lists them in the form a Bot keeps (`gemini-3.8-flash-high`).
    ownModelList: true,
    mode: "default",
    checkUnaskedAtStart: true,
    failureIn: agyFailure,
  });
  return {
    ...inner,
    async start(host, first) {
      const text = await (deps.version ?? versionOf)(host.executable, host.env);
      if (!agyServesAcp(text)) throw new AgentStartError("agent_outdated", agyTooOld(text, host.locale));
      return inner.start(host, first);
    },
  };
}

async function versionOf(executable: string, env: Record<string, string>): Promise<string> {
  let stamp = "";
  try {
    const stat = statSync(executable);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // asked anyway
  }
  const kept = versions.get(executable);
  if (kept && stamp && kept.stamp === stamp) return kept.text;
  const text = await new Promise<string>((resolve) => {
    const launch = claudeLaunch(executable, ["--version"], env);
    const child = spawn(launch.command, launch.args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), VERSION_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  if (stamp && text.trim()) versions.set(executable, { stamp, text });
  return text;
}

/**
 * `agy acp`'s own failure, said as a prompt's whole reply: "⚠ …" lines and nothing else ("⚠ Agent
 * execution terminated due to error.", a suspended account's notice, or one "⚠ API error (attempt
 * N): UNAVAILABLE (code 503) …" line per retry and "⚠ Our servers are experiencing high traffic…"
 * last, measured 2026-11-12). The last line says it best. Words of the model that only begin with
 * the sign are a reply.
 */
export function agyFailure(reply: string): string | null {
  const lines = reply.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !lines.every((line) => line.startsWith("⚠") && line.length <= 500)) return null;
  return lines.at(-1)!.replace(/^⚠\s*/, "") || null;
}
