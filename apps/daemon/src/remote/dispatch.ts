import { fromBase64url, requestDigest, type RemoteRequest, type AssertionWire, type RegistrationWire,
  type AssertionResponse, type RegistrationResponse } from "@real-bot/remote";
import type { LocalApi } from "../local-api";
import type { AttachmentInput } from "../store";
import { HttpError } from "../errors";
import { RemoteTrust, deny } from "./trust";
import { RemoteUv, type RemotePrincipal } from "./uv";
import { validateBusiness } from "./routes";
import { finishLifecycle } from "./lifecycle";
import { finishRestart, finishStop, maintenanceDiagnostics, maintenanceStatus, type MaintenanceControl, type RemoteReachability } from "./maint";
import type { PushService } from "./push";

export function assertionFromWire(value: AssertionWire): AssertionResponse {
  if (!value || Object.keys(value).sort().join() !== "authenticatorData,clientDataJSON,credentialId,signature" ||
    !Object.values(value).every(v => typeof v === "string" && v.length <= 24_000)) deny();
  return { credentialId: value.credentialId, clientDataJSON: fromBase64url(value.clientDataJSON),
    authenticatorData: fromBase64url(value.authenticatorData), signature: fromBase64url(value.signature) };
}
export function registrationFromWire(value: RegistrationWire): RegistrationResponse {
  if (!value || Object.keys(value).sort().join() !== "attestationObject,clientDataJSON,credentialId" ||
    !Object.values(value).every(v => typeof v === "string" && v.length <= 24_000)) deny();
  return { credentialId: value.credentialId, clientDataJSON: fromBase64url(value.clientDataJSON), attestationObject: fromBase64url(value.attestationObject) };
}
export type PrivilegedOperation = {
  action: "device.revoke" | "quiesce.begin" | "quiesce.cancel" | "quiesce.force" | "runtime.restart" | "runtime.stop" | "diagnostics.download";
  targetId: string; requestId: string;
};
function operation(value: unknown): PrivilegedOperation {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "action,requestId,targetId") deny();
  const op = value as PrivilegedOperation;
  if (!["device.revoke", "quiesce.begin", "quiesce.cancel", "quiesce.force", "runtime.restart", "runtime.stop", "diagnostics.download"].includes(op.action) ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(op.requestId) || typeof op.targetId !== "string") deny();
  if (op.action === "device.revoke" ? !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(op.targetId) : op.targetId !== "runtime") deny();
  return op;
}
function actionPath(action: PrivilegedOperation["action"]): string {
  if (action === "runtime.restart") return "/remote/runtime/restart";
  if (action === "runtime.stop") return "/remote/runtime/stop";
  return "/remote/action";
}
function operationDigest(op: PrivilegedOperation, extra?: Record<string, unknown>): string {
  return requestDigest({ method: "POST", path: actionPath(op.action), body: extra ? { ...op, ...extra } : op, encoding: "json" });
}
function restartBody(value: unknown): { force: boolean } {
  const body = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(body).some(k => k !== "force") || (body.force !== undefined && typeof body.force !== "boolean")) deny();
  return { force: body.force === true };
}

