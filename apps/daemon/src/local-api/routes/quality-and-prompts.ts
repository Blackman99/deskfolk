import type { LessonPatch, ModelLadderResponse, QualityCategory, SessionSummary, SharedSkillsResponse } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { emptyResponse, jsonResponse, matchPath } from "../../http";
import { isoNow, isUlid } from "../../ids";
import { keepMyPrompt, resetPromptText, restorePromptRevision, savePromptText, undoPromptRevision } from "../../prompts/book";
import { listPromptSummaries, promptDetail } from "../../prompts/views";
import { sessionUpsertFields } from "../../session-events";
import { QUALITY_CATEGORIES as QUALITY_CATEGORY_NAMES } from "../../store/quality";
import { learningOut, occurred, reviewOut } from "../helpers";
import { promptRevisionGuard } from "../parse";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: quality events, lessons, the model ladder, shared skills, prompts and their revisions, retrospectives, a session's routes, composer suggestions and read marks. */
export function qualityAndPromptRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { request, url, publish, engine, input, scope, store, method, path } = ctx;
  let params: ReturnType<typeof matchPath>;

  if (path === "/v1/quality/events" && method === "GET") {
    const category = url.searchParams.get("category");
    return jsonResponse({ items: store.listQualityEvents({
      botId: url.searchParams.get("bot_id") ?? undefined,
      ticketId: url.searchParams.get("ticket_id") ?? undefined,
      category: category && (QUALITY_CATEGORY_NAMES as readonly string[]).includes(category) ? category as QualityCategory : undefined,
      limit: Number(url.searchParams.get("limit") ?? 100) || 100,
    }) }, 200, null);
  }

  if (path === "/v1/quality/report" && method === "GET") {
    const days = Number(url.searchParams.get("days") ?? 7);
    return jsonResponse({ items: store.qualityReport({ days: Number.isFinite(days) ? Math.min(90, Math.max(1, days)) : 7 }) }, 200, null);
  }

  if (path === "/v1/lessons" && method === "GET") {
    const status = url.searchParams.get("status");
    return jsonResponse({ items: store.listLessons(status === "active" || status === "retired" || status === "candidate" ? { status } : {}) }, 200, null);
  }

  if (path === "/v1/model-ladder" && (method === "GET" || method === "PUT")) {
    const items = method === "PUT" ? store.setModelLadder(((input.body ?? {}) as { items?: unknown }).items) : store.modelLadder();
    return jsonResponse({ items, available: store.routingOn() } satisfies ModelLadderResponse, 200, null);
  }

  if (path === "/v1/shared-skills" && method === "GET") {
    return jsonResponse({ items: store.listSharedSkills(), available: store.learningOn() } satisfies SharedSkillsResponse, 200, null);
  }

  params = matchPath(path, "/v1/skills/:id/share");
  if (params && method === "POST") {
    return jsonResponse(store.shareSkill(params.id!), 200, null);
  }

  params = matchPath(path, "/v1/shared-skills/:id");
  if (params && method === "PATCH") {
    const body = (input.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") throw new HttpError(422, "invalid_args", "enabled is required");
    return jsonResponse(store.setSharedSkillEnabled(params.id!, body.enabled), 200, null);
  }
  if (params && method === "DELETE") {
    store.unshareSkill(params.id!);
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/lessons/:id");
  if (params && method === "PATCH") {
    const body = (input.body ?? {}) as LessonPatch;
    const lesson = store.updateLesson(params.id!, {
      ...(body.status === "active" || body.status === "retired" ? { status: body.status } : {}),
      ...(body.action === "warn" || body.action === "block" ? { action: body.action } : {}),
      ...(typeof body.text === "string" ? { text: body.text } : {}),
    });
    // A reflection's lesson retired here settles its card, and may take its check off the board.
    const card = lesson.detector.tool === "reflection" ? store.lessonCard(lesson.id) : null;
    if (card) {
      publish({ event: "message.upsert", occurred_at: isoNow(), ...card });
      if (card.control?.kind === "lesson") engine.renderPlanMirrors(card.control.task_id);
    }
    return jsonResponse(lesson, 200, null);
  }

  // Built-in prompts (ADR 0064): every one and its state, one in full, your edits, and changes taken back.
  if (method === "GET" && path === "/v1/prompts") return jsonResponse({ items: listPromptSummaries(store) }, 200, null);
  params = matchPath(path, "/v1/prompts/:id/:locale");
  if (params && method === "GET") return jsonResponse(promptDetail(store, params.id!, params.locale!), 200, null);
  if (params && method === "PUT") {
    const body = (input.body ?? {}) as { text?: unknown; if_revision?: unknown; edit_session?: unknown };
    if (typeof body.text !== "string") throw new HttpError(422, "invalid_args", "text is required");
    savePromptText(store, {
      id: params.id!, locale: params.locale!, text: body.text, ifRevision: promptRevisionGuard(body.if_revision),
      editSession: typeof body.edit_session === "string" && body.edit_session ? body.edit_session : null, actor: "user",
    });
    return jsonResponse(promptDetail(store, params.id!, params.locale!), 200, null);
  }
  params = matchPath(path, "/v1/prompts/:id/:locale/reset");
  if (params && method === "POST") {
    resetPromptText(store, { id: params.id!, locale: params.locale!, ifRevision: promptRevisionGuard((input.body as { if_revision?: unknown } | null)?.if_revision), actor: "user" });
    return jsonResponse(promptDetail(store, params.id!, params.locale!), 200, null);
  }
  params = matchPath(path, "/v1/prompts/:id/:locale/keep-mine");
  if (params && method === "POST") {
    keepMyPrompt(store, { id: params.id!, locale: params.locale!, ifRevision: promptRevisionGuard((input.body as { if_revision?: unknown } | null)?.if_revision) });
    return jsonResponse(promptDetail(store, params.id!, params.locale!), 200, null);
  }
  // The change an approval card let through, for the card's own Undo.
  if (method === "GET" && path === "/v1/prompt-revisions") {
    const approvalId = url.searchParams.get("approval_id");
    if (!approvalId) throw new HttpError(422, "invalid_args", "approval_id is required");
    const row = store.promptRevisionByApproval(approvalId);
    const head = row ? store.promptHead(row.prompt_id, row.locale) : null;
    const now = row ? store.promptOverride(row.prompt_id, row.locale) : null;
    return jsonResponse({ items: row ? [{ id: row.id, prompt_id: row.prompt_id, locale: row.locale, undoable: head?.id === row.id && (now?.text ?? null) === row.after_text }] : [] }, 200, null);
  }
  params = matchPath(path, "/v1/prompt-revisions/:id/undo");
  if (params && method === "POST") {
    undoPromptRevision(store, params.id!);
    const revision = store.promptRevision(params.id!)!;
    return jsonResponse(promptDetail(store, revision.prompt_id, revision.locale), 200, null);
  }
  params = matchPath(path, "/v1/prompt-revisions/:id/restore");
  if (params && method === "POST") {
    restorePromptRevision(store, params.id!);
    const revision = store.promptRevision(params.id!)!;
    return jsonResponse(promptDetail(store, revision.prompt_id, revision.locale), 200, null);
  }

  // A change a retrospective made (ADR 0062), taken back from the plan's board: the board's plan comes back.
  params = matchPath(path, "/v1/retrospectives/:id/changes/:index/undo");
  if (params && method === "POST") {
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0) throw new HttpError(422, "invalid_args", "index must be a change's position");
    const retrospective = store.undoRetrospectiveChange(params.id!, index);
    return jsonResponse(store.taskDetail(retrospective.task_id, store.citedPathExists), 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id/routes");
  if (params && method === "GET") {
    store.getSession(params.id!);
    return jsonResponse(
      {
        items: store.listSessionRoutes(params.id!),
        reviews: store.listSessionReviews(params.id!).map((row) => reviewOut(store, row)),
        learnings: store.listSessionLearnings(params.id!).map((row) => learningOut(store, row)),
      },
      200,
      null,
    );
  }

  params = matchPath(path, "/v1/sessions/:id/composer-suggestions");
  if (params && method === "GET") {
    store.getSession(params.id!);
    return engine.suggestComposer(params.id!, request.signal, scope?.guard).then((items) => jsonResponse({ items }, 200, null), () => jsonResponse({ items: [] }, 200, null));
  }

  params = matchPath(path, "/v1/sessions/:id/read");
  if (params && method === "POST") {
    const body = input.body as { through_message_id?: string };
    if (
      body &&
      body.through_message_id !== undefined &&
      (typeof body.through_message_id !== "string" ||
        !isUlid(body.through_message_id))
    ) {
      throw new HttpError(422, "invalid_args", "through_message_id must be a valid ULID");
    }
    const session = store.markSessionRead(
      params.id!,
      body?.through_message_id ? { through_message_id: body.through_message_id } : undefined,
    );
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    // The read state, not the transcript: a client already has the messages it just read, and
    // on a phone the whole detail was 150 KB every time a conversation was opened.
    const { messages: _messages, turns: _turns, pending_judgements: _pending, ...summary } = session;
    return jsonResponse(summary satisfies SessionSummary, 200, null);
  }

  return null;
}
