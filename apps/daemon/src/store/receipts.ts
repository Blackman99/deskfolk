import type { Database } from "bun:sqlite";
import { HttpError } from "../errors";
import { fromError } from "../http";
import type { KeyCache } from "./shared";
import type { Transactions } from "./transactions";

export type RequestScope = { deviceId: string; requestId: string; requireRevision?: boolean };
export type ReceiptResponse = { status: number; body: string | null; headers?: Record<string, string> };
export type KeyOperation = { name: string; field: string; value: string };
type ReceiptRow = {
  payload_sha256: string; state: "complete" | "pending_keys" | "expired";
  status: number; body: string | null; headers: string; key_ops: string | null;
};

export class Receipts {
  private readonly running = new Map<string, Promise<ReceiptResponse>>();

  constructor(private readonly db: Database, private readonly tx: Transactions, private readonly keys: KeyCache, private readonly recover: () => void = () => {}) {}

  lookup(scope: RequestScope): ReceiptRow | null {
    return this.db.query<ReceiptRow, [string, string]>(
      "SELECT * FROM request_receipts WHERE device_id = ? AND request_id = ?",
    ).get(scope.deviceId, scope.requestId);
  }

  read(scope: RequestScope): ReceiptResponse {
    this.recover();
    this.prune();
    const row = this.lookup(scope);
    if (!row) throw new HttpError(404, "not_found", "request receipt not found");
    if (row.state === "expired") throw new HttpError(410, "receipt_expired", "confirm the action and use a new request id");
    if (row.state === "pending_keys") return pendingKeys();
    return decode(row);
  }

  /** Bodies are bounded; key tombstones are retained until the device identity is retired. */
  prune(now = Date.now(), maxBodies = 20_000): void {
    this.db.run(`UPDATE request_receipts SET state = 'expired', body = NULL, headers = NULL, key_ops = NULL
      WHERE state = 'complete' AND (created_at < ? OR rowid IN (
        SELECT rowid FROM request_receipts WHERE state = 'complete' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      ))`, [now - 7 * 86_400_000, maxBodies]);
  }

  async execute(scope: RequestScope, digest: string, method: string, path: string,
    secrets: Record<string, unknown>, prepare: () => Promise<() => ReceiptResponse>,
    keyOps: KeyOperation[],
  ): Promise<ReceiptResponse> {
    if (!scope.deviceId || scope.deviceId.length > 200 || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(scope.requestId)) {
      throw new HttpError(422, "invalid_args", "request id must be an uppercase ULID");
    }
    const key = JSON.stringify([scope.deviceId, scope.requestId]);
    const active = this.running.get(key);
    if (active) {
      await active;
      return this.execute(scope, digest, method, path, secrets, prepare, keyOps);
    }
    const run = async (): Promise<ReceiptResponse> => {
      this.prune();
      const previous = this.lookup(scope);
      if (previous?.state === "expired") throw new HttpError(410, "receipt_expired", "confirm the action and use a new request id");
      if (previous && previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "request id has a different payload");
      if (previous?.state === "complete") return decode(previous);
      if (previous?.state === "pending_keys") {
        const ops = JSON.parse(previous.key_ops!) as Array<{ name: string; field: string }>;
        for (const op of ops) {
          const value = op.field === "" ? "" : secrets[op.field];
          if (typeof value !== "string") throw new HttpError(409, "conflict", "credential material is required to resume");
          keyOps.push({ ...op, value });
        }
        return this.finishKeys(scope, keyOps, decode(previous));
      }
      let work: () => ReceiptResponse;
      try {
        work = await prepare();
      } catch (error) {
        const response = await errorResponse(error);
        this.tx.run(() => this.save(scope, digest, method, path, response, []));
        return response;
      }
      let response: ReceiptResponse;
      try {
        response = this.tx.run(() => {
          const result = work();
          for (const op of keyOps) this.keys.markPending(op.name, op.value);
          this.save(scope, digest, method, path, result, keyOps);
          return result;
        });
      } catch (error) {
        // A post-commit filesystem failure must retain the committed receipt for recovery.
        if (this.lookup(scope)) throw error;
        response = await errorResponse(error);
        this.tx.run(() => this.save(scope, digest, method, path, response, []));
        return response;
      }
      return keyOps.length ? this.finishKeys(scope, keyOps, response) : response;
    };
    const promise = run();
    this.running.set(key, promise);
    try { return await promise; }
    finally { this.running.delete(key); }
  }

  private save(scope: RequestScope, digest: string, method: string, path: string, response: ReceiptResponse, ops: KeyOperation[]): void {
    this.db.run(`INSERT INTO request_receipts
      (device_id, request_id, payload_sha256, method, path, state, status, body, headers, key_ops, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      scope.deviceId, scope.requestId, digest, method, path, ops.length ? "pending_keys" : "complete",
      response.status, response.body, JSON.stringify(response.headers ?? {}),
      ops.length ? JSON.stringify(ops.map(({ name, field }) => ({ name, field }))) : null, Date.now(),
    ]);
  }

  private async finishKeys(scope: RequestScope, ops: KeyOperation[], response: ReceiptResponse): Promise<ReceiptResponse> {
    try {
      for (const op of ops) await this.keys.finishPending(op.name, op.value);
    } catch {
      return pendingKeys();
    }
    this.tx.run(() => {
      for (const op of ops) this.keys.clearPending(op.name);
      this.db.run("UPDATE request_receipts SET state = 'complete', key_ops = NULL WHERE device_id = ? AND request_id = ?", [scope.deviceId, scope.requestId]);
    });
    return response;
  }
}

function pendingKeys(): ReceiptResponse {
  return { status: 503, body: JSON.stringify({ error: { code: "key_write_pending", message: "credential not saved; retry the same request id" } }) };
}

function decode(row: ReceiptRow): ReceiptResponse {
  return { status: row.status, body: row.body, headers: JSON.parse(row.headers ?? "{}") };
}

export async function errorResponse(error: unknown): Promise<ReceiptResponse> {
  const response = fromError(error, null);
  return { status: response.status, body: await response.text() };
}
