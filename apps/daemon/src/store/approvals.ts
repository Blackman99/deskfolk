import { modeAllowing, permissionClassOf, permissionVerdict, type Approval, type ResolveApprovalAction } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import {
  createNotification,
  markNotificationRead,
  updateNotificationActionState,
} from "./notifications";
import { permissionModeFor } from "./permissions";
import {
  toApproval,
  type ApprovalRow,
  type StoreContext,
} from "./shared";

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
  const turn = ctx.db
    .query<{ session_id: string }, [string]>("SELECT session_id FROM turns WHERE id = ?")
    .get(input.turnId);
  createNotification(ctx, {
    semantic_key: `approval:${row.id}`,
    kind: "approval",
    session_id: turn?.session_id ?? null,
    message_id: row.message_id,
    turn_id: row.turn_id,
    approval_id: row.id,
    created_at: now,
    action_state: "open",
  });
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

export function resolveApproval(ctx: StoreContext, id: string, action: ResolveApprovalAction) {
  return ctx.tx.run(() => {
    const row = ctx.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "approval not found");
    if (row.status !== "pending") {
      throw new HttpError(409, "conflict", "approval is no longer pending");
    }
    // Allowed from now on (ADR 0092): its Bot moves to the mode in which this kind no longer asks,
    // unless you already moved it to one meanwhile.
    if (action === "allow_from_now") {
      const botId = ctx.db
        .query<{ bot_id: string }, [string]>("SELECT bot_id FROM turns WHERE id = ?")
        .get(row.turn_id)?.bot_id;
      if (botId && permissionVerdict(permissionModeFor(ctx, botId), permissionClassOf(row.kind_key)) !== "allow") {
        ctx.db.run(`UPDATE bots SET permission_mode = ?, updated_at = ? WHERE id = ?`, [modeAllowing(row.kind_key), isoNow(), botId]);
      }
    }
    const now = isoNow();
    const status = action === "deny" ? "denied" : "allowed_once";
    ctx.db.run(`UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?`, [status, now, id]);
    updateNotificationActionState(
      ctx,
      `approval:${id}`,
      "resolved",
      action === "deny" ? "denied" : "resolved",
      true,
    );
    const next = ctx.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id)!;
    return toApproval(next);
  });
}