export class RemoteDispatcher {
  readonly uv: RemoteUv;
  constructor(readonly api: LocalApi, readonly trust: RemoteTrust,
    readonly maint: MaintenanceControl | null = null,
    private readonly remoteStatus: () => RemoteReachability = () => ({ state: "off", diagnostic: null, devices: 0 }),
    readonly push?: PushService) {
    this.uv = new RemoteUv(trust);
  }
  async dispatch(request: RemoteRequest, principal: RemotePrincipal, files?: AttachmentInput[]): Promise<Response> {
    const abort = new AbortController();
    const invalidate = this.trust.onInvalidate(() => abort.abort());
    const signal = principal.signal ? AbortSignal.any([principal.signal, abort.signal]) : abort.signal;
    const bound = { ...principal, signal, active: () => !signal.aborted && principal.active() };
    try { return await this.dispatchCurrent(request, bound, files); }
    finally { invalidate(); }
  }
  private async dispatchCurrent(request: RemoteRequest, principal: RemotePrincipal, files?: AttachmentInput[]): Promise<Response> {
    this.uv.assert(principal);
    if (request.path.startsWith("/remote/")) return this.control(request, principal);
    if (request.path === "/v1/settings" && request.method !== "GET" && Object.hasOwn(request.body ?? {}, "workspace_path")) deny();
    if (files?.length) {
      if (request.method !== "POST" || !/^\/v1\/sessions\/[0-9A-HJKMNP-TV-Z]{26}\/messages$/.test(request.path)) deny();
    }
    validateBusiness(request);
    const url = new URL(request.path, "http://remote.invalid");
    for (const [key, value] of Object.entries(request.query ?? {}).sort(([a], [b]) => a.localeCompare(b))) url.searchParams.set(key, value);
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-Request-Id": request.id, ...(request.ifMatch ? { "If-Match": request.ifMatch } : {}) };
    const http = new Request(url.toString(), {
      method: request.method, signal: principal.signal, headers,
      body: request.method === "GET" ? undefined : JSON.stringify(request.body ?? {}),
    });
    if (files?.length) Object.defineProperty(http, "stagedFiles", { value: files, enumerable: false });
    const response = await this.api.dispatchBusiness(http, { deviceId: principal.device.device_id, requestId: request.id, requireRevision: true, guard: () => this.uv.assert(principal) });
    this.uv.assert(principal);
    return response;
  }
  private async control(request: RemoteRequest, principal: RemotePrincipal): Promise<Response> {
    const body = request.body ?? {};
    const json = (value: unknown) => Response.json(value);
    if (request.method === "GET" && ["/remote/status", "/remote/devices", "/remote/diagnostics", "/remote/push"].includes(request.path)) {
      if (request.query || request.body || request.ifMatch) deny();
      if (request.path === "/remote/push") {
        if (!this.push) throw new HttpError(503, "failed", "push unavailable");
        return json(await this.push.publicState(principal.device.device_id));
      }
      const devices = this.trust.devices().map(d => ({
        id: d.device_id,
        name: d.name,
        revoked: !!d.revoked,
        hasUv: !!d.credential_id,
        lastActiveAt: d.last_active_at || null,
      }));
      if (request.path === "/remote/devices") return json({ items: devices });
      if (!this.maint) {
        if (request.path === "/remote/diagnostics") throw new HttpError(409, "restart_unavailable", "maintenance is unavailable");
        return json({ drain: this.api.quiesce.state(), devices });
      }
      if (request.path === "/remote/diagnostics") return json(maintenanceDiagnostics(this.trust.store, this.api, this.maint));
      return json(maintenanceStatus(this.api, devices, this.remoteStatus(), this.maint));
    }
    if (request.method !== "POST" || request.query || request.ifMatch) deny();
    if (request.path === "/remote/push/subscribe" || request.path === "/remote/push/unsubscribe" || request.path === "/remote/push/test") {
      if (!this.push) throw new HttpError(503, "failed", "push unavailable");
      if (request.path === "/remote/push/test") {
        if (body && Object.keys(body).length > 0) deny();
        const result = await this.push.test(principal.device.device_id);
        return json(result);
      }
      if (request.path.endsWith("/unsubscribe")) {
        if (body && Object.keys(body).some(k => k !== "if_device_revision")) deny();
      }
      const digest = requestDigest({ method: "POST", path: request.path, body, encoding: "json" });
      const scope = { deviceId: principal.device.device_id, requestId: request.id };
      const previous = this.trust.store.receipts.lookup(scope);
      if (previous) {
        if (previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "push request changed");
        const receipt = this.trust.store.receipts.read(scope);
        return new Response(receipt.body, { status: receipt.status, headers: { "Content-Type": "application/json", ...receipt.headers } });
      }
      if (request.path.endsWith("/subscribe")) {
        await this.push.vapidFingerprint();
      }
      this.trust.store.transaction(() => {
        if (request.path.endsWith("/unsubscribe")) this.push!.unsubscribe(scope.deviceId, body);
        else this.push!.subscribe(scope.deviceId, body);
        this.trust.store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
          VALUES (?, ?, ?, 'POST', ?, 'complete', 204, NULL, '{}', ?)`,
        [scope.deviceId, scope.requestId, digest, request.path, Date.now()]);
      });
      return new Response(null, { status: 204 });
    }
    if (request.path === "/remote/uv/register-challenge") {
      if (Object.keys(body).length) deny();
      return json(this.uv.registrationChallenge(principal, request.id));
    }
    if (request.path === "/remote/uv/replacement-challenge") {
      if (Object.keys(body).sort().join() !== "challenge,response" || typeof body.challenge !== "string") deny();
      return json(this.uv.replacementChallenge(principal, String(body.challenge), registrationFromWire(body.response as RegistrationWire)));
    }
    if (request.path === "/remote/uv/register") {
      if (typeof body.challenge !== "string" || !body.response || !Object.keys(body).every(k => ["challenge", "response", "replacement"].includes(k))) deny();
      if (body.replacement && (typeof body.replacement !== "object" || Object.keys(body.replacement).sort().join() !== "assertion,challenge" ||
        typeof (body.replacement as { challenge?: unknown }).challenge !== "string")) deny();
      const digest = requestDigest({ method: "POST", path: request.path, body, encoding: "json" });
      const scope = { deviceId: principal.device.device_id, requestId: request.id };
      const previous = this.trust.store.receipts.lookup(scope);
      if (previous) {
        if (previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "registration request changed");
        const receipt = this.trust.store.receipts.read(scope);
        return new Response(receipt.body, { status: receipt.status, headers: { "Content-Type": "application/json", ...receipt.headers } });
      }
      const replacement = body.replacement as { challenge: string; assertion: AssertionWire } | undefined;
      await this.uv.register(principal, String(body.challenge), registrationFromWire(body.response as RegistrationWire), replacement
        ? { challenge: replacement.challenge, assertion: assertionFromWire(replacement.assertion) } : undefined, () => {
          this.trust.store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
            VALUES (?, ?, ?, 'POST', '/remote/uv/register', 'complete', 204, NULL, '{}', ?)`,
          [scope.deviceId, scope.requestId, digest, Date.now()]);
        });
      return new Response(null, { status: 204 });
    }
    if (request.path === "/remote/uv/challenge") {
      if (Object.keys(body).join() !== "operation" && Object.keys(body).sort().join() !== "force,operation") deny();
      const op = operation(body.operation);
      const extra = op.action === "runtime.restart" ? restartBody({ force: body.force }) : undefined;
      if (extra === undefined && body.force !== undefined) deny();
      return json(this.uv.issue(principal, op.requestId, op.action, op.targetId, operationDigest(op, extra)));
    }
    if (request.path === "/remote/runtime/restart" || request.path === "/remote/runtime/stop") {
      return this.runtimeAction(request, principal, request.path === "/remote/runtime/stop" ? "runtime.stop" : "runtime.restart");
    }
    if (request.path === "/remote/action") {
      if (Object.keys(body).sort().join() !== "assertion,challenge,operation" || typeof body.challenge !== "string") deny();
      const op = operation(body.operation);
      if (op.requestId !== request.id || op.action === "runtime.restart" || op.action === "runtime.stop") deny();
      if (op.action === "diagnostics.download" && !this.maint) throw new HttpError(409, "restart_unavailable", "maintenance is unavailable");
      const scope = { deviceId: principal.device.device_id, requestId: op.requestId }, digest = operationDigest(op);
      const previous = this.trust.store.receipts.lookup(scope);
      if (previous) {
        if (previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "request id has a different action");
        const saved = this.trust.store.receipts.read(scope);
        return new Response(saved.body, { status: saved.status, headers: { "Content-Type": "application/json", ...saved.headers } });
      }
      const report = op.action === "diagnostics.download" ? JSON.stringify(maintenanceDiagnostics(this.trust.store, this.api, this.maint!)) : null;
      await this.uv.assertion(principal, String(body.challenge), { deviceId: principal.device.device_id, sessionId: principal.sessionId,
        trustEpoch: principal.device.grant_epoch, requestId: request.id, action: op.action, targetId: op.targetId, operationDigest: digest },
      assertionFromWire(body.assertion as AssertionWire), () => {
        if (op.action !== "device.revoke" && op.action !== "diagnostics.download") this.trust.store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, ?)",
          [scope.deviceId, scope.requestId, op.action]);
        if (op.action === "device.revoke") {
          if (!this.trust.device(op.targetId)) deny();
          this.trust.store.db.run("INSERT INTO remote_revocations VALUES (?, ?, ?, ?)",
            [request.id, principal.device.device_id, op.targetId, this.trust.assertHost().generation]);
        }
        this.trust.store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
          VALUES (?, ?, ?, 'POST', '/remote/action', 'complete', ?, ?, '{}', ?)`,
        [scope.deviceId, scope.requestId, digest, op.action === "diagnostics.download" ? 200 : 202,
          op.action === "diagnostics.download" ? report : JSON.stringify({ state: op.action === "device.revoke" ? "revocation_pending" : "lifecycle_pending" }), Date.now()]);
      });
      if (op.action === "device.revoke") {
        await this.trust.revoke(op.targetId, () => this.uv.assert(principal));
        return new Response(null, { status: 204 });
      }
      if (op.action === "diagnostics.download") {
        return new Response(report, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return finishLifecycle(this.trust.store, this.api, scope, op.action);
    }
    throw new HttpError(404, "not_found", "unknown remote route");
  }
  private async runtimeAction(request: RemoteRequest, principal: RemotePrincipal, action: "runtime.restart" | "runtime.stop"): Promise<Response> {
    const body = request.body ?? {};
    if (Object.keys(body).sort().join() !== "assertion,challenge,operation" &&
      Object.keys(body).sort().join() !== "assertion,challenge,force,operation") deny();
    const op = operation(body.operation);
    if (op.action !== action || op.requestId !== request.id || typeof body.challenge !== "string") deny();
    const extra = action === "runtime.restart" ? restartBody({ force: body.force }) : undefined;
    if (action === "runtime.stop" && body.force !== undefined) deny();
    if (!this.maint) throw new HttpError(409, "restart_unavailable", "maintenance is unavailable");
    const force = extra?.force === true;
    const scope = { deviceId: principal.device.device_id, requestId: op.requestId };
    const digest = operationDigest(op, extra);
    const previous = this.trust.store.receipts.lookup(scope);
    if (previous) {
      if (previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "request id has a different action");
      const saved = this.trust.store.receipts.read(scope);
      return new Response(saved.body, { status: saved.status, headers: { "Content-Type": "application/json", ...saved.headers } });
    }
    if (this.maint.busy) throw new HttpError(409, "draining", "runtime is draining; new turns are paused");
    await this.uv.assertion(principal, String(body.challenge), { deviceId: principal.device.device_id, sessionId: principal.sessionId,
      trustEpoch: principal.device.grant_epoch, requestId: request.id, action: op.action, targetId: op.targetId, operationDigest: digest },
    assertionFromWire(body.assertion as AssertionWire), () => {
      this.maint!.busy = action === "runtime.stop" ? "stop" : "restart";
      this.trust.store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, ?)", [scope.deviceId, scope.requestId, op.action]);
      this.trust.store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
        VALUES (?, ?, ?, 'POST', ?, 'complete', 202, ?, '{}', ?)`,
      [scope.deviceId, scope.requestId, digest, request.path, JSON.stringify({ state: "lifecycle_pending" }), Date.now()]);
    });
    if (action === "runtime.stop") return finishStop(this.trust.store, this.maint, scope);
    return finishRestart(this.trust.store, this.api, this.maint, scope, force, principal.signal);
  }
}
