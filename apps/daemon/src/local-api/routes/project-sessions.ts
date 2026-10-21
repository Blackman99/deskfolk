import { isAgentModelName, isClaudeEffort, type CreateProjectSessionRequest } from "@real-bot/protocol";
import { homedir } from "node:os";
import { readAgentReplay } from "../../claude-code/replay";
import { claudeSessionRoots, findClaudeSessionFile, readClaudeSession } from "../../claude-code/sessions";
import { HttpError } from "../../errors";
import { jsonResponse, matchPath } from "../../http";
import { sessionUpsertFields } from "../../session-events";
import { locateProjectPath } from "../../project-paths";
import { occurred } from "../helpers";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: project sessions (ADR 0095) and their agent's runs. */
export function projectSessionRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { input, store, publish, projects, method, path, url } = ctx;
  let params: ReturnType<typeof matchPath>;

  // A new session in a directory, or one carrying a terminal session on: only an account directory
  // the listing reads is looked in, and the session must be there.
  if (method === "POST" && path === "/v1/project-sessions") {
    const body = (input.body ?? {}) as CreateProjectSessionRequest;
    const agent = body.agent ?? "claude_code";
    if (agent !== "claude_code") throw new HttpError(422, "invalid_args", "only claude_code runs a project session for now");
    const roots = claudeSessionRoots(store.claudeCodeConfigDirs());
    const locale = store.settingsCached().locale;
    let created;
    if (body.import) {
      if (typeof body.import.session_id !== "string") throw new HttpError(422, "invalid_args", "import.session_id is required");
      const root = roots.find((entry) => entry.configDir === (body.import!.config_dir ?? null));
      if (!root) throw new HttpError(422, "invalid_args", "config_dir is not one of your Claude accounts");
      const file = findClaudeSessionFile(root, body.import.session_id);
      if (!file) throw new HttpError(404, "not_found", "no such Claude Code session");
      const read = readClaudeSession(file, body.import.session_id);
      if (!read.cwd) throw new HttpError(422, "invalid_args", "the session does not say which directory it ran in");
      created = store.createProjectSession({ dir: read.cwd, agent, configDir: root.configDir, imported: read, locale });
    } else {
      const dir = typeof body.dir === "string" ? body.dir.trim() : "";
      if (!dir.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(dir)) throw new HttpError(422, "invalid_args", "dir must be an absolute path");
      const configDir = body.config_dir ?? null;
      if (configDir !== null && !roots.some((entry) => entry.configDir === configDir)) {
        throw new HttpError(422, "invalid_args", "config_dir is not one of your Claude accounts");
      }
      created = store.createProjectSession({ dir: dir.replace(/[\\/]+$/, "") || dir, agent, configDir, locale });
    }
    publish({ event: "session.upsert", occurred_at: occurred(), ...sessionUpsertFields(created) });
    return jsonResponse(created, 201, null);
  }

  // The session's newest run, live or over; null before its first.
  params = matchPath(path, "/v1/project-sessions/:id/run");
  if (params && method === "GET") {
    if (!store.projectOf(params.id!)) throw new HttpError(404, "not_found", "not a project session");
    return jsonResponse({ run: store.latestAgentRun(params.id!) }, 200, null);
  }

  // Its work read back from Claude Code's own session files, for the task map (ADR 0095). Nothing
  // is kept by the app: with the files gone there is nothing to replay.
  params = matchPath(path, "/v1/project-sessions/:id/replay");
  if (params && method === "GET") {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const configDirs = store.claudeCodeConfigDirs();
    const root = claudeSessionRoots(configDirs).find((entry) => entry.configDir === project.configDir) ?? claudeSessionRoots(configDirs)[0]!;
    const fileOf = (id: string | null) => (id ? findClaudeSessionFile(root, id) : null);
    return jsonResponse(readAgentReplay(
      { sessionId: params.id!, agentFile: fileOf(project.agentSession), sourceFile: fileOf(project.source), agentSession: project.agentSession, sourceSession: project.source },
      { projectDir: project.dir, home: homedir(), configDirs },
    ), 200, null);
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

  // The model (an alias or a full id) and the thinking level its runs ask for, each from the next
  // step on: a run going now switches too. A key left out stays; null is the agent's own default.
  params = matchPath(path, "/v1/project-sessions/:id");
  if (params && method === "PATCH") {
    const body = (input.body ?? {}) as { model?: unknown; effort?: unknown };
    const change: { model?: string | null; effort?: string | null } = {};
    if (body.model !== undefined) {
      const model = typeof body.model === "string" ? body.model.trim() : body.model;
      if (model !== null && (typeof model !== "string" || !isAgentModelName(model))) {
        throw new HttpError(422, "invalid_args", "model must be a model name or null");
      }
      change.model = model;
    }
    if (body.effort !== undefined) {
      if (body.effort !== null && !isClaudeEffort(body.effort)) throw new HttpError(422, "invalid_args", "effort must be low, medium, high, xhigh, max or null");
      change.effort = body.effort;
    }
    if (change.model === undefined && change.effort === undefined) throw new HttpError(422, "invalid_args", "model or effort is required");
    const session = store.tuneProjectSession(params.id!, change);
    projects.tune(params.id!, change);
    publish({ event: "session.upsert", occurred_at: occurred(), ...sessionUpsertFields(session) });
    return jsonResponse(session, 200, null);
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
