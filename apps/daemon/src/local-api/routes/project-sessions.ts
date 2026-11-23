import { AGENT_KINDS, CONSULT_MEMBERS_MAX, isAgentEffort, isAgentModelName, isProjectAgent, isProjectAgentMode, parseConsultSetting, PROJECT_AGENT_CAPS, PROJECT_AGENTS, type ProjectConsultSetting, type AgentReplay, type AgentTaskDetail, type CreateProjectSessionRequest, type ProjectAgent, type ProjectAgentMode } from "@real-bot/protocol";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSessions, ImportedSession } from "../../agents/agent-sessions";
import { withCodexAppServer } from "../../agents/codex-app-server";
import { readThread } from "../../agents/codex-sessions";
import { codexSubagentTrail } from "../../agents/codex-task-detail";
import { projectCodexOf } from "../../project-runner-codex";
import { readAgyReplay } from "../../agents/agy-replay";
import { readCodexReplay } from "../../agents/codex-replay";
import { readAgentReplay } from "../../claude-code/replay";
import { projectAgyOf } from "../../project-runner-agy";
import { consultDetail } from "../../project-consult";
import { grokCommandList, grokUpdates, projectGrokOf, withGrokAcp } from "../../agents/grok-acp";
import { readGrokReplay, grokSubagentTrail } from "../../agents/grok-replay";
import { readOutputTail, readSubagentTrail } from "../../claude-code/task-detail";
import { carryClaudeSession, claudeSessionRoots, findClaudeSessionFile } from "../../claude-code/sessions";
import { lastContextUsage } from "../../claude-code/model-usage";
import { HttpError } from "../../errors";
import { jsonResponse, matchPath } from "../../http";
import { sessionUpsertFields } from "../../session-events";
import { locateProjectPath } from "../../project-paths";
import { occurred } from "../helpers";
import type { RouteCtx } from "../route-ctx";

/** As much of a finished task's output as its row in the list keeps, the size a Bot's kept command has. */
const KEPT_OUTPUT = 4000;

/**
 * The terminal session a `POST /v1/project-sessions` carries on, read through its agent
 * (`agents/agent-sessions.ts`) — which may ask the agent itself, so before the write; undefined
 * for a new session. What is wrong with the request is said the same way the route says it.
 */
export async function readImportOf(sessions: AgentSessions, body: Record<string, unknown>): Promise<ImportedSession | undefined> {
  const request = body as CreateProjectSessionRequest;
  if (!request.import) return undefined;
  const agent = request.agent ?? "claude_code";
  if (!isProjectAgent(agent)) throw new HttpError(422, "invalid_args", `agent must be one of ${PROJECT_AGENTS.join(", ")}`);
  if (!PROJECT_AGENT_CAPS[agent].importable) throw new HttpError(422, "invalid_args", `a ${agent} session cannot be carried on from a terminal`);
  if (typeof request.import !== "object" || typeof request.import.session_id !== "string") throw new HttpError(422, "invalid_args", "import.session_id is required");
  return sessions.read(agent, request.import.session_id, request.import.config_dir ?? null);
}

/** Every agent is handled by name: one a switch here does not know is a gap in this file, never another agent's. */
function unknownAgent(agent: never): never {
  throw new HttpError(500, "internal", `no route handles project sessions of ${String(agent)}`);
}

