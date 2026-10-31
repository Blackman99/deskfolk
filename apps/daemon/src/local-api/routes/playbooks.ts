import { isPlaybookStepId, type Locale } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { jsonResponse, matchPath } from "../../http";
import { engineSystemDefault, promptProblemsError, promptSlot } from "../../prompts/book";
import { validatePromptText } from "../../prompts/validate";
import type { RouteCtx } from "../route-ctx";

/** `if_revision` as sent: absent means no check, null means "never changed". */
function revisionGuard(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new HttpError(422, "invalid_args", "if_revision must be a revision id or null");
}

/**
 * An engine's own System section (ADR 0103), checked as an edit of the built-in prompt is: what the
 * shape of a diff cannot say, such as a text much longer than the default it stands in for.
 */
function checkedDiff(ctx: RouteCtx, id: string, value: unknown): unknown {
  const system = (value as { system?: unknown } | null)?.system;
  if (!system || typeof system !== "object" || Array.isArray(system)) return value;
  const slot = promptSlot("turn.system");
  const engine = ctx.store.getPlaybook(id);
  const texts: Record<string, string> = {};
  for (const [locale, text] of Object.entries(system as Record<string, unknown>)) {
    if (typeof text !== "string" || (locale !== "zh" && locale !== "en")) return value;
    const checked = validatePromptText(slot, locale, text, engineSystemDefault(ctx.store, engine, locale));
    if (!checked.ok) throw promptProblemsError(checked.problems);
    texts[locale] = checked.text;
  }
  return { ...(value as object), system: texts };
}

/**
 * Local API routes for engines (ADR 0085): the list with the default, one engine and its history,
 * your changes as a diff from its built-in, a step or the whole engine reset, a custom engine made
 * from another, renamed or removed, a conversation's engine, and what moving to one with no jobs
 * would leave standing. Changes are published as `playbook.changed` (and `session.upsert` for a
 * conversation's) by the store's journal.
 */
export function playbookRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { input, store, method, path, url } = ctx;
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

  if (path === "/v1/playbooks/impact") {
    return method === "GET" ? jsonResponse(store.playbookImpact({ sessionId: url.searchParams.get("session_id") }), 200, null) : null;
  }

  params = matchPath(path, "/v1/playbooks/:id/system");
  if (params && method === "GET") {
    const locale = url.searchParams.get("locale");
    if (locale !== "zh" && locale !== "en") throw new HttpError(422, "invalid_args", "locale must be zh or en");
    const engine = store.getPlaybook(params.id!);
    return jsonResponse({ text: engineSystemDefault(store, engine, locale as Locale), own: engine.diff.system?.[locale as Locale] ?? null }, 200, null);
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
    if (method === "PUT") return jsonResponse(store.savePlaybook(params.id!, { diff: checkedDiff(ctx, params.id!, body.diff), ifRevision: revisionGuard(body.if_revision), actor: "user" }), 200, null);
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
