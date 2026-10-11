import { isPlaybookStepId } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { jsonResponse, matchPath } from "../../http";
import type { RouteCtx } from "../route-ctx";

/** `if_revision` as sent: absent means no check, null means "never changed". */
function revisionGuard(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new HttpError(422, "invalid_args", "if_revision must be a revision id or null");
}

/**
 * Local API routes for engines (ADR 0085): the list with the default, one engine and its history,
 * your changes as a diff from its built-in, a step or the whole engine reset, a custom engine made
 * from another, renamed or removed, and a conversation's engine. Changes are published as
 * `playbook.changed` (and `session.upsert` for a conversation's) by the store's journal.
 */
export function playbookRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { input, store, method, path } = ctx;
  const body = (input.body ?? {}) as Record<string, unknown>;
  let params: ReturnType<typeof matchPath>;

  if (path === "/v1/playbooks") {
    if (method === "GET") return jsonResponse(store.listPlaybooks(), 200, null);
    if (method === "POST") {
      if (typeof body.from !== "string") throw new HttpError(422, "invalid_args", "from is required: the engine to start from");
      return jsonResponse(store.createPlaybook({ from: body.from, name: body.name, actor: "user" }), 201, null);
    }
    return null;
  }

  params = matchPath(path, "/v1/playbooks/:id/revisions");
  if (params && method === "GET") return jsonResponse({ items: store.listPlaybookRevisions(params.id!) }, 200, null);

  params = matchPath(path, "/v1/playbooks/:id/reset");
  if (params && method === "POST") {
    const step = body.step ?? null;
    if (step !== null && !isPlaybookStepId(step)) throw new HttpError(422, "invalid_args", "step must be one of the engine's steps or null");
    return jsonResponse(store.resetPlaybook(params.id!, { step, ifRevision: revisionGuard(body.if_revision), actor: "user" }), 200, null);
  }

  params = matchPath(path, "/v1/playbooks/:id");
  if (params) {
    if (method === "GET") return jsonResponse(store.getPlaybook(params.id!), 200, null);
    if (method === "PUT") return jsonResponse(store.savePlaybook(params.id!, { diff: body.diff, ifRevision: revisionGuard(body.if_revision), actor: "user" }), 200, null);
    if (method === "PATCH") return jsonResponse(store.renamePlaybook(params.id!, { name: body.name, ifRevision: revisionGuard(body.if_revision), actor: "user" }), 200, null);
    if (method === "DELETE") {
      store.deletePlaybook(params.id!, { actor: "user" });
      return jsonResponse({ ok: true }, 200, null);
    }
  }

  params = matchPath(path, "/v1/sessions/:id/playbook");
  if (params && method === "PUT") {
    if (!("playbook_id" in body)) throw new HttpError(422, "invalid_args", "playbook_id is required (null follows the default)");
    store.setSessionPlaybook(params.id!, body.playbook_id);
    return jsonResponse(store.getSession(params.id!, { messageLimit: 1 }), 200, null);
  }
  return null;
}
