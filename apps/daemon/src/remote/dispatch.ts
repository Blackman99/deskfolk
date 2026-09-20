import { canonicalHash, fromBase64url, requestDigest, type RemoteRequest, type AssertionWire, type RegistrationWire,
  type AssertionResponse, type RegistrationResponse } from "@real-bot/remote";
import type { LocalApi } from "../local-api";
import { HttpError } from "../errors";
import { RemoteTrust, deny } from "./trust";
import { RemoteUv, type RemotePrincipal } from "./uv";

const routes: Array<[string, RegExp]> = [
  ["GET", /^\/v1\/(snapshot|settings|providers|bots|sessions|approvals|allow-rules|mcp-servers|skills|memories|routines|spend|search|credential-operations)$/],
  ["GET", /^\/v1\/(events\/catchup|workspace\/(tree|file))$/],
  ["GET", /^\/v1\/(providers|bots|sessions|attachments|requests)\/[0-9A-HJKMNP-TV-Z]{26}$/],
  ["GET", /^\/v1\/sessions\/[0-9A-HJKMNP-TV-Z]{26}\/(snapshot|messages|judgements|routes|composer-suggestions)$/],
  ["GET", /^\/v1\/bots\/[0-9A-HJKMNP-TV-Z]{26}\/profile-revisions$/],
  ["GET", /^\/v1\/attachments\/[0-9A-HJKMNP-TV-Z]{26}\/content$/],
  ["POST", /^\/v1\/(bots|sessions|providers|mcp-servers|skills|routines|allow-rules|turns\/(stop|continue))$/],
  ["POST", /^\/v1\/sessions\/[0-9A-HJKMNP-TV-Z]{26}\/(messages|members|read|archive|restore|clear)$/],
  ["POST", /^\/v1\/bots\/[0-9A-HJKMNP-TV-Z]{26}\/(archive|restore)$/],
  ["POST", /^\/v1\/(approvals|credential-operations)\/[0-9A-HJKMNP-TV-Z]{26}\/resolve$/],
  ["PATCH", /^\/v1\/settings$/],
  ["PATCH", /^\/v1\/(bots|sessions|providers|mcp-servers|skills|memories|routines)\/[0-9A-HJKMNP-TV-Z]{26}$/],
  ["DELETE", /^\/v1\/(bots|sessions|providers|mcp-servers|skills|memories|routines|allow-rules)\/[0-9A-HJKMNP-TV-Z]{26}$/],
  ["DELETE", /^\/v1\/sessions\/[0-9A-HJKMNP-TV-Z]{26}\/(members|messages)$/],
  ["PUT", /^\/v1\/workspace\/file$/],
  ["PUT", /^\/v1\/messages\/[0-9A-HJKMNP-TV-Z]{26}\/reactions$/],
  ["DELETE", /^\/v1\/messages\/[0-9A-HJKMNP-TV-Z]{26}\/reactions$/],
];
export function businessAllowed(request: RemoteRequest): boolean {
  return routes.some(([method, path]) => method === request.method && path.test(request.path));
}
export function assertionFromWire(value: AssertionWire): AssertionResponse {
  if (!value || Object.keys(value).sort().join() !== "authenticatorData,clientDataJSON,credentialId,signature") deny();
  return { credentialId: value.credentialId, clientDataJSON: fromBase64url(value.clientDataJSON),
    authenticatorData: fromBase64url(value.authenticatorData), signature: fromBase64url(value.signature) };
}
export function registrationFromWire(value: RegistrationWire): RegistrationResponse {
  if (!value || Object.keys(value).sort().join() !== "attestationObject,clientDataJSON,credentialId") deny();
  return { credentialId: value.credentialId, clientDataJSON: fromBase64url(value.clientDataJSON), attestationObject: fromBase64url(value.attestationObject) };
}
export type PrivilegedOperation = { action: "device.revoke" | "quiesce.begin" | "quiesce.cancel" | "quiesce.force"; targetId: string; requestId: string };
function operation(value: unknown): PrivilegedOperation {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "action,requestId,targetId") deny();
  const op = value as PrivilegedOperation;
  if (!["device.revoke", "quiesce.begin", "quiesce.cancel", "quiesce.force"].includes(op.action) ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(op.requestId) || typeof op.targetId !== "string") deny();
  if (op.action === "device.revoke" ? !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(op.targetId) : op.targetId !== "runtime") deny();
  return op;
}
function operationDigest(op: PrivilegedOperation): string {
  return requestDigest({ method: "POST", path: "/remote/action", body: op, encoding: "json" });
}

