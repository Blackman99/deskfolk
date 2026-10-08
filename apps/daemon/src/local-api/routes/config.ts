import type { CreateRoutineRequest, PatchRoutineRequest } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { emptyResponse, jsonResponse, matchPath } from "../../http";
import { occurred, spendFilterFrom } from "../helpers";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: approvals, allow rules, MCP servers, skills, memories, routines, spend and search. */
export function configRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { url, publish, engine, input, store, method, path } = ctx;
  let params: ReturnType<typeof matchPath>;

  if (method === "GET" && path === "/v1/approvals") {
    return jsonResponse({ items: store.listApprovals(url.searchParams.get("status") ?? undefined) }, 200, null);
  }
  params = matchPath(path, "/v1/approvals/:id/resolve");
  if (params && method === "POST") {
    const body = (input.body) as { action?: string; scope?: string; api_key?: string };
    if (
      body.action !== "allow_once" &&
      body.action !== "deny" &&
      body.action !== "always_allow"
    ) {
      throw new HttpError(422, "invalid_args", "action must be allow_once, deny, or always_allow");
    }
    if (body.api_key !== undefined && typeof body.api_key !== "string") {
      throw new HttpError(422, "invalid_args", "api_key must be a string");
    }
    return jsonResponse(
      engine.resolveApproval(params.id!, body.action, body.scope, body.api_key),
      200,
      null,
    );
  }

  if (method === "GET" && path === "/v1/allow-rules") {
    return jsonResponse({ items: store.listAllowRules() }, 200, null);
  }
  if (method === "POST" && path === "/v1/allow-rules") {
    const body = (input.body) as { kind_key?: string; scope?: string };
    if (!body.kind_key || !body.scope) {
      throw new HttpError(422, "invalid_args", "kind_key and scope are required");
    }
    const rule = store.createAllowRule(body.kind_key, body.scope);
    publish({ event: "allow_rule.upsert", occurred_at: occurred(), ...rule });
    return jsonResponse(rule, 201, null);
  }
  params = matchPath(path, "/v1/allow-rules/:id");
  if (params && method === "DELETE") {
    store.deleteAllowRule(params.id!);
    publish({ event: "allow_rule.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/mcp-servers") {
    return store.listMcpServersHydrated().then((items) => jsonResponse({ items }, 200, null));
  }
  if (method === "POST" && path === "/v1/mcp-servers") {
    const body = (input.body) as {
      name: string;
      transport?: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Array<{ name: string; value: string }>;
      auth?: string;
      enabled?: boolean;
      usage_note?: string | null;
    };
    const server = store.createMcpServerSync(body);
    return jsonResponse(server, 201, null);
  }
  params = matchPath(path, "/v1/mcp-servers/:id");
  if (params && method === "PATCH") {
    const body = (input.body) as {
      name?: string;
      transport?: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Array<{ name: string; value: string }>;
      auth?: string;
      enabled?: boolean;
      usage_note?: string | null;
    };
    const server = store.patchMcpServerSync(params.id!, body);
    return jsonResponse(server, 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteMcpServerSync(params.id!);
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/skills") {
    return jsonResponse({ items: store.listSkills() }, 200, null);
  }
  if (method === "POST" && path === "/v1/skills") {
    const body = (input.body) as {
      bot_id: string;
      name: string;
      description: string;
      body: string;
      uses?: string[];
      enabled?: boolean;
    };
    const skill = store.createSkill(body);
    publish({ event: "skill.upsert", occurred_at: occurred(), ...skill });
    return jsonResponse(skill, 201, null);
  }
  params = matchPath(path, "/v1/skills/:id");
  if (params && method === "PATCH") {
    const body = (input.body) as {
      name?: string;
      description?: string;
      body?: string;
      uses?: string[];
      enabled?: boolean;
    };
    const skill = store.patchSkill(params.id!, body);
    publish({ event: "skill.upsert", occurred_at: occurred(), ...skill });
    return jsonResponse(skill, 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteSkill(params.id!);
    publish({ event: "skill.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  // Memories have no POST: the Bot writes them, you correct them.
  if (method === "GET" && path === "/v1/memories") {
    return jsonResponse({ items: store.listMemories() }, 200, null);
  }
  params = matchPath(path, "/v1/memories/:id");
  if (params && method === "PATCH") {
    const body = (input.body) as { subject?: string; body?: string; enabled?: boolean };
    const memory = store.patchMemory(params.id!, body);
    publish({ event: "memory.upsert", occurred_at: occurred(), ...memory });
    return jsonResponse(memory, 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteMemory(params.id!);
    publish({ event: "memory.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/routines") {
    return jsonResponse({ items: store.listRoutines() }, 200, null);
  }
  if (method === "POST" && path === "/v1/routines") {
    const body = input.body as CreateRoutineRequest;
    const routine = store.createRoutine(body);
    publish({ event: "routine.upsert", occurred_at: occurred(), ...routine });
    engine.fireRoutine(routine.id);
    return jsonResponse(store.getRoutine(routine.id), 201, null);
  }
  params = matchPath(path, "/v1/routines/:id");
  if (params && method === "PATCH") {
    const body = input.body as PatchRoutineRequest;
    const routine = store.patchRoutine(params.id!, body);
    publish({ event: "routine.upsert", occurred_at: occurred(), ...routine });
    engine.fireRoutine(routine.id);
    return jsonResponse(store.getRoutine(routine.id), 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteRoutine(params.id!, input.body.if_revision as string | undefined);
    publish({ event: "routine.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && (path === "/v1/spend" || path === "/v1/spend/summary")) {
    const filter = spendFilterFrom(url);
    if (path === "/v1/spend/summary") {
      const groupBy = url.searchParams.get("group_by");
      const tz = url.searchParams.get("tz");
      return jsonResponse(
        store.spendSummary({
          ...filter,
          ...(groupBy ? { group_by: groupBy as "model" | "session" | "bot" | "kind" | "day" } : {}),
          ...(tz ? { tz } : {}),
        }),
        200,
        null,
      );
    }
    const limitText = url.searchParams.get("limit");
    const limit = limitText ? Number(limitText) : undefined;
    if (limitText && (!Number.isInteger(limit) || limit! < 1 || limit! > 200)) {
      throw new HttpError(422, "invalid_args", "limit must be an integer between 1 and 200");
    }
    return jsonResponse(
      store.spendPage({ ...filter, ...(limit ? { limit } : {}), cursor: url.searchParams.get("cursor") }),
      200,
      null,
    );
  }

  if (method === "GET" && path === "/v1/search") {
    const q = url.searchParams.get("q") ?? "";
    return jsonResponse({ items: store.search(q) }, 200, null);
  }

  return null;
}
