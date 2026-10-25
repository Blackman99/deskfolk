/**
 * The `/` list of a Codex project session (ADR 0099, 2026-10-25 addendum). Codex's app-server runs
 * no slash command — a line starting with one is only words to it — so the list is what the app
 * can carry out through it: three of Codex's own commands, each a request of its own
 * (`thread/compact/start`, `review/start`, `thread/start`), and every skill Codex would load in the
 * session's directory, as its `skills/list` names them: yours, your plugins', the project's and
 * Codex's own. Nothing goes to a model; a directory's list is kept a while, as Claude Code's are
 * (`claude-code/commands.ts`).
 */
import { spawn } from "node:child_process";
import type { ClaudeCodeCommand, ClaudeCodeCommandList } from "@real-bot/protocol";
import daemonPackage from "../../package.json";
import { claudeLaunch } from "../claude-code/spawn";
import { rpcPeer, type RpcPeer } from "../engine/agent/jsonrpc";
import type { ResolvedAgent } from "./runtime";

/** How long a directory's list is kept before the next ask starts Codex again. */
export const CODEX_COMMANDS_MAX_AGE_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 15_000;

/** Codex's own commands the app carries out, in the words Codex's terminal lists them with. */
export const CODEX_BUILTIN_COMMANDS: ClaudeCodeCommand[] = [
  { name: "compact", description: "summarize conversation to prevent hitting the context limit", argument_hint: "", aliases: [] },
  { name: "review", description: "review my current changes and find issues", argument_hint: "[instructions]", aliases: [] },
  { name: "new", description: "start a new chat during a conversation", argument_hint: "", aliases: ["clear"] },
];

export type CodexBuiltin = "compact" | "review" | "new";

/** The built-in a command's name runs, by its own name or another it goes by; null for any other. */
export function codexBuiltinOf(name: string): CodexBuiltin | null {
  const found = CODEX_BUILTIN_COMMANDS.find((command) => command.name === name || command.aliases.includes(name));
  return found ? (found.name as CodexBuiltin) : null;
}

/** A skill as Codex loads it: its name (`pdf:pdf` for a plugin's), what it is for, and its SKILL.md. */
export type CodexSkill = { name: string; description: string; path: string };

/** The part of `skills/list`'s answer read here. */
export type SkillsAnswer = {
  data?: Array<{ skills?: Array<{ name?: unknown; description?: unknown; shortDescription?: unknown; interface?: { shortDescription?: unknown } | null; path?: unknown; enabled?: unknown }> }>;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The skills that are on, each name once (the first wins); one named as a built-in is left out, as the built-in runs. */
export function readSkills(answer: SkillsAnswer | null | undefined): CodexSkill[] {
  const skills = new Map<string, CodexSkill>();
  for (const entry of Array.isArray(answer?.data) ? answer.data : []) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const name = text(skill?.name);
      const path = text(skill?.path);
      if (!name || !path || skill.enabled === false || /\s|\//.test(name) || codexBuiltinOf(name) || skills.has(name)) continue;
      // The short line Codex's own pickers show, before the whole description.
      const description = text(skill.interface?.shortDescription) || text(skill.shortDescription) || text(skill.description);
      skills.set(name, { name, description, path });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills of `dir`, asked of an app-server already initialized. */
export async function askSkills(rpc: RpcPeer, dir: string, timeoutMs = ASK_TIMEOUT_MS): Promise<CodexSkill[]> {
  return readSkills(await rpc.request<SkillsAnswer>("skills/list", { cwds: [dir] }, timeoutMs));
}

/** Starts Codex's app-server in `dir`, asks it for the skills there, and closes it. */
export type AskCodexSkills = (codex: Extract<ResolvedAgent, { ok: true }>, dir: string) => Promise<CodexSkill[]>;

export type CodexCommandList = {
  /** The commands of a directory, kept while younger than `CODEX_COMMANDS_MAX_AGE_MS`. */
  list(dir: string): Promise<ClaudeCodeCommandList>;
};

export function createCodexCommandList(deps: { resolve: () => Promise<ResolvedAgent>; ask?: AskCodexSkills; now?: () => number }): CodexCommandList {
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? askAppServer;
  const kept = new Map<string, { list: ClaudeCodeCommandList; at: number }>();
  const inFlight = new Map<string, Promise<ClaudeCodeCommandList>>();
  const withSkills = (skills: CodexSkill[]): ClaudeCodeCommand[] => [
    ...CODEX_BUILTIN_COMMANDS,
    ...skills.map((skill) => ({ name: skill.name, description: skill.description, argument_hint: "", aliases: [] })),
  ];

  async function fresh(dir: string): Promise<ClaudeCodeCommandList> {
    const checkedAt = () => new Date(now()).toISOString();
    try {
      const codex = await deps.resolve();
      // Codex's own commands are the app's to carry out: they are listed whatever the skills do.
      if (!codex.ok) return { commands: withSkills([]), checked_at: checkedAt(), error: "codex_not_found" };
      const list = { commands: withSkills(await ask(codex, dir)), checked_at: checkedAt(), error: null };
      kept.set(dir, { list, at: now() });
      return list;
    } catch (error) {
      // A list asked for before still serves, with what went wrong this time.
      const message = error instanceof Error ? error.message : String(error);
      const old = kept.get(dir);
      return old ? { ...old.list, error: message } : { commands: withSkills([]), checked_at: checkedAt(), error: message };
    }
  }

  return {
    list(dir) {
      const old = kept.get(dir);
      if (old && now() - old.at < CODEX_COMMANDS_MAX_AGE_MS) return Promise.resolve(old.list);
      const pending = inFlight.get(dir);
      if (pending) return pending;
      const asking = fresh(dir).finally(() => inFlight.delete(dir));
      inFlight.set(dir, asking);
      return asking;
    },
  };
}

/** The real ask: an app-server of its own in the directory, as a run starts one, closed once it answered. */
async function askAppServer(codex: Extract<ResolvedAgent, { ok: true }>, dir: string): Promise<CodexSkill[]> {
  const launch = claudeLaunch(codex.executable, codex.args, codex.env);
  const child = spawn(launch.command, launch.args, { cwd: dir, env: codex.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: false });
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Codex exited before it listed its skills")));
  });
  // Its exit after the answer, when it is closed below, is nobody's failure.
  exited.catch(() => undefined);
  const timer = setTimeout(() => child.kill("SIGTERM"), ASK_TIMEOUT_MS);
  try {
    const asking = (async () => {
      await rpc.request("initialize", { clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" }, capabilities: { experimentalApi: false, requestAttestation: false } }, ASK_TIMEOUT_MS);
      rpc.notify("initialized");
      return askSkills(rpc, dir);
    })();
    return await Promise.race([asking, exited]);
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}
