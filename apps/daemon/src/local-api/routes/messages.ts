import { USER_MEMBER, type AnnotationFilter, type ControlActionRequest, type CreateAnnotationRequest, type PatchAnnotationRequest, type SendAnnotationsRequest } from "@real-bot/protocol";
import { existsSync } from "node:fs";
import { attachmentMime } from "../../artifact-mime";
import { HttpError } from "../../errors";
import { fileEtag } from "../../file-integrity";
import { emptyResponse, jsonResponse, matchPath } from "../../http";
import { ulid } from "../../ids";
import { parseImageVariant } from "../../image-variant";
import { sessionUpsertFields } from "../../session-events";
import { attributionOptions } from "../../store/attribution-options";
import { delegationViews } from "../../store/delegation-view";
import { confirmGroupLead, groupLeadState } from "../../store/group-leads";
import { eraseQuotesOption, fileResponse, occurred, plansQuotedIn, REACTIONS } from "../helpers";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: session archive / restore / patch / delete, submissions, delegations, the group lead, message answers, control, attribution, edits, reactions, attachments and annotations. */
export function messageRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { request, url, options, publish, engine, input, scope, store, method, path } = ctx;
  let params: ReturnType<typeof matchPath>;

  params = matchPath(path, "/v1/sessions/:id/archive");
  if (params && method === "POST") {
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    const session = store.archiveSession(params.id!);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id/restore");
  if (params && method === "POST") {
    const session = store.restoreSession(params.id!);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id");
  if (params && method === "GET") {
    const session = store.getSession(params.id!);
    session.turns = session.turns.map((turn) => ({
      ...turn,
      partial_text: engine.partialText(turn.id) ?? turn.partial_text,
    }));
    session.pending_judgements = engine.pendingJudgements(params.id!);
    return jsonResponse(session, 200, null);
  }
  if (params && method === "PATCH") {
    const body = (input.body) as { name?: string };
    if (typeof body.name !== "string") {
      throw new HttpError(422, "invalid_args", "name is required");
    }
    const session = store.renameSession(params.id!, body.name);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }
  if (params && method === "DELETE") {
    const session = store.getSession(params.id!);
    if (session.kind !== "group") {
      throw new HttpError(422, "invalid_args", "only groups can be deleted");
    }
    const eraseQuotes = eraseQuotesOption(input.body);
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    const quoted = eraseQuotes ? plansQuotedIn(store, params.id!) : [];
    const dormant = store.deleteSession(params.id!, { eraseQuotes });
    store.afterCommit(() => engine.forgetPlans(dormant));
    for (const taskId of quoted) store.afterCommit(() => engine.syncDerivedChecks(taskId));
    publish({
      event: "session.removed",
      occurred_at: occurred(),
      id: params.id!,
    });
    return emptyResponse(204, null);
  }

  // A plan's hand-overs (ADR 0046): each submission, the checks the app ran on it, its reviews.
  params = matchPath(path, "/v1/tasks/:id/submissions");
  if (params && method === "GET") {
    store.getTask(params.id!);
    return jsonResponse({ items: store.listSubmissions({ taskId: params.id!, limit: 200 }) }, 200, null);
  }

  // Structured handoffs remain readable in their plan and ordinary direct after any segment ends.
  params = matchPath(path, "/v1/tasks/:id/delegations");
  if (params && method === "GET") return jsonResponse(delegationViews(store, { taskId: params.id! }), 200, null);
  params = matchPath(path, "/v1/sessions/:id/delegations");
  if (params && method === "GET") return jsonResponse(delegationViews(store, { sessionId: params.id! }), 200, null);

  // A suggestion based on real handoffs is read-only; assigning it needs your explicit click (D22).
  params = matchPath(path, "/v1/sessions/:id/lead");
  if (params && method === "GET") return jsonResponse(groupLeadState(store, params.id!), 200, null);
  if (params && method === "PUT") {
    const body = input.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "bot_id" && key !== "confirmed")
      || (body as { confirmed?: unknown }).confirmed !== true
      || !Object.hasOwn(body, "bot_id")
      || ((body as { bot_id?: unknown }).bot_id !== null && typeof (body as { bot_id?: unknown }).bot_id !== "string")) {
      throw new HttpError(422, "invalid_args", "bot_id and confirmed: true are required");
    }
    const state = confirmGroupLead(store, params.id!, (body as { bot_id: string | null }).bot_id);
    publish({ event: "group_lead.changed", occurred_at: occurred(), ...state });
    publish({ event: "session.upsert", occurred_at: occurred(), ...sessionUpsertFields(store.getSession(params.id!)) });
    return jsonResponse(state, 200, null);
  }

  // A blocked work question survives its ended segment; answering does not lift stops or resolve approvals.
  params = matchPath(path, "/v1/messages/:id/work-answer");
  if (params && method === "POST") {
    const body = input.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "body")
      || typeof (body as { body?: unknown }).body !== "string" || !(body as { body: string }).body.trim()) {
      throw new HttpError(422, "invalid_args", "a non-empty answer body is required");
    }
    const answered = store.answerWorkQuestion(params.id!, { body: (body as { body: string }).body, userActionId: scope?.requestId ?? ulid() });
    if (answered.answered) store.afterCommit(() => engine.dispatchQueuedWork());
    return jsonResponse(answered, 200, null);
  }

  // Your answer to a Bot's question is written onto the question: choices it offered, text of your
  // own, or both. A draining daemon still takes it, like any reply a waiting turn needs to finish.
  params = matchPath(path, "/v1/messages/:id/answer");
  if (params && method === "POST") {
    const body = input.body as { selected?: unknown; custom?: unknown };
    const ask = store.getMessage(params.id!);
    const answered = store.transaction(() => engine.replyAsk(ask.id, ask.session_id, { selected: body.selected, custom: body.custom }));
    return jsonResponse(answered, 200, null);
  }

  // A button on a line about your stops: the app's receipt or status answer, or your line it marked
  // as maybe meaning one. The line says which buttons it offers; the engine refuses any other.
  params = matchPath(path, "/v1/messages/:id/control");
  if (params && method === "POST") {
    const body = (input.body ?? {}) as Partial<ControlActionRequest>;
    if (store.getMessage(params.id!).control?.kind === "plan_opened") {
      if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)
        || Object.keys(input.body).some((key) => key !== "action" && key !== "task_id")) {
        throw new HttpError(422, "invalid_args", "a new-plan button takes only action and an optional target task_id");
      }
      return jsonResponse(store.actNewPlanCard(params.id!, { action: body.action, taskId: body.task_id,
        userActionId: scope?.requestId ?? ulid() }, (taskId) => engine.createHold({
        scope: "plan", scopeId: taskId, action: "cancel", cascade: true, liftOnNextUserMessage: false,
      })), 200, null);
    }
    return jsonResponse(engine.control(params.id!, { action: body.action, taskId: body.task_id, note: body.note }), 200, null);
  }

  // Move a line to another job (ADR 0040 §8.5). The inbox items it already reached move with it.
  params = matchPath(path, "/v1/messages/:id/attribution");
  if (params && method === "GET") return jsonResponse(attributionOptions(store, params.id!), 200, null);
  if (params && method === "PATCH") {
    const body = input.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "invalid_args", "an attribution object is required");
    // 「新开一件事」: the line opens a job of its own and is filed there.
    if (Object.hasOwn(body, "new_plan")) {
      const fresh = (body as { new_plan: unknown }).new_plan;
      if (Object.keys(body).length !== 1 || !fresh || typeof fresh !== "object" || Array.isArray(fresh)
        || Object.keys(fresh).some((key) => key !== "title")
        || ((fresh as { title?: unknown }).title !== undefined && (fresh as { title?: unknown }).title !== null
          && (typeof (fresh as { title?: unknown }).title !== "string" || ((fresh as { title: string }).title).length > 200))) {
        throw new HttpError(422, "invalid_args", "new_plan is {title?}");
      }
      const opened = store.newJobFromLine(params.id!, { title: (fresh as { title?: string | null }).title ?? null, userActionId: scope?.requestId ?? ulid() });
      engine.noteFiled(opened.id);
      store.afterCommit(() => engine.dispatchQueuedWork());
      publish({ event: "attribution.changed", occurred_at: occurred(), message_id: opened.id, session_id: opened.session_id,
        filing_state: opened.filing_state ?? "filed", filings: opened.filings ?? [] });
      return jsonResponse(opened, 200, null);
    }
    const multi = Object.hasOwn(body, "filings");
    if (multi && Object.keys(body).length !== 1) throw new HttpError(422, "invalid_args", "choose filings or one plan_id");
    const targets = multi ? (body as { filings: unknown }).filings : [body];
    if (!Array.isArray(targets) || targets.length > 100) throw new HttpError(422, "invalid_args", "filings must be a list of at most 100 targets");
    const filings = targets.map((target) => {
      if (!target || typeof target !== "object" || Array.isArray(target)
        || Object.keys(target).some((key) => !["plan_id", "ticket_id", "part_key"].includes(key))) {
        throw new HttpError(422, "invalid_args", "invalid attribution target");
      }
      const { plan_id, ticket_id, part_key } = target as { plan_id?: unknown; ticket_id?: unknown; part_key?: unknown };
      if (typeof plan_id !== "string" || !plan_id
        || (ticket_id !== undefined && ticket_id !== null && (typeof ticket_id !== "string" || !ticket_id))
        || (part_key !== undefined && part_key !== null && (typeof part_key !== "string" || !part_key || part_key.length > 200))) {
        throw new HttpError(422, "invalid_args", "plan_id, ticket_id and part_key must name a target");
      }
      return { taskId: plan_id, ticketId: ticket_id as string | null | undefined, partKey: part_key as string | null | undefined };
    });
    store.getMessage(params.id!);
    const moved = store.refileMessage(params.id!, { filings, userActionId: scope?.requestId ?? ulid() });
    // A line that was on no job has one now: the scribe reads it against it.
    if (filings.length > 0) engine.noteFiled(moved.id);
    publish({ event: "attribution.changed", occurred_at: occurred(), message_id: moved.id, session_id: moved.session_id,
      filing_state: moved.filing_state ?? (filings.length ? "filed" : "none"), filings: moved.filings ?? [] });
    return jsonResponse(moved, 200, null);
  }

  // Change a line of yours after it went out (ADR 0063): the words it shows, and what each Bot hears
  // of it, decided in this one write; the Bots told of it start once it is in.
  params = matchPath(path, "/v1/messages/:id");
  if (params && method === "PATCH") {
    const body = input.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "body")) {
      throw new HttpError(422, "invalid_args", "an edit is {body}");
    }
    options.admission?.assertNew();
    const result = store.editMessage(params.id!, { body: (body as { body?: unknown }).body, userActionId: scope?.requestId ?? ulid() });
    if (result.edit) {
      store.afterCommit(() => engine.noteEdited(result));
      publish({ event: "message.upsert", occurred_at: occurred(), ...result.message });
    }
    return jsonResponse(result.message, 200, null);
  }
  // Take back a line of yours no Bot has read yet (撤回, ADR 0069): every copy of it waiting in an
  // inbox ends, and it stays in the transcript as taken back.
  params = matchPath(path, "/v1/messages/:id/withdraw");
  if (params && method === "POST") {
    const result = store.withdrawMessage(params.id!, { userActionId: scope?.requestId ?? ulid() });
    if (result.withdrawn > 0) {
      store.afterCommit(() => engine.noteWithdrawn(result.message.id));
      publish({ event: "message.upsert", occurred_at: occurred(), ...result.message });
    }
    return jsonResponse(result.message, 200, null);
  }
  // Have the working Bot read a line of yours now (直接插入, ADR 0069) instead of at its next step.
  params = matchPath(path, "/v1/messages/:id/insert");
  if (params && method === "POST") {
    const line = store.getMessage(params.id!);
    if (line.kind !== "user" || line.author !== USER_MEMBER) throw new HttpError(422, "invalid_args", "only a line of yours is read now");
    if (line.withdrawn_at) throw new HttpError(422, "withdrawn", "you took this line back");
    const inserted = engine.insertNow(line.id);
    // A Stop holding it goes with 直接插入; a stop that stays until you lift it does not.
    if (store.getMessage(line.id).delivery?.state === "held") throw new HttpError(409, "held", "a stop holds this line until you lift it");
    return jsonResponse({ message: store.getMessage(line.id), inserted }, 200, null);
  }
  // What a line you changed said before, oldest first.
  params = matchPath(path, "/v1/messages/:id/versions");
  if (params && method === "GET") return jsonResponse({ versions: store.messageVersions(params.id!) }, 200, null);

  params = matchPath(path, "/v1/messages/:id/reactions");
  if (params && (method === "PUT" || method === "DELETE")) {
    const body = (input.body) as { emoji?: string };
    if (!body.emoji || !REACTIONS.has(body.emoji)) {
      throw new HttpError(422, "invalid_args", "emoji is not in the allowed set");
    }
    if (method === "PUT") store.putReaction(params.id!, body.emoji);
    else store.deleteReaction(params.id!, body.emoji);
    publish({
      event: "reaction.changed",
      occurred_at: occurred(),
      message_id: params.id!,
      actor: USER_MEMBER,
      emoji: body.emoji,
      op: method === "PUT" ? "add" : "remove",
    });
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/attachments/:id/content");
  if (params && method === "GET") {
    const att = store.getAttachment(params.id!);
    const located = store.resolveAttachmentLocation(att.workspace_relpath);
    if (!located || !existsSync(located.abs)) {
      throw new HttpError(404, "not_found", "attachment file not found on disk");
    }
    if (located.isDir) {
      throw new HttpError(422, "invalid_args", "attachment is a directory");
    }
    const variant = parseImageVariant(url.searchParams.get("size"));
    const mime = attachmentMime(att.original_filename, att.workspace_relpath);
    return fileResponse(located.abs, mime, att.original_filename, variant, url.searchParams.get("range") ?? request.headers.get("Range"));
  }

  params = matchPath(path, "/v1/attachments/:id");
  if (params && method === "GET") {
    const att = store.getAttachment(params.id!);
    return jsonResponse(att, 200, null);
  }

  // Annotations: drafts you keep on an artifact, sent as one quoted reply that wakes the Bot.
  if (method === "GET" && path === "/v1/annotations") {
    const q = url.searchParams;
    const filter: AnnotationFilter = {};
    for (const key of ["relpath", "session_id", "target_session_id", "message_id", "target_message_id", "status"] as const) {
      const value = q.get(key);
      if (value !== null) (filter as Record<string, string>)[key] = value;
    }
    return jsonResponse({ items: store.listAnnotations(filter) }, 200, null);
  }
  if (method === "POST" && path === "/v1/annotations") {
    return jsonResponse(store.createAnnotation(input.body as CreateAnnotationRequest), 201, null);
  }
  if (method === "POST" && path === "/v1/annotations/send") {
    // The batch wakes the Bot the way your own message would: same admission, same door.
    options.admission?.assertNew();
    const sent = store.sendAnnotations(input.body as SendAnnotationsRequest);
    publish({ event: "message.created", occurred_at: occurred(), ...sent.message });
    store.afterCommit(() => { void engine.handleInboundMessage(sent.message, { fromUser: true }); });
    return jsonResponse(sent, 201, null);
  }
  params = matchPath(path, "/v1/annotations/:id/crop");
  if (params && method === "GET") {
    const crop = store.annotationCrop(params.id!);
    if (!crop) throw new HttpError(404, "not_found", "this annotation has no crop");
    const bytes = Buffer.from(crop.bytes);
    return new Response(bytes, {
      status: 200,
      headers: {
        "ETag": fileEtag(bytes),
        "Content-Type": crop.mime,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `inline; filename="annotation-${params.id!}.${crop.mime === "image/png" ? "png" : "jpg"}"`,
      },
    });
  }
  params = matchPath(path, "/v1/annotations/:id");
  if (params && method === "GET") {
    return jsonResponse(store.getAnnotation(params.id!), 200, null);
  }
  if (params && method === "PATCH") {
    return jsonResponse(store.patchAnnotation(params.id!, input.body as PatchAnnotationRequest), 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteAnnotation(params.id!);
    return emptyResponse(204, null);
  }

  return null;
}
