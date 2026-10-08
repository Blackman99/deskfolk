import { FILE_DROP_SESSION_ID, type CreateBotRequest, type PatchBotRequest } from "@real-bot/protocol";
import { isDisplayAvatar, withoutDisplayMark } from "../../avatar-display";
import { HttpError } from "../../errors";
import { emptyResponse, jsonResponse, matchPath } from "../../http";
import { sessionUpsertFields } from "../../session-events";
import { displayBot, eraseQuotesOption, messagePaths, occurred, plansQuotedIn } from "../helpers";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: Bots, sessions, their messages, clearing and members. */
export function botAndSessionRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { url, options, publish, engine, input, store, method, path } = ctx;
  let params: ReturnType<typeof matchPath>;

  if (method === "GET" && path === "/v1/bots") {
    return jsonResponse({ items: store.listBots().map(displayBot) }, 200, null);
  }

  if (method === "POST" && path === "/v1/bots") {
    let body = (input.body) as CreateBotRequest;
    // A portrait copied from another Bot's card is that picture: keep it, without the mark.
    if (typeof body.avatar === "string" && isDisplayAvatar(body.avatar)) body = { ...body, avatar: withoutDisplayMark(body.avatar) };
    const created = store.createBot(body);
    const at = occurred();
    publish({ event: "bot.upsert", occurred_at: at, ...created.bot, deleted_at: null });
    publish({
      event: "session.upsert",
      occurred_at: at,
      ...sessionUpsertFields(created.direct_session),
    });
    return jsonResponse({ ...created, bot: displayBot(created.bot) }, 201, null);
  }

  params = matchPath(path, "/v1/bots/:id/archive");
  if (params && method === "POST") {
    const bot = store.archiveBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(displayBot(bot), 200, null);
  }
  params = matchPath(path, "/v1/bots/:id/restore");
  if (params && method === "POST") {
    const bot = store.restoreBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(displayBot(bot), 200, null);
  }
  params = matchPath(path, "/v1/bots/:id/profile-revisions");
  if (params && method === "GET") {
    return jsonResponse({ items: store.listProfileRevisions(params.id!) }, 200, null);
  }
  params = matchPath(path, "/v1/bots/:id");
  if (params && method === "GET") {
    return jsonResponse(displayBot(store.getBot(params.id!)), 200, null);
  }
  if (params && method === "PATCH") {
    let body = (input.body) as PatchBotRequest;
    // A profile save sends back the portrait it was shown with every other edit. That is the
    // small copy, never a new picture: the stored original stays.
    if (typeof body.avatar === "string" && isDisplayAvatar(body.avatar)) {
      const { avatar: _shown, ...rest } = body;
      body = rest;
    }
    const bot = store.patchBot(params.id!, body);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(displayBot(bot), 200, null);
  }
  if (params && method === "DELETE") {
    const bot = store.getBot(params.id!);
    store.deleteBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: occurred() });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/sessions") {
    const pending = engine.pendingJudgements();
    const pendingBySession = new Map<string, typeof pending>();
    for (const row of pending) {
      const list = pendingBySession.get(row.session_id) ?? [];
      list.push(row);
      pendingBySession.set(row.session_id, list);
    }
    const items = store.listSessions().map((s) => ({
      ...s,
      live_turns: s.live_turns?.map((turn) => ({
        ...turn,
        partial_text: engine.partialText(turn.id) ?? turn.partial_text,
      })),
      pending_judgements: pendingBySession.get(s.id) ?? [],
    }));
    return jsonResponse({ items }, 200, null);
  }
  if (method === "POST" && path === "/v1/sessions") {
    options.admission?.assertNew();
    const body = (input.body) as { name: string; members: string[] };
    const session = store.createGroup(body);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 201, null);
  }

  params = matchPath(path, "/v1/sessions/:id/messages");
  if (params && method === "GET") {
    const cursor = url.searchParams.get("cursor");
    const limitText = url.searchParams.get("limit");
    const limit = limitText ? Number(limitText) : undefined;
    return jsonResponse(store.listMessages(params.id!, { cursor, limit }), 200, null);
  }
  if (params && method === "POST") {
    const body = input.body;
    const bodyText = typeof body.body === "string" ? body.body : "";
    const parentId = typeof body.parent_id === "string" ? body.parent_id || null : null;
    const askId = typeof body.ask_id === "string" ? body.ask_id || null : null;
    const fork = body.fork === undefined ? undefined : body.fork === true || body.fork === "true";
    const fileInputs = input.files;
    if (Array.isArray(body.files) && body.files.length && !fileInputs.length) {
      throw new HttpError(422, "invalid_args", "remote file bytes must arrive on type 0x05");
    }
    const paths = messagePaths(body.paths);

    const sessionId = params.id!;
    const fileDrop = sessionId === FILE_DROP_SESSION_ID;
    if (askId) {
      if (fileDrop) throw new HttpError(422, "invalid_args", "the file drop does not answer asks");
      if (fileInputs.length > 0 || paths.length > 0) throw new HttpError(422, "invalid_args", "an answer carries no files");
      // Clients from before `POST /v1/messages/:id/answer` still answer this way. The text is
      // written onto the question as your own answer, and no message of yours is posted.
      const answered = store.transaction(() => engine.replyAsk(askId, sessionId, { custom: bodyText }));
      return jsonResponse(answered, 201, null);
    }
    // The file drop is where files arrive on the Mac; what is already in the workspace has no reason to go there.
    if (fileDrop && paths.length > 0) throw new HttpError(422, "invalid_args", "the file drop takes files, not workspace paths");
    options.admission?.assertNew();
    const message = store.transaction(() => store.postMessage(sessionId, {
      body: bodyText,
      parent_id: parentId,
      attachments: fileInputs.length > 0 ? fileInputs : undefined,
      paths: paths.length > 0 ? paths : undefined,
    }));
    publish({ event: "message.created", occurred_at: occurred(), ...message });
    // A file dropped here is already in inbox/. Nothing is woken.
    if (!fileDrop) {
      store.afterCommit(() => { void engine.handleInboundMessage(message, { fork, fromUser: true }); });
    }
    return jsonResponse(message, 201, null);
  }
  if (params && method === "DELETE") {
    store.getSession(params.id!);
    const eraseQuotes = eraseQuotesOption(input.body);
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    const quoted = eraseQuotes ? plansQuotedIn(store, params.id!) : [];
    const dormant = store.clearSessionMessages(params.id!, { eraseQuotes });
    // Its plans are set aside: what was pending for them would fire into the cleared conversation.
    store.afterCommit(() => engine.forgetPlans(dormant));
    for (const taskId of quoted) store.afterCommit(() => engine.syncDerivedChecks(taskId));
    publish({ event: "session.cleared", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/sessions/:id/clear");
  if (params && method === "POST") {
    store.getSession(params.id!);
    const eraseQuotes = eraseQuotesOption(input.body);
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    const quoted = eraseQuotes ? plansQuotedIn(store, params.id!) : [];
    const dormant = store.clearSessionMessages(params.id!, { eraseQuotes });
    // Its plans are set aside: what was pending for them would fire into the cleared conversation.
    store.afterCommit(() => engine.forgetPlans(dormant));
    for (const taskId of quoted) store.afterCommit(() => engine.syncDerivedChecks(taskId));
    publish({ event: "session.cleared", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/sessions/:id/members");
  if (params && method === "POST") {
    options.admission?.assertNew();
    const body = (input.body) as { bot_id: string };
    const session = store.addMember(params.id!, body.bot_id);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }
  if (params && method === "DELETE") {
    const body = (input.body) as { bot_id: string };
    const session = store.removeMember(params.id!, body.bot_id);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }

  return null;
}
