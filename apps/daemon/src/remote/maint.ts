import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalApi } from "../local-api";
import { HttpError } from "../errors";
import type { RuntimeLifecycle } from "../lifecycle";
import type { Store } from "../store";
import type { DrainState } from "../quiesce";
export type RemoteReachability = {
  state: "off" | "native_unavailable" | "activation_gated" | "connecting" | "online" | "disconnected" | "trust_mismatch";
  diagnostic: string | null;
  devices: number;
};

export type RestartAvailability = "available" | "unavailable";
export type MaintenanceControl = {
  version: string;
  lifecycle: RuntimeLifecycle;
  windowAlive: () => boolean;
  requestExit: (reason: "restart" | "stop") => void;
  busy?: "restart" | "stop" | null;
};

const ERROR_CODES = new Set([
  "first_byte", "unreachable", "endpoint_error", "incomplete", "refused", "timeout",
  "draining", "cancelled", "conflict", "revision_conflict", "lifecycle_failed", "lifecycle_unknown",
  "credential_superseded", "receipt_expired", "key_write_pending", "request_unknown", "failed",
]);

export function runtimeVersion(root = join(import.meta.dir, "../../package.json")): string {
  const value = JSON.parse(readFileSync(root, "utf8")) as { version?: unknown };
  return typeof value.version === "string" ? value.version : "0.0.0";
}

export function restartAvailable(lifecycle: RuntimeLifecycle, windowAlive: () => boolean): boolean {
  if (lifecycle.isStopped()) return false;
  if (lifecycle.kind === "window") return windowAlive();
  return lifecycle.kind === "standalone";
}

function count(store: Store, sql: string): number {
  return store.db.query<{ n: number }, []>(sql).get()?.n ?? 0;
}

function grouped(store: Store, sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of store.db.query<{ k: string | null; n: number }, []>(sql).all()) {
    if (!row.k) continue;
    const key = ERROR_CODES.has(row.k) ? row.k : "other";
    out[key] = (out[key] ?? 0) + row.n;
  }
  return out;
}

function drainView(state: DrainState): { phase: DrainState["phase"]; remaining: number; forced: boolean } {
  return { phase: state.phase, remaining: state.remaining.length, forced: state.forced };
}

export function maintenanceStatus(api: LocalApi, trustDevices: Array<{ id: string; name: string; revoked: boolean; hasUv: boolean }>,
  remote: RemoteReachability, maint: MaintenanceControl) {
  return {
    version: maint.version,
    mode: maint.lifecycle.kind,
    reachability: remote.state,
    restart: restartAvailable(maint.lifecycle, maint.windowAlive) ? "available" : "unavailable" as RestartAvailability,
    stopped: maint.lifecycle.isStopped(),
    drain: drainView(api.quiesce.state()),
    devices: trustDevices,
  };
}

export function maintenanceDiagnostics(store: Store, api: LocalApi, maint: MaintenanceControl) {
  const failKinds = grouped(store, "SELECT fail_kind k, COUNT(*) n FROM turn_route_decisions WHERE fail_kind IS NOT NULL GROUP BY fail_kind");
  const turnStatus = Object.fromEntries(store.db.query<{ k: string; n: number }, []>(
    "SELECT status k, COUNT(*) n FROM turns GROUP BY status").all().map(row => [row.k, row.n]));
  const approvalStatus = Object.fromEntries(store.db.query<{ k: string; n: number }, []>(
    "SELECT status k, COUNT(*) n FROM approvals GROUP BY status").all().map(row => [row.k, row.n]));
  return {
    version: maint.version,
    mode: maint.lifecycle.kind,
    drain: drainView(api.quiesce.state()),
    counts: {
      bots: count(store, "SELECT COUNT(*) n FROM bots WHERE deleted_at IS NULL"),
      sessions: count(store, "SELECT COUNT(*) n FROM sessions"),
      messages: count(store, "SELECT COUNT(*) n FROM messages"),
      turns: count(store, "SELECT COUNT(*) n FROM turns"),
      live_turns: store.listLiveTurns().length,
      skills: count(store, "SELECT COUNT(*) n FROM skills"),
      memories: count(store, "SELECT COUNT(*) n FROM memories"),
      routines: count(store, "SELECT COUNT(*) n FROM routines"),
      providers: count(store, "SELECT COUNT(*) n FROM providers"),
      mcp_servers: count(store, "SELECT COUNT(*) n FROM mcp_servers"),
      devices: count(store, "SELECT COUNT(*) n FROM remote_devices"),
      devices_revoked: count(store, "SELECT COUNT(*) n FROM remote_devices WHERE revoked = 1"),
      receipts: count(store, "SELECT COUNT(*) n FROM request_receipts"),
    },
    turns: turnStatus,
    approvals: approvalStatus,
    errors: failKinds,
  };
}

