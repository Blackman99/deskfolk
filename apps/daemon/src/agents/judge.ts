/**
 * A built-in call (reading a line, the organizer, a judgement, …) on one of your local agents other
 * than Claude Code (ADR 0077, ADR 0079): the agent run once in a scratch directory, with no tools,
 * on the model and account chosen for the call, asked as an endpoint's model would be. The same
 * drivers as a turn's, with every call it would make of its own refused: a one-shot answer needs
 * none, and one that tries is cut off rather than let anywhere. What it reports it spent is billed
 * to the call, as an estimate; most agents report none.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInputPart } from "../context";
import type { ClaudeJudge, ClaudeReadingAnswer, ClaudeReadingUsage, OtherAgentTarget } from "../claude-code/reading";
import { claudeLaunch, killsTree } from "../claude-code/spawn";
import type { AgentDriver, AgentEvent, AgentHost, AgentSession } from "../engine/agent/driver";
import { driverFor } from "../engine/agent/drivers/profiles";
import type { Store } from "../store";
import { resolveAgent } from "./runtime";

/** At most this many calls at once on each agent; the next waits. */
export const AGENT_CALL_SLOTS = 2;

export function createAgentJudge(deps: {
  store: Pick<Store, "agentPath" | "customAgent">;
  /** A test's stand-in drivers and resolver. */
  drivers?: Partial<Record<OtherAgentTarget["runner"], AgentDriver>>;
  resolve?: typeof resolveAgent;
}): ClaudeJudge {
  const running = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();
  async function slot(runner: string, signal: AbortSignal): Promise<boolean> {
    while ((running.get(runner) ?? 0) >= AGENT_CALL_SLOTS) {
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        const list = waiting.get(runner) ?? [];
        list.push(resolve);
        waiting.set(runner, list);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (signal.aborted) return false;
    running.set(runner, (running.get(runner) ?? 0) + 1);
    return true;
  }
  function release(runner: string): void {
    running.set(runner, Math.max(0, (running.get(runner) ?? 0) - 1));
    waiting.get(runner)?.shift()?.();
  }

  return async ({ target, system, prompt, signal }) => {
    const unavailable: ClaudeReadingAnswer = { content: null, usage: null, fail: "claude_unavailable" };
    const failed: ClaudeReadingAnswer = { content: null, usage: null, fail: "claude_failed" };
    if (target.kind !== "agent") return unavailable;
    const custom = target.runner === "custom" ? deps.store.customAgent(target.customId) : null;
    const resolved = await (deps.resolve ?? resolveAgent)({ runner: target.runner, custom, setting: deps.store.agentPath(target.runner), configDir: target.configDir });
    if (!resolved.ok) return unavailable;
    if (!(await slot(target.runner, signal))) return failed;
    const dir = mkdtempSync(join(tmpdir(), "deskfolk-call-"));
    const children: ChildProcess[] = [];
    let session: AgentSession | null = null;
    const usage: ClaudeReadingUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
    const cumulative = new Map<string, ClaudeReadingUsage>();
    try {
      const answer = await new Promise<ClaudeReadingAnswer>((resolve) => {
        let settled = false;
        const settle = (value: ClaudeReadingAnswer) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        signal.addEventListener("abort", () => settle(failed), { once: true });
        const first: AgentInputPart[] = typeof prompt === "string"
          ? [{ type: "text", text: prompt }]
          : prompt.map((block) => (block.type === "text" ? { type: "text" as const, text: block.text } : { type: "image" as const, mediaType: block.source.media_type, data: block.source.data }));
        const host: AgentHost = {
          turnId: `call-${crypto.randomUUID()}`,
          runner: target.runner,
          custom,
          executable: resolved.executable,
          launchArgs: resolved.args,
          env: resolved.env,
          workspace: dir,
          cwd: dir,
          mode: "readonly",
          locale: "en",
          model: target.model,
          effort: target.effort ?? null,
          instructions: system,
          tools: [],
          callTool: async () => ({ text: JSON.stringify({ ok: false, error: { code: "no_tools", message: "this call has no tools" } }), isError: true }),
          mountMcp: () => {
            throw new Error("a built-in call has no tools");
          },
          gate: async () => ({ kind: "deny", reason: "this call has no tools: answer from what you were given" }),
          readFile: async () => {
            throw new Error("no files here");
          },
          writeFile: async () => {
            throw new Error("no files here");
          },
          runCommand: () => {
            throw new Error("no commands here");
          },
          spawn(command, args, options) {
            const launch = claudeLaunch(command, args, options.env);
            const child = spawn(launch.command, launch.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, windowsVerbatimArguments: launch.verbatim });
            killsTree(child);
            children.push(child);
            return child;
          },
          async emit(event: AgentEvent) {
            if (event.type === "usage") {
              if (event.cumulative) {
                const before = cumulative.get(event.model) ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
                usage.inputTokens += Math.max(0, event.input - before.inputTokens);
                usage.outputTokens += Math.max(0, event.output - before.outputTokens);
                usage.cachedTokens += Math.max(0, event.cached - before.cachedTokens);
                usage.costUsd += Math.max(0, (event.costUsd ?? 0) - before.costUsd);
                cumulative.set(event.model, { inputTokens: event.input, outputTokens: event.output, cachedTokens: event.cached, costUsd: event.costUsd ?? 0 });
              } else {
                usage.inputTokens += event.input;
                usage.outputTokens += event.output;
                usage.cachedTokens += event.cached;
                usage.costUsd += event.costUsd ?? 0;
              }
            } else if (event.type === "tool_started" && !event.gated) {
              // A one-shot answer needs no tools; one it starts unasked is not let run.
              settle(failed);
              session?.close();
            } else if (event.type === "result") {
              if (event.result.kind === "reply" && event.result.text.trim()) settle({ content: event.result.text, usage, fail: null });
              else settle({ content: null, usage, fail: event.result.kind === "error" && (event.result.failKind === "agent_missing" || event.result.failKind === "agent_signed_out") ? "claude_unavailable" : "claude_failed" });
            }
          },
          stderr: () => {},
          signal,
        };
        const driver = deps.drivers?.[target.runner] ?? driverFor(target.runner);
        driver.start(host, first).then((started) => {
          session = started;
          if (settled) started.close();
          void started.done.then(() => settle(failed));
        }, () => settle(unavailable));
      });
      return answer.fail === null ? answer : { ...answer, usage };
    } finally {
      try {
        (session as AgentSession | null)?.close();
      } catch {
        // already over
      }
      for (const child of children) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      release(target.runner);
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 2_000).unref?.();
    }
  };
}
