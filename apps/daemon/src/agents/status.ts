/**
 * What the daemon learns about your local agents other than Claude Code (ADR 0079), for Settings ›
 * Agents and before a turn: where each command is, its version, whether it is signed in, the
 * models it offers. Only ever by running the agent and asking it about itself — its `--version`,
 * `codex app-server`'s `account/read` and `model/list`, `grok models`, `opencode auth list` and
 * `opencode models`, `agy models`, an ACP `initialize` — never by reading what it keeps on disk.
 * Each answer is kept a minute; only one look per agent runs at a time.
 */
import { spawn } from "node:child_process";
import { AGENT_KINDS, type AgentAccount, type AgentModel, type AgentStatus, type AgentsStatusResponse, type BotRunner, type CustomAgent } from "@real-bot/protocol";
import { maskProxy } from "../claude-code/proxy";
import { claudeLaunch } from "../claude-code/spawn";
import { rpcPeer } from "../engine/agent/jsonrpc";
import daemonPackage from "../../package.json";
import { AGENT_LAUNCH } from "./registry";
import { forgetLocatedAgent, resolveAgent } from "./runtime";

export const AGENT_STATUS_MAX_AGE_MS = 60_000;
const ASK_TIMEOUT_MS = 15_000;

export type OtherRunner = Exclude<BotRunner, "claude_code">;
export const OTHER_RUNNERS: OtherRunner[] = (Object.keys(AGENT_KINDS) as BotRunner[]).filter((runner): runner is OtherRunner => runner !== "claude_code" && runner !== "custom");

export type AgentProbeDeps = {
  path: (runner: BotRunner) => string | null;
  configDirs: (runner: BotRunner) => string[];
  customAgents: () => CustomAgent[];
  env?: Record<string, string | undefined>;
  /** A test's stand-in for asking an agent about itself. */
  describe?: (runner: OtherRunner, custom: CustomAgent | null) => Promise<AgentStatus>;
};

export type AgentProbe = {
  list(maxAgeMs?: number): Promise<AgentsStatusResponse>;
  current(runner: OtherRunner, customId?: string | null, maxAgeMs?: number): Promise<AgentStatus>;
  detect(runner: OtherRunner, customId?: string | null): Promise<AgentStatus>;
  /** Models an agent offered in a session (an ACP agent's config options): kept for the next look. */
  noteModels(runner: OtherRunner, customId: string | null, models: AgentModel[], defaultModel: string | null): void;
};

/** Models seen in sessions, for agents that list them nowhere else (DSH, ZCode, your own). */
const seenModels = new Map<string, { models: AgentModel[]; defaultModel: string | null }>();

export function noteAgentModels(runner: OtherRunner, customId: string | null, models: AgentModel[], defaultModel: string | null): void {
  if (models.length > 0) seenModels.set(`${runner}\u0000${customId ?? ""}`, { models, defaultModel });
}

export function createAgentProbe(deps: AgentProbeDeps): AgentProbe {
  const cache = new Map<string, { status: AgentStatus; at: number }>();
  const inFlight = new Map<string, Promise<AgentStatus>>();
  const key = (runner: OtherRunner, customId: string | null) => `${runner}\u0000${customId ?? ""}`;

  function detect(runner: OtherRunner, customId: string | null = null): Promise<AgentStatus> {
    const k = key(runner, customId);
    const running = inFlight.get(k);
    if (running) return running;
    const custom = runner === "custom" ? deps.customAgents().find((agent) => agent.id === customId) ?? null : null;
    forgetLocatedAgent(runner);
    const look = (async () => {
      try {
        const status = await (deps.describe ?? ((r, c) => describeAgent(r, c, deps)))(runner, custom);
        cache.set(k, { status, at: Date.now() });
        return status;
      } finally {
        inFlight.delete(k);
      }
    })();
    inFlight.set(k, look);
    return look;
  }
  function current(runner: OtherRunner, customId: string | null = null, maxAgeMs = AGENT_STATUS_MAX_AGE_MS): Promise<AgentStatus> {
    const cached = cache.get(key(runner, customId));
    if (cached && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached.status);
    return detect(runner, customId);
  }
  return {
    current,
    detect,
    async list(maxAgeMs = AGENT_STATUS_MAX_AGE_MS) {
      const customs = deps.customAgents();
      const items = await Promise.all([
        ...OTHER_RUNNERS.map((runner) => current(runner, null, maxAgeMs)),
        ...customs.map((agent) => current("custom", agent.id, maxAgeMs)),
      ]);
      return { items, custom_agents: customs };
    },
    noteModels: noteAgentModels,
  };
}