/** Local API routes: project sessions (ADR 0095) and their agent's runs. */
export function projectSessionRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { input, store, publish, projects, method, path, url, options } = ctx;
  let params: ReturnType<typeof matchPath>;
  /** Your accounts of an agent besides the daemon's own: Claude's account directories, Codex's homes (ADR 0099). */
  const accountsOf = (agent: ProjectAgent): string[] => (agent === "claude_code"
    ? claudeSessionRoots(store.claudeCodeConfigDirs()).flatMap((root) => (root.configDir ? [root.configDir] : []))
    : store.agentConfigDirs(agent));

  // A new session in a directory, or one carrying a terminal session on, read through the agent's
  // own door (`agents/agent-sessions.ts`): only an account the listing reads is looked in, and the
  // session must be there. A new session's account must be one of yours for that agent.
  if (method === "POST" && path === "/v1/project-sessions") {
    const body = (input.body ?? {}) as CreateProjectSessionRequest;
    const agent = body.agent ?? "claude_code";
    if (!isProjectAgent(agent)) throw new HttpError(422, "invalid_args", `agent must be one of ${PROJECT_AGENTS.join(", ")}`);
    const caps = PROJECT_AGENT_CAPS[agent];
    if (body.import && !caps.importable) throw new HttpError(422, "invalid_args", `a ${agent} session cannot be carried on from a terminal`);
    if (body.config_dir != null && !caps.accounts) throw new HttpError(422, "invalid_args", `a ${agent} session picks no account`);
    const locale = store.settingsCached().locale;
    const done = (created: ReturnType<typeof store.createProjectSession>) => {
      publish({ event: "session.upsert", occurred_at: occurred(), ...sessionUpsertFields(created) });
      return jsonResponse(created, 201, null);
    };
    if (body.import) {
      const configDir = body.import.config_dir ?? null;
      const make = (read: ImportedSession) => {
        if (!read.cwd) throw new HttpError(422, "invalid_args", "the session does not say which directory it ran in");
        return done(store.createProjectSession({ dir: read.cwd, agent, configDir, imported: read, continues: !caps.branches, locale }));
      };
      // Read before the write when the request came through receipts; asked here otherwise.
      if (input.imported) return make(input.imported);
      return readImportOf(options.agentSessions!, body as Record<string, unknown>).then((read) => make(read!));
    }
    const dir = typeof body.dir === "string" ? body.dir.trim() : "";
    if (!dir.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(dir)) throw new HttpError(422, "invalid_args", "dir must be an absolute path");
    const configDir = body.config_dir ?? null;
    if (configDir !== null && !accountsOf(agent).includes(configDir)) {
      throw new HttpError(422, "invalid_args", `config_dir is not one of your ${agent === "claude_code" ? "Claude" : agent} accounts`);
    }
    return done(store.createProjectSession({ dir: dir.replace(/[\\/]+$/, "") || dir, agent, configDir, locale }));
  }

  // Everything its runs have sent to the background and every subagent, newest run first (ADR 0095, 25).
  params = matchPath(path, "/v1/project-sessions/:id/tasks");
  if (params && method === "GET") {
    if (!store.projectOf(params.id!)) throw new HttpError(404, "not_found", "not a project session");
    // A finished command's card opens onto the end of its output, as a Bot's kept commands do.
    const tasks = store.agentTasksOfSession(params.id!).map((task) => (task.kind === "subagent" || task.status === "running"
      ? task : { ...task, output: readOutputTail(task.output_file, KEPT_OUTPUT)?.output ?? null }));
    return jsonResponse({ tasks }, 200, null);
  }

  // The session's newest run, live or over; null before its first.
  params = matchPath(path, "/v1/project-sessions/:id/run");
  if (params && method === "GET") {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    // Backfill context usage once from Claude Code's session file for existing/imported sessions.
    if (project.agent === "claude_code" && !project.context && (project.agentSession || project.source)) {
      const roots = claudeSessionRoots(store.claudeCodeConfigDirs());
      const root = roots.find((entry) => entry.configDir === project.configDir) ?? roots[0]!;
      const file = findClaudeSessionFile(root, (project.agentSession ?? project.source)!);
      const usage = file ? lastContextUsage(file) : null;
      if (usage) store.recordProjectContext(params.id!, usage);
    }
    return jsonResponse({ run: store.latestAgentRun(params.id!) }, 200, null);
  }

  // Its work read back from Claude Code's own session files, for the task map (ADR 0095). Nothing
  // is kept by the app: with the files gone there is nothing to replay.
  params = matchPath(path, "/v1/project-sessions/:id/replay");
  if (params && method === "GET") {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const empty: AgentReplay = { session_id: params.id!, agent_session: project.agentSession, source_session: null, calls: [], subagents: [], said: [] };
    // An agent with no replay (a cap off) has nothing read back: the map draws its runs live.
    if (!PROJECT_AGENT_CAPS[project.agent].replay) return jsonResponse(empty, 200, null);
    // Codex and Antigravity are asked, never read from their files (ADR 0111 addendum): a failure to ask answers empty.
    if (project.agent === "codex") {
      const resolve = options.projectCodex ?? projectCodexOf(store);
      return readCodexReplay(resolve, { configDir: project.configDir }, { sessionId: params.id!, agentSession: project.agentSession, projectDir: project.dir, configDirs: store.agentConfigDirs("codex") })
        .catch(() => empty).then((replay) => jsonResponse(replay, 200, null));
    }
    if (project.agent === "antigravity") {
      const resolve = options.projectAgy ?? projectAgyOf(store);
      const lines = store.db.query<{ kind: string; body: string; created_at: string }, [string]>(`SELECT kind, body, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`).all(params.id!);
      return readAgyReplay(resolve, lines, { sessionId: params.id!, agentSession: project.agentSession, projectDir: project.dir })
        .catch(() => empty).then((replay) => jsonResponse(replay, 200, null));
    }
    // Grok is asked too (ADR 0115): its records carry the times it wrote them.
    if (project.agent === "grok") {
      return readGrokReplay(options.projectGrok ?? projectGrokOf(store), project.configDir, { sessionId: params.id!, agentSession: project.agentSession, projectDir: project.dir, configDirs: store.allAgentConfigDirs() })
        .catch(() => empty).then((replay) => jsonResponse(replay, 200, null));
    }
    const configDirs = store.claudeCodeConfigDirs();
    const root = claudeSessionRoots(configDirs).find((entry) => entry.configDir === project.configDir) ?? claudeSessionRoots(configDirs)[0]!;
    const fileOf = (id: string | null) => (id ? findClaudeSessionFile(root, id) : null);
    return jsonResponse(readAgentReplay(
      { sessionId: params.id!, agentFile: fileOf(project.agentSession), sourceFile: fileOf(project.source), agentSession: project.agentSession, sourceSession: project.source },
      { projectDir: project.dir, home: homedir(), configDirs },
    ), 200, null);
  }

  // What typing `/` offers (ADR 0098): the account's and the directory's commands and skills, asked
  // of Claude Code without a prompt and kept a while; in a Codex session, the commands the app
  // carries out for Codex and the directory's skills, asked of its app-server (ADR 0099).
  params = matchPath(path, "/v1/project-sessions/:id/commands");
  if (params && method === "GET" && (options.claudeCommands || options.codexCommands)) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const none = () => jsonResponse({ commands: [], checked_at: new Date().toISOString(), error: null }, 200, null);
    if (!PROJECT_AGENT_CAPS[project.agent].commands) return none();
    switch (project.agent) {
      case "codex":
        return options.codexCommands ? options.codexCommands.list(project.dir).then((list) => jsonResponse(list, 200, null)) : none();
      case "claude_code":
        return options.claudeCommands ? options.claudeCommands.list(project.configDir, project.dir).then((list) => jsonResponse(list, 200, null)) : none();
      case "antigravity":
        // What `agy` offered the last run in this directory: none before its first.
        return jsonResponse({ commands: options.agyCommands?.get(project.dir) ?? [], checked_at: new Date().toISOString(), error: null }, 200, null);
      case "grok":
        // What a run in this directory last heard, else asked of a Grok that opens no session (ADR 0115).
        return options.grokCommands
          ? grokCommandList(options.projectGrok ?? projectGrokOf(store), options.grokCommands, project.dir, project.configDir).then((list) => jsonResponse(list, 200, null))
          : none();
      default:
        return unknownAgent(project.agent);
    }
  }

  // Where a path the agent cites is: its words are relative to wherever it was working, so a path
  // is looked for under the project as well as at it. Opening it is the file routes' work, with
  // the absolute path this gives.
  params = matchPath(path, "/v1/project-sessions/:id/locate");
  if (params && method === "GET") {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const cited = url.searchParams.get("path") ?? "";
    if (!cited.trim()) throw new HttpError(422, "invalid_args", "path is required");
    return jsonResponse(locateProjectPath(project.dir, cited), 200, null);
  }

  // The model (an alias or a full id) and the thinking level its runs ask for, and plan mode on or
  // off (ADR 0098), each from the next step on: a run going now switches too. The account its next run spends: Claude Code keeps a
  // session under the account's own directory, so the session is carried there first, and not
  // while a run is still writing it. A key left out stays; null is the agent's own default.
  params = matchPath(path, "/v1/project-sessions/:id");
  if (params && method === "PATCH") {
    const body = (input.body ?? {}) as { model?: unknown; effort?: unknown; mode?: unknown; config_dir?: unknown; consult?: unknown };
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const caps = PROJECT_AGENT_CAPS[project.agent];
    const change: { model?: string | null; effort?: string | null; mode?: ProjectAgentMode | null; configDir?: string | null; consult?: ProjectConsultSetting | null } = {};
    if (body.model !== undefined) {
      const model = typeof body.model === "string" ? body.model.trim() : body.model;
      if (model !== null && (typeof model !== "string" || !isAgentModelName(model))) {
        throw new HttpError(422, "invalid_args", "model must be a model name or null");
      }
      change.model = model;
    }
    if (body.effort !== undefined) {
      if (body.effort !== null && !isAgentEffort(project.agent, body.effort)) {
        throw new HttpError(422, "invalid_args", `effort must be ${AGENT_KINDS[project.agent].efforts.join(", ")} or null`);
      }
      change.effort = body.effort;
    }
    if (body.mode !== undefined) {
      if (!caps.plan) throw new HttpError(422, "invalid_args", `a ${project.agent} session has no plan mode`);
      if (body.mode !== null && !isProjectAgentMode(body.mode)) throw new HttpError(422, "invalid_args", "mode must be plan or null");
      change.mode = body.mode;
    }
    if (body.config_dir !== undefined) {
      if (!caps.accounts) throw new HttpError(422, "invalid_args", `a ${project.agent} session picks no account`);
      const configDir = body.config_dir;
      if (configDir !== null && (typeof configDir !== "string" || !accountsOf(project.agent).includes(configDir))) {
        throw new HttpError(422, "invalid_args", `config_dir is not one of your ${project.agent === "claude_code" ? "Claude" : project.agent} accounts`);
      }
      if (configDir !== project.configDir) {
        const latest = store.latestAgentRun(params.id!);
        if (latest && (latest.status === "running" || latest.status === "waiting_approval")) {
          throw new HttpError(409, "conflict", "the account changes once the run going now has ended");
        }
        // Claude Code finds a session only under its account's own directory: it is copied there now.
        // Codex's thread is carried over by the next run (`project-runner-codex.ts`), asked of Codex.
        if (project.agent === "claude_code") {
          const roots = claudeSessionRoots(store.claudeCodeConfigDirs());
          const to = roots.find((root) => root.configDir === configDir) ?? roots[0]!;
          const from = roots.find((root) => root.configDir === project.configDir) ?? roots[0]!;
          for (const id of [project.agentSession, project.source]) if (id) carryClaudeSession(from, to, id);
        }
      }
      change.configDir = configDir;
    }
    // The composer's consultant switch (ADR 0116 addendum 2026-11-23): a consultant has none of its own.
    if (body.consult !== undefined) {
      if (project.parentId) throw new HttpError(422, "invalid_args", "a consultant asks no consultant of its own");
      const consult = body.consult === null ? null : parseConsultSetting(body.consult);
      if (body.consult !== null && !consult) {
        throw new HttpError(422, "invalid_args", `consult must be { on, members } with at most ${CONSULT_MEMBERS_MAX} members, each { agent, model, effort }, or null`);
      }
      change.consult = consult;
    }
    if (change.model === undefined && change.effort === undefined && change.mode === undefined && change.configDir === undefined && change.consult === undefined) {
      throw new HttpError(422, "invalid_args", "model, effort, mode, config_dir or consult is required");
    }
    const session = store.tuneProjectSession(params.id!, change);
    // The switch is read as each line goes in; nothing of a run going now changes with it.
    const { consult: _consult, ...runChange } = change;
    if (Object.keys(runChange).length > 0) projects.tune(params.id!, runChange);
    publish({ event: "session.upsert", occurred_at: occurred(), ...sessionUpsertFields(session) });
    return jsonResponse(session, 200, null);
  }

  // One task opened: read from Claude Code's own files, or asked of the run while it has no file to
  // read yet. The id is looked up on the run: nothing the client says names a path.
  params = matchPath(path, "/v1/agent-runs/:id/tasks/:task");
  if (params && method === "GET") {
    const run = store.getAgentRun(params.id!);
    const task = run.tasks?.find((row) => row.id === params!.task);
    if (!task) throw new HttpError(404, "not_found", "no such task");
    // A consultant's (ADR 0116): read from its own session, which the app keeps.
    const consulted = consultDetail(store, task);
    if (consulted) return jsonResponse(consulted, 200, null);
    if (task.kind === "subagent") {
      const project = store.projectOf(run.session_id);
      // A Codex subagent is a thread of its own, read through Codex's app-server (ADR 0099 addendum).
      if (project?.agent === "codex") {
        const resolve = options.projectCodex ?? projectCodexOf(store);
        return (async () => {
          const codex = await resolve(project.configDir).catch(() => null);
          const thread = codex?.ok ? await withCodexAppServer(codex, project.dir, (rpc) => readThread(rpc, task.id)).catch(() => null) : null;
          const trail = thread ? codexSubagentTrail(thread) : { prompt: null, model: null, steps: [] };
          const detail: AgentTaskDetail = { task, output: null, output_bytes: null, ...trail };
          return jsonResponse(detail, 200, null);
        })();
      }
      // A Grok subagent is a session of its own, read through Grok (ADR 0115).
      if (project?.agent === "grok") {
        const resolve = options.projectGrok ?? projectGrokOf(store);
        return (async () => {
          const grok = await resolve(project.configDir).catch(() => null);
          const records = grok?.ok ? await withGrokAcp(grok, project.dir, (rpc) => grokUpdates(rpc, task.id, project.dir)).catch(() => []) : [];
          const detail: AgentTaskDetail = { task, output: null, output_bytes: null, ...grokSubagentTrail(records) };
          return jsonResponse(detail, 200, null);
        })();
      }
      const roots = claudeSessionRoots(store.claudeCodeConfigDirs());
      const root = roots.find((entry) => entry.configDir === project?.configDir) ?? roots[0]!;
      const session = project?.agentSession ? findClaudeSessionFile(root, project.agentSession) : null;
      const own = session ? join(session.slice(0, -".jsonl".length), "subagents", `agent-${task.id}.jsonl`) : null;
      // Claude Code's output file for a subagent is a link to this same file; it still leads there after a `/clear`.
      const trail = readSubagentTrail(own && existsSync(own) ? own : task.output_file);
      const detail: AgentTaskDetail = { task, output: null, output_bytes: null, ...trail };
      return jsonResponse(detail, 200, null);
    }
    const shown = (read: { output: string; bytes: number } | null): Response => {
      const detail: AgentTaskDetail = { task, output: read?.output ?? null, output_bytes: read?.bytes ?? null, prompt: null, model: null, steps: [] };
      return jsonResponse(detail, 200, null);
    };
    const read = readOutputTail(task.output_file);
    if (read) return shown(read);
    return projects.taskOutput(run.id, task.id).then((asked) => shown(asked ? { output: asked.output, bytes: asked.total_bytes } : null));
  }

  params = matchPath(path, "/v1/agent-runs/:id/tasks/:task/stop");
  if (params && method === "POST") {
    return jsonResponse(projects.stopTask(params.id!, params.task!), 200, null);
  }

  params = matchPath(path, "/v1/agent-runs/:id/:action");
  if (params && method === "POST" && ["approve", "deny", "stop"].includes(params.action!)) {
    const id = params.id!;
    store.getAgentRun(id);
    const action = params.action!;
    const run = action === "stop" ? projects.stop(id) : projects.answer(id, action === "approve");
    return jsonResponse(run, 200, null);
  }
  return null;
}