export class RemoteDispatcher {
  readonly uv: RemoteUv;
  constructor(readonly api: LocalApi, readonly trust: RemoteTrust) { this.uv = new RemoteUv(trust); }
  async dispatch(request: RemoteRequest, principal: RemotePrincipal): Promise<Response> {
    this.uv.assert(principal);
    if (request.path.startsWith("/remote/")) return this.control(request, principal);
    if (!businessAllowed(request)) throw new HttpError(404, "not_found", "unknown remote route");
    if (request.path === "/v1/settings" && request.method !== "GET" && Object.hasOwn(request.body ?? {}, "workspace_path")) deny();
    if (request.path === "/v1/turns/stop" && typeof request.body?.turn_id !== "string") deny();
    const url = new URL(request.path, "http://remote.invalid");
    for (const [key, value] of Object.entries(request.query ?? {}).sort(([a], [b]) => a.localeCompare(b))) url.searchParams.set(key, value);
    const response = await this.api.dispatchBusiness(new Request(url.toString(), { method: request.method,
      headers: { "Content-Type": "application/json", "X-Request-Id": request.id, ...(request.ifMatch ? { "If-Match": request.ifMatch } : {}) },
      body: request.method === "GET" ? undefined : JSON.stringify(request.body ?? {}),
    }), { deviceId: principal.device.device_id, requestId: request.id, requireRevision: true, guard: () => this.uv.assert(principal) });
    this.uv.assert(principal);
    return response;
  }
  private async control(request: RemoteRequest, principal: RemotePrincipal): Promise<Response> {
    const body = request.body ?? {};
    const json = (value: unknown) => Response.json(value);
    if (request.method === "GET" && request.path === "/remote/status") return json({ drain: this.api.quiesce.state(),
      devices: this.trust.devices().map(d => ({ id: d.device_id, name: d.name, revoked: !!d.revoked, hasUv: !!d.credential_id })) });
    if (request.method !== "POST" || request.query || request.ifMatch) deny();
    if (request.path === "/remote/uv/register-challenge") {
      if (Object.keys(body).length) deny();
      return json(this.uv.registrationChallenge(principal, request.id));
    }
    if (request.path === "/remote/uv/replacement-challenge") {
      if (Object.keys(body).sort().join() !== "challenge,response") deny();
      return json(this.uv.replacementChallenge(principal, String(body.challenge), registrationFromWire(body.response as RegistrationWire)));
    }
    if (request.path === "/remote/uv/register") {
      if (!Object.keys(body).every(k => ["challenge", "response", "replacement"].includes(k))) deny();
      const digest = requestDigest({ method: "POST", path: request.path, body, encoding: "json" });
      const scope = { deviceId: principal.device.device_id, requestId: request.id };
      const previous = this.trust.store.receipts.lookup(scope);
      if (previous) {
        if (previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "registration request changed");
        const receipt = this.trust.store.receipts.read(scope);
        return new Response(receipt.body, { status: receipt.status, headers: receipt.headers });
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
      if (Object.keys(body).join() !== "operation") deny();
      const op = operation(body.operation);
      return json(this.uv.issue(principal, op.requestId, op.action, op.targetId, operationDigest(op)));
    }
    if (request.path === "/remote/action") {
      if (Object.keys(body).sort().join() !== "assertion,challenge,operation") deny();
      const op = operation(body.operation);
      if (op.requestId !== request.id) deny();
      const scope = { deviceId: principal.device.device_id, requestId: op.requestId }, digest = operationDigest(op);
      const previous = this.trust.store.receipts.lookup(scope);
      if (previous) {
        if (previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "request id has a different action");
        const saved = this.trust.store.receipts.read(scope);
        return new Response(saved.body, { status: saved.status, headers: saved.headers });
      }
      await this.uv.assertion(principal, String(body.challenge), { deviceId: principal.device.device_id, sessionId: principal.sessionId,
        trustEpoch: principal.device.grant_epoch, requestId: request.id, action: op.action, targetId: op.targetId, operationDigest: digest },
      assertionFromWire(body.assertion as AssertionWire), () => {
        if (op.action !== "device.revoke") this.trust.store.afterCommit(() => {
          if (op.action === "quiesce.begin") this.api.quiesce.begin();
          if (op.action === "quiesce.cancel") this.api.quiesce.cancel();
          if (op.action === "quiesce.force") this.api.quiesce.force();
        });
        if (op.action === "device.revoke") {
          if (!this.trust.device(op.targetId)) deny();
          this.trust.store.db.run("INSERT INTO remote_revocations VALUES (?, ?, ?, ?)",
            [request.id, principal.device.device_id, op.targetId, this.trust.assertHost().generation]);
        }
        this.trust.store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
          VALUES (?, ?, ?, 'POST', '/remote/action', 'complete', ?, ?, '{}', ?)`,
        [scope.deviceId, scope.requestId, digest, op.action === "device.revoke" ? 202 : 204,
          op.action === "device.revoke" ? JSON.stringify({ state: "revocation_pending" }) : null, Date.now()]);
      });
      if (op.action === "device.revoke") {
        await this.trust.revoke(op.targetId, () => this.uv.assert(principal));
        this.trust.store.transaction(() => this.trust.store.db.run(
          "UPDATE request_receipts SET status = 204, body = NULL WHERE device_id = ? AND request_id = ?", [scope.deviceId, scope.requestId]));
      }
      return new Response(null, { status: 204 });
    }
    throw new HttpError(404, "not_found", "unknown remote route");
  }
}
