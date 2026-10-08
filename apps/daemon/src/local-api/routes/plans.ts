import type { CreateHoldRequest, PatchAcceptanceCheckRequest, PatchTaskSpecRequest, PatchTicketRequest, RequirementActionRequest, RunAcceptanceChecksRequest, TurnCommandsResponse } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { jsonResponse, matchPath } from "../../http";
import { isUlid } from "../../ids";
import { learningOut, reviewOut } from "../helpers";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: tasks, tickets, specs, checks, requirements, holds, judgements. */
export function planRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { url, engine, input, store, method, path } = ctx;
  let params: ReturnType<typeof matchPath>;

  params = matchPath(path, "/v1/tasks/:id/artifacts");
  if (params && method === "GET") {
    const task = store.getTask(params.id!);
    return jsonResponse(
      {
        id: task.id,
        dir: task.dir,
        title: task.title,
        closed_at: task.closed_at,
        items: store.taskArtifacts(task.id, store.citedPathExists),
      },
      200,
      null,
    );
  }

  params = matchPath(path, "/v1/turns/:id/commands");
  if (params && method === "GET") {
    // What a turn ran, for the command card under its reply once it has ended; 404 once it is gone.
    store.getTurn(params.id!);
    const body: TurnCommandsResponse = { items: store.turnCommands(params.id!) };
    return jsonResponse(body, 200, null);
  }

  params = matchPath(path, "/v1/tasks/:id/trace");
  if (params && method === "GET") {
    const trace = store.taskTrace(params.id!);
    // Each card carries the model choice its turn ran on, so the board is where it is read.
    const records = new Map(store.listTaskRoutes(params.id!).map((record) => [record.turn_id, record]));
    const reviews = new Map(store.listTaskReviews(params.id!).map((row) => [row.turn_id, reviewOut(store, row)]));
    const learnings = new Map(store.listTaskLearnings(params.id!).map((row) => [row.chain_id, learningOut(store, row)]));
    const marking = store.learningOn();
    // A card's files open the preview as its tree; one deleted since must not come back there.
    const cited = new Set(trace.nodes.flatMap((node) => node.artifacts.map((file) => file.path)));
    const gone = store.transaction(() => new Set([...cited].filter((file) => !store.citedPathExists(file))));
    return jsonResponse(
      {
        ...trace,
        nodes: trace.nodes.map((node) => {
          const record = records.get(node.turn_id);
          const routed = {
            ...node,
            artifacts: node.artifacts.map((file) => ({ ...file, exists: !gone.has(file.path) })),
            route: record
              ? {
                  record,
                  review: reviews.get(node.turn_id) ?? null,
                  // A chain is named after the turn that started it; its note belongs there.
                  learning: record.chain_id === record.turn_id ? (learnings.get(record.chain_id) ?? null) : null,
                  ...(marking ? { marked_model: store.turnMarkedModel(node.turn_id) } : {}),
                }
              : null,
          };
          // A live turn's sentence lives in the engine, not the row, the same way a session's turns do.
          if (node.status !== "running") return routed;
          const live = engine.partialText(node.turn_id)?.replace(/\s+/g, " ").trim();
          return live ? { ...routed, summary: [...live].slice(0, 80).join("") } : routed;
        }),
      },
      200,
      null,
    );
  }

  params = matchPath(path, "/v1/sessions/:id/tasks");
  if (params && method === "GET") {
    store.getSession(params.id!);
    return jsonResponse({ items: store.sessionTasks(params.id!) }, 200, null);
  }

  params = matchPath(path, "/v1/tasks/:id/tickets");
  if (params && method === "GET") {
    return jsonResponse({ items: store.taskDetail(params.id!, store.citedPathExists).tickets }, 200, null);
  }

  params = matchPath(path, "/v1/tasks/:id/spec-revisions");
  if (params && method === "GET") {
    return jsonResponse({ items: store.listSpecRevisions(params.id!) }, 200, null);
  }

  // Local only (see dispatchBusiness): the organizer's own trail (ADR 0040 P0's observability).
  if (method === "GET" && path === "/v1/debug/organizer-runs") {
    const taskId = url.searchParams.get("task_id") ?? "";
    if (!isUlid(taskId)) throw new HttpError(422, "invalid_args", "task_id is required");
    return jsonResponse({ items: store.organizerRunsForTask(taskId) }, 200, null);
  }

  params = matchPath(path, "/v1/tasks/:id/spec");
  if (params && method === "PATCH") {
    const body = (input.body ?? {}) as PatchTaskSpecRequest;
    const { task } = store.setPlanSpecByUser(params.id!, body.spec, body.if_revision);
    // Parking a plan here is a hold on it (ADR 0040): what runs in it ends as with any other.
    engine.enforceHolds();
    engine.renderPlanMirrors(task.id);
    // A number in the lines you typed becomes a check like one you said (ADR 0040 P3).
    store.afterCommit(() => engine.syncDerivedChecks(task.id));
    return jsonResponse(store.taskDetail(task.id, store.citedPathExists), 200, null);
  }

  // Acceptance checks (可执行验收). Every route renders mirrors synchronously (they only touch
  // what is already committed); the run itself — a file read or a spawned command — is kicked off
  // from `store.afterCommit` so it starts after, and never inside, the write transaction.
  params = matchPath(path, "/v1/tasks/:id/checks");
  if (params && method === "POST") {
    const check = store.createCheckByUser(params.id!, input.body ?? {});
    engine.renderPlanMirrors(check.task_id);
    store.afterCommit(() => {
      void engine.runPlanChecks(check.task_id, { cause: "edit", checkIds: [check.id] }).catch(() => undefined);
    });
    return jsonResponse(store.taskDetail(check.task_id, store.citedPathExists), 201, null);
  }

  params = matchPath(path, "/v1/checks/:id");
  if (params && method === "PATCH") {
    const body = (input.body ?? {}) as PatchAcceptanceCheckRequest;
    const check = store.patchCheckByUser(params.id!, body, body.if_revision);
    engine.renderPlanMirrors(check.task_id);
    // A redefinition (defined_at just bumped to updated_at) is what earns a fresh run; renaming
    // the line it proves, or moving it to another ticket, changes nothing a run would answer.
    if (check.defined_at === check.updated_at) {
      store.afterCommit(() => {
        void engine.runPlanChecks(check.task_id, { cause: "edit", checkIds: [check.id] }).catch(() => undefined);
      });
    }
    return jsonResponse(store.taskDetail(check.task_id, store.citedPathExists), 200, null);
  }
  if (params && method === "DELETE") {
    const before = store.getCheck(params.id!);
    store.removeCheckByUser(params.id!);
    engine.renderPlanMirrors(before.task_id);
    // One from your words: turning down a replacement puts the check it would replace back in force.
    if (before.origin === "derived") store.afterCommit(() => engine.syncDerivedChecks(before.task_id));
    return jsonResponse(store.taskDetail(before.task_id, store.citedPathExists), 200, null);
  }

  // A check from your words, confirmed on the board (ADR 0040 P3): in force from now, run at once
  // when it has a file; a replacement takes the place of the check it replaces.
  params = matchPath(path, "/v1/checks/:id/confirm");
  if (params && method === "POST") {
    const check = store.getCheck(params.id!);
    if (check.origin !== "derived") throw new HttpError(422, "invalid_args", "only a check from your words is confirmed");
    engine.confirmDerivedCheck(check.id);
    return jsonResponse(store.taskDetail(check.task_id, store.citedPathExists), 200, null);
  }

  // An entry of the requirements ledger, from the plan's board (ADR 0040 P3): each action only
  // where it applies (a 409 when the entry has moved on), and the plan's board comes back.
  params = matchPath(path, "/v1/requirements/:id/action");
  if (params && method === "POST") {
    const body = (input.body ?? {}) as Partial<RequirementActionRequest>;
    const taskId = typeof body.task_id === "string" ? body.task_id : "";
    const task = store.getTask(taskId);
    const id = params.id!;
    switch (body.action) {
      case "confirm":
        store.confirmRequirement(id, { taskId: task.id });
        break;
      case "reject":
        store.rejectRequirement(id, { taskId: task.id });
        break;
      case "waive":
        store.waiveRequirement(id, { taskId: task.id });
        break;
      case "not_here":
      case "here_again":
        store.setRequirementHere(id, { taskId: task.id, holds: body.action === "here_again" });
        break;
      case "whole_project":
        store.widenRequirement(id, { to: "project", taskId: task.id });
        break;
      default:
        throw new HttpError(422, "invalid_args", "action must be confirm, reject, waive, not_here, here_again or whole_project");
    }
    return jsonResponse(store.taskDetail(task.id, store.citedPathExists), 200, null);
  }

  params = matchPath(path, "/v1/tasks/:id/checks/run");
  if (params && method === "POST") {
    const body = (input.body ?? {}) as RunAcceptanceChecksRequest;
    const task = store.getTask(params.id!);
    store.afterCommit(() => {
      void engine.runPlanChecks(task.id, { cause: "user", checkIds: body.check_id ? [body.check_id] : undefined }).catch(() => undefined);
    });
    return jsonResponse(store.taskDetail(task.id, store.citedPathExists), 202, null);
  }

  params = matchPath(path, "/v1/tickets/:id");
  if (params && method === "PATCH") {
    const body = (input.body ?? {}) as PatchTicketRequest;
    const { ticket } = store.patchTicketByUser(
      params.id!,
      { title: body.title, spec: body.spec, status: body.status, worker: body.worker, dependsOn: body.depends_on, reviewerBotId: body.reviewer_bot_id,
        modelOverride: body.model_override },
      body.if_revision,
    );
    engine.renderPlanMirrors(ticket.task_id);
    store.afterCommit(() => engine.syncDerivedChecks(ticket.task_id));
    return jsonResponse(ticket, 200, null);
  }

  params = matchPath(path, "/v1/tasks/:id");
  if (params && method === "GET") {
    return jsonResponse(store.taskDetail(params.id!, store.citedPathExists), 200, null);
  }
  // Your new name for a job, or what size it is (ADR 0060): one of the two, and only yours.
  if (params && method === "PATCH") {
    const body = input.body;
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).join() : "";
    if (keys === "scale") {
      const value = (body as { scale: unknown }).scale;
      if (value !== "large" && value !== "single") throw new HttpError(422, "invalid_args", "scale is large or single");
      store.getTask(params.id!);
      store.markPlanScale({ taskId: params.id!, value, by: "user" });
      engine.renderPlanMirrors(params.id!);
      return jsonResponse(store.taskDetail(params.id!, store.citedPathExists), 200, null);
    }
    if (keys !== "title") throw new HttpError(422, "invalid_args", "a job's PATCH is {title} or {scale}");
    const task = store.renamePlanByUser(params.id!, (body as { title: unknown }).title);
    engine.renderPlanMirrors(task.id);
    return jsonResponse(store.taskDetail(task.id, store.citedPathExists), 200, null);
  }

  // Holds (叫停, ADR 0040): a stop you make from a button or a menu, and your lift of one. These
  // write the stop down, with the plans it parks and the check-backs it sets aside, and end the
  // turns it covers; a lift opens again the work the hold ended.
  if (method === "GET" && path === "/v1/holds") {
    const status = url.searchParams.get("status") ?? "active";
    if (status !== "active" && status !== "all") throw new HttpError(422, "invalid_args", "status must be active or all");
    return jsonResponse({ items: store.listHolds({ inForce: status === "active" }) }, 200, null);
  }
  if (method === "POST" && path === "/v1/holds") {
    const body = (input.body ?? {}) as Partial<CreateHoldRequest>;
    const hold = engine.createHold({
      scope: body.scope,
      scopeId: body.scope_id,
      action: body.action,
      cascade: body.cascade,
      liftOnNextUserMessage: body.lift_on_next_user_message,
      sessionId: body.session_id,
    });
    return jsonResponse(hold, 201, null);
  }
  params = matchPath(path, "/v1/holds/:id/lift");
  if (params && method === "POST") {
    return jsonResponse(engine.liftHold(params.id!), 200, null);
  }
  params = matchPath(path, "/v1/holds/:id");
  if (params && method === "GET") {
    return jsonResponse(store.getHold(params.id!), 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id/judgements");
  if (params && method === "GET") {
    return jsonResponse({ items: store.listJudgements(params.id!) }, 200, null);
  }

  params = matchPath(path, "/v1/turns/:id/mark-model");
  if (params && (method === "POST" || method === "DELETE")) {
    return jsonResponse(store.markTurnModel(params.id!, method === "POST"), 200, null);
  }

  return null;
}