function finalize(store: Store, scope: { deviceId: string; requestId: string }, status: number, body: string | null): Response {
  store.transaction(() => {
    store.db.run("UPDATE request_receipts SET status = ?, body = ? WHERE device_id = ? AND request_id = ?",
      [status, body, scope.deviceId, scope.requestId]);
    store.db.run("DELETE FROM remote_lifecycle WHERE device_id = ? AND request_id = ?", [scope.deviceId, scope.requestId]);
  });
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function failedBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

/** Caller owns exit. Drain never writes the latch or exits. */
export async function finishRestart(store: Store, api: LocalApi, maint: MaintenanceControl,
  scope: { deviceId: string; requestId: string }, force: boolean, signal?: AbortSignal): Promise<Response> {
  let status = 200;
  let body: string | null = JSON.stringify({ ok: true, action: "runtime.restart", forced: force, latch: false });
  try {
    if (maint.busy && maint.busy !== "restart") throw new HttpError(409, "draining", "runtime is draining; new turns are paused");
    maint.busy = "restart";
    if (!restartAvailable(maint.lifecycle, maint.windowAlive)) {
      throw new HttpError(409, "restart_unavailable", "restart needs a live window supervisor");
    }
    if (force) api.quiesce.force();
    const state = await api.quiesce.wait(signal);
    if (state.phase !== "drained") throw new HttpError(409, "cancelled", "drain wait cancelled");
    if (force && !state.forced) throw new HttpError(409, "cancelled", "force cancelled");
  } catch (error) {
    if (error instanceof HttpError && error.code === "draining") {
      status = 409; body = failedBody("draining", error.message);
    } else {
      maint.busy = null;
      if (error instanceof HttpError && error.code === "cancelled") {
        status = 409; body = failedBody("cancelled", "drain wait cancelled");
      } else if (error instanceof HttpError && error.code === "restart_unavailable") {
        status = 409; body = failedBody("restart_unavailable", error.message);
      } else {
        status = 503; body = failedBody("lifecycle_failed", "lifecycle effect failed");
      }
    }
  }
  const response = finalize(store, scope, status, body);
  if (status === 200) queueMicrotask(() => maint.requestExit("restart"));
  return response;
}

export async function finishStop(store: Store, maint: MaintenanceControl,
  scope: { deviceId: string; requestId: string }): Promise<Response> {
  let status = 200;
  let body: string | null = JSON.stringify({ ok: true, action: "runtime.stop", latch: true });
  try {
    if (maint.busy && maint.busy !== "stop") throw new HttpError(409, "draining", "runtime is draining; new turns are paused");
    maint.busy = "stop";
    await maint.lifecycle.writeStopLatch();
  } catch (error) {
    if (error instanceof HttpError && error.code === "draining") {
      status = 409; body = failedBody("draining", error.message);
    } else {
      maint.busy = null;
      status = 503; body = failedBody("lifecycle_failed", "lifecycle effect failed");
    }
  }
  const response = finalize(store, scope, status, body);
  if (status === 200) queueMicrotask(() => maint.requestExit("stop"));
  return response;
}
