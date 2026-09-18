import type { Approval } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import {
  ALLOWED_KIND_KEYS,
  requireNonEmpty,
  toApproval,
  type ApprovalRow,
  type StoreContext,
} from "./shared";

export function listAllowRules(ctx: StoreContext) {
  return ctx.db
    .query<{ id: string; kind_key: string; scope: string; created_at: string }, []>(
      `SELECT * FROM allow_rules ORDER BY created_at ASC`,
    )
    .all();
}

export function createAllowRule(ctx: StoreContext, kind_key: string, scope: string) {
  if (!ALLOWED_KIND_KEYS.has(kind_key)) {
    throw new HttpError(422, "invalid_args", "this kind cannot be Always allow");
  }
  const nextScope = requireNonEmpty("scope", scope);
  if (kind_key === "unconstrained-shell" && nextScope !== "*") {
    throw new HttpError(422, "invalid_args", "unconstrained-shell scope must be *");
  }
  const existing = ctx.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM allow_rules WHERE kind_key = ? AND scope = ?`,
    )
    .get(kind_key, nextScope);
  if (existing) {
    return ctx.db
      .query<{ id: string; kind_key: string; scope: string; created_at: string }, [string]>(
        `SELECT * FROM allow_rules WHERE id = ?`,
      )
      .get(existing.id)!;
  }
  const row = {
    id: ulid(),
    kind_key,
    scope: nextScope,
    created_at: isoNow(),
  };
  ctx.db.run(`INSERT INTO allow_rules (id, kind_key, scope, created_at) VALUES (?, ?, ?, ?)`, [
    row.id,
    row.kind_key,
    row.scope,
    row.created_at,
  ]);
  return row;
}

export function deleteAllowRule(ctx: StoreContext, id: string): void {
  const changes = ctx.db.run(`DELETE FROM allow_rules WHERE id = ?`, [id]).changes;
  if (changes === 0) throw new HttpError(404, "not_found", "allow rule not found");
}

export function matchesAllowRule(ctx: StoreContext, kind_key: string, target: string): boolean {
  const rules = listAllowRules(ctx);
  for (const rule of rules) {
    if (rule.kind_key !== kind_key) continue;
    if (rule.scope === "*") return true;
    if (kind_key === "unconstrained-shell") continue;
    if (target === rule.scope || target.startsWith(rule.scope.endsWith("/") ? rule.scope : `${rule.scope}/`)) {
      return true;
    }
  }
  return false;
}

export function insertApproval(
  ctx: StoreContext,
  input: {
    turnId: string;
    messageId: string | null;
    kind_key: string;
    summary: string;
    target: string;
    requires_api_key?: boolean;
  },
): Approval {
  const now = isoNow();
  const row: Approval = {
    id: ulid(),
    turn_id: input.turnId,
    message_id: input.messageId,
    status: "pending",
    kind_key: input.kind_key,
    summary: input.summary,
    target: input.target,
    created_at: now,
    resolved_at: null,
    requires_api_key: Boolean(input.requires_api_key),
  };
  ctx.db.run(
    `INSERT INTO approvals (id, turn_id, message_id, status, kind_key, summary, target, created_at, resolved_at, requires_api_key)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?)`,
    [
      row.id,
      row.turn_id,
      row.message_id,
      row.kind_key,
      row.summary,
      row.target,
      row.created_at,
      row.requires_api_key ? 1 : 0,
    ],
  );
  return row;
}

export function getApproval(ctx: StoreContext, id: string): Approval {
  const row = ctx.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "approval not found");
  return toApproval(row);
}

export function listApprovals(ctx: StoreContext, status?: string) {
  if (status && status !== "pending") {
    throw new HttpError(422, "invalid_args", "status must be pending when set");
  }
  const sql = status
    ? `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`
    : `SELECT * FROM approvals ORDER BY created_at ASC`;
  return ctx.db.query<ApprovalRow, []>(sql).all().map(toApproval);
}

export function resolveApproval(
  ctx: StoreContext,
  id: string,
  action: "allow_once" | "deny" | "always_allow",
  scope?: string,
) {
  const row = ctx.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "approval not found");
  if (row.status !== "pending") {
    throw new HttpError(409, "conflict", "approval is no longer pending");
  }
  if (action === "always_allow") {
    if (!row.kind_key || !ALLOWED_KIND_KEYS.has(row.kind_key)) {
      throw new HttpError(422, "invalid_args", "this kind cannot be Always allow");
    }
    const nextScope =
      row.kind_key === "unconstrained-shell" ? "*" : (scope ?? row.target ?? "*");
    if (row.kind_key === "unconstrained-shell" && scope && scope !== "*") {
      throw new HttpError(422, "invalid_args", "unconstrained-shell scope must be *");
    }
    createAllowRule(ctx, row.kind_key, nextScope);
  }
  const now = isoNow();
  const status = action === "deny" ? "denied" : "allowed_once";
  ctx.db.run(`UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?`, [status, now, id]);
  const next = ctx.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id)!;
  return toApproval(next);
}