/** Runs the agent and asks it about itself. */
export async function describeAgent(runner: OtherRunner, custom: CustomAgent | null, deps: AgentProbeDeps): Promise<AgentStatus> {
  const label = runner === "custom" && custom ? custom.name : AGENT_KINDS[runner].label;
  const base: AgentStatus = {
    runner, custom_id: custom?.id ?? null, label, path: null, source: null, version: null, logged_in: null, auth: null,
    login_command: AGENT_LAUNCH[runner].login, models: [], default_model: null, proxy: null, proxy_source: null,
    checked_at: new Date().toISOString(), error: null,
  };
  const resolved = await resolveAgent({ runner, custom, setting: deps.path(runner), configDir: null, env: deps.env });
  if (!resolved.ok) return { ...base, error: resolved.error };
  base.path = resolved.executable;
  base.source = resolved.source;
  if (resolved.proxy) {
    base.proxy = maskProxy(resolved.proxy.url);
    base.proxy_source = resolved.proxy.source;
  }
  const seen = seenModels.get(`${runner}\u0000${custom?.id ?? ""}`);
  if (seen) {
    base.models = seen.models;
    base.default_model = seen.defaultModel;
  }
  if (runner !== "custom" && runner !== "zcode") {
    const version = await run(resolved.executable, ["--version"], resolved.env);
    base.version = firstLine(version.out) ?? null;
  }
  try {
    switch (runner) {
      case "codex": {
        const asked = await askCodex(resolved.executable, resolved.env);
        Object.assign(base, asked);
        const dirs = deps.configDirs(runner);
        if (dirs.length > 0) {
          const accounts: AgentAccount[] = [{ config_dir: null, logged_in: asked.logged_in, auth: asked.auth, error: asked.error ?? null, login_command: AGENT_LAUNCH.codex.login }];
          for (const dir of dirs) {
            const env = { ...resolved.env, CODEX_HOME: dir };
            const one = await askCodex(resolved.executable, env).catch((error) => ({ logged_in: null, auth: null, error: String(error) }));
            accounts.push({ config_dir: dir, logged_in: one.logged_in ?? null, auth: one.auth ?? null, error: one.error ?? null, login_command: `CODEX_HOME=${shellQuote(dir)} codex login` });
          }
          base.accounts = accounts;
        }
        break;
      }
      case "grok": {
        const listed = await run(resolved.executable, ["models"], resolved.env);
        const text = listed.out;
        const signed = /logged in with (.+?)\.?\s*$/im.exec(text);
        base.logged_in = signed ? true : /not logged in|log ?in first|please (?:sign|log) in/i.test(text) ? false : null;
        base.auth = signed?.[1]?.trim() ?? null;
        base.default_model = /Default model:\s*(\S+)/i.exec(text)?.[1] ?? base.default_model;
        const models = [...text.matchAll(/^\s*[-*]\s+(\S+)/gm)].map((match) => match[1]!).filter((id, index, all) => all.indexOf(id) === index);
        if (models.length > 0) base.models = models.map((id) => ({ id, name: id, efforts: [...AGENT_KINDS.grok.efforts] }));
        if (!listed.ok && !signed) base.error = firstLine(listed.err || listed.out) ?? "grok models failed";
        break;
      }
      case "opencode": {
        const auth = await run(resolved.executable, ["auth", "list"], resolved.env);
        const providers = auth.out.split(/\r?\n/).map((line) => line.trim().split(/\s{2,}/)[0] ?? "").filter((name) => name && !/^[─-]+$/.test(name));
        base.logged_in = providers.length > 0 ? true : auth.ok ? false : null;
        base.auth = providers.length > 0 ? [...new Set(providers)].join(", ") : null;
        const listed = await run(resolved.executable, ["models"], resolved.env);
        const models = listed.out.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line));
        if (models.length > 0) base.models = models.map((id) => ({ id, name: id, efforts: [] }));
        break;
      }
      case "antigravity": {
        const listed = await run(resolved.executable, ["models"], resolved.env);
        const models = listed.out.split(/\r?\n/).flatMap((line) => {
          const match = /^(\S+)\t(.+)$/.exec(line.trim());
          return match ? [{ id: match[1]!, name: match[2]!.trim(), efforts: [] as string[] }] : [];
        });
        if (models.length > 0) {
          base.models = models;
          base.logged_in = true;
        } else {
          base.logged_in = /log ?in|sign ?in|auth/i.test(listed.err + listed.out) ? false : null;
          base.error = firstLine(listed.err || listed.out) ?? null;
        }
        break;
      }
      case "dsh":
      case "zcode":
      case "custom": {
        const info = await askAcp(resolved.executable, resolved.args, resolved.env);
        if (info.version && !base.version) base.version = info.version;
        if (info.error) base.error = info.error;
        break;
      }
    }
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
  }
  return base;
}

