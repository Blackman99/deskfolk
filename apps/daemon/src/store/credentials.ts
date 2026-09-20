import { HttpError } from "../errors";
import { planKey, type StoreContext } from "./shared";

type PendingKey = { name: string; operation_id: string; device_id: string | null; request_id: string | null };

export function listCredentialOperations(ctx: StoreContext) {
  return ctx.db.query<PendingKey, []>("SELECT name, operation_id, device_id, request_id FROM pending_keys").all().map((row) => {
    const match = /^(endpoint-api-key|mcp-auth):(.+)$/.exec(row.name);
    if (!match) throw new Error("unsupported pending credential namespace");
    return { id: row.operation_id, kind: match[1] === "mcp-auth" ? "mcp" : "provider", entity_id: match[2]!, request_id: row.request_id };
  });
}

/** Explicit repair replaces only credential work, never the approved tool or committed configuration. */
export function resolveCredentialOperation(ctx: StoreContext, id: string, input: { action?: unknown; value?: unknown }): void {
  if (input.action !== "repair" && input.action !== "cancel") throw new HttpError(422, "invalid_args", "action must be repair or cancel");
  if (input.action === "repair" && (typeof input.value !== "string" || !input.value.length)) throw new HttpError(422, "invalid_args", "credential value is required");
  const row = ctx.db.query<PendingKey, [string]>("SELECT * FROM pending_keys WHERE operation_id = ?").get(id);
  if (!row) throw new HttpError(404, "not_found", "credential operation not found");
  if (!/^(endpoint-api-key|mcp-auth):[0-9A-HJKMNP-TV-Z]{26}$/.test(row.name)) throw new HttpError(422, "invalid_args", "unsupported credential namespace");
  if (ctx.keys.isWriting(row.name)) throw new HttpError(409, "conflict", "credential write is in progress");
  if (row.device_id && row.request_id) {
    ctx.db.run(`UPDATE request_receipts SET state = 'complete', status = 409, body = ?, key_ops = NULL
      WHERE device_id = ? AND request_id = ? AND state = 'pending_keys'`, [
      JSON.stringify({ error: { code: "credential_superseded", message: "credential operation was explicitly repaired or cancelled" } }), row.device_id, row.request_id,
    ]);
  }
  ctx.keys.clearPending(row.name);
  planKey(ctx, row.name, input.action === "cancel" ? "" : input.value as string);
}
