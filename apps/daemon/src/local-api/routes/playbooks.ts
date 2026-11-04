import { CUSTOM_STEP_TOOLS, isPlaybookStepId, validateCustomSteps, type CustomStepSample, type Locale } from "@real-bot/protocol";
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

/** A try's sample as sent: only what a step looks at, each field optional. */
function trySample(value: unknown): CustomStepSample {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(422, "invalid_args", "sample must be an object");
  const raw = value as Record<string, unknown>;
  const out: CustomStepSample = {};
  if (raw.tool !== undefined) {
    if (!(CUSTOM_STEP_TOOLS as readonly unknown[]).includes(raw.tool)) throw new HttpError(422, "invalid_args", `sample.tool must be one of ${CUSTOM_STEP_TOOLS.join(", ")}`);
    out.tool = raw.tool as CustomStepSample["tool"];
  }
  if (raw.command !== undefined) {
    if (typeof raw.command !== "string" || raw.command.length > 4000) throw new HttpError(422, "invalid_args", "sample.command must be text");
    out.command = raw.command;
  }
  if (raw.reply !== undefined) {
    if (typeof raw.reply !== "string" || raw.reply.length > 20_000) throw new HttpError(422, "invalid_args", "sample.reply must be text");
    out.reply = raw.reply;
  }
  if (raw.paths !== undefined) {
    if (!Array.isArray(raw.paths) || raw.paths.length > 50 || raw.paths.some((path) => typeof path !== "string" || path.length > 1000)) {
      throw new HttpError(422, "invalid_args", "sample.paths must be a list of paths");
    }
    out.paths = raw.paths as string[];
  }
  return out;
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

  // A step of your own judged on a sample (ADR 0105): the step as drafted, refused, sent back,
  // recorded nowhere. Not a write, and it may run a while, so it carries no receipt.
  params = matchPath(path, "/v1/playbooks/:id/custom-steps/try");
  if (params && method === "POST") {
    store.getPlaybook(params.id!);
    const [step] = validateCustomSteps([body.step], (message) => {
      throw new HttpError(422, "invalid_args", message.replace("diff.custom_steps[0]", "step"));
    });
    const sample = trySample(body.sample);
    return (async () => jsonResponse(await ctx.engine.tryCustomStep(step!, sample), 200, null))();
  }

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