/** `codex app-server`: who is signed in and which models it offers; nothing is run on the model. */
async function askCodex(executable: string, env: Record<string, string>): Promise<Pick<AgentStatus, "logged_in" | "auth" | "models" | "default_model" | "error">> {
  const launch = claudeLaunch(executable, ["app-server"], env);
  const child = spawn(launch.command, launch.args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: false });
  const timer = setTimeout(() => child.kill("SIGTERM"), ASK_TIMEOUT_MS);
  try {
    await rpc.request("initialize", { clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" }, capabilities: { experimentalApi: false, requestAttestation: false } }, ASK_TIMEOUT_MS);
    rpc.notify("initialized");
    const read = await rpc.request<{ account?: { type?: string; planType?: string } | null; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken: false }, ASK_TIMEOUT_MS);
    const account = read?.account ?? null;
    const listed = await rpc.request<{ data?: Array<{ id?: string; displayName?: string; hidden?: boolean; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort?: string }> }> }>("model/list", {}, ASK_TIMEOUT_MS).catch(() => ({ data: [] }));
    const models = (listed.data ?? []).filter((model) => model.id && !model.hidden).map((model) => ({
      id: model.id!, name: model.displayName ?? model.id!,
      efforts: (model.supportedReasoningEfforts ?? []).flatMap((effort) => (effort.reasoningEffort && AGENT_KINDS.codex.efforts.includes(effort.reasoningEffort) ? [effort.reasoningEffort] : [])),
    }));
    return {
      logged_in: account !== null ? true : read?.requiresOpenaiAuth === false ? true : false,
      auth: account?.type === "chatgpt" ? `ChatGPT${account.planType ? ` ${account.planType}` : ""}` : account?.type === "apiKey" ? "API key" : account?.type ?? null,
      models,
      default_model: (listed.data ?? []).find((model) => model.isDefault)?.id ?? null,
      error: null,
    };
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}

/** An ACP agent's `initialize`: its name and version; no session is opened. */
async function askAcp(executable: string, args: string[], env: Record<string, string>): Promise<{ version: string | null; error: string | null }> {
  const launch = claudeLaunch(executable, args, env);
  const child = spawn(launch.command, launch.args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: true });
  const timer = setTimeout(() => child.kill("SIGTERM"), ASK_TIMEOUT_MS);
  try {
    const init = await rpc.request<{ agentInfo?: { version?: string } }>("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "deskfolk", version: "status" } }, ASK_TIMEOUT_MS);
    return { version: init?.agentInfo?.version ?? null, error: null };
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}

async function run(executable: string, args: string[], env: Record<string, string>): Promise<{ ok: boolean; out: string; err: string }> {
  const launch = claudeLaunch(executable, args, env);
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
    } catch (error) {
      resolve({ ok: false, out: "", err: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), ASK_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: err || String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: stripAnsi(out), err: stripAnsi(err) });
    });
  });
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).find((part) => part.trim())?.trim();
  return line ? line.slice(0, 200) : null;
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+~-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}
