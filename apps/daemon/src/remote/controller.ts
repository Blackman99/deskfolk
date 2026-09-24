import { FILE_DROP_SESSION_ID } from "@real-bot/protocol";
import { base64url, canonicalBytes, canonicalHash, decodeFileChunk, fromBase64url, fragmentMessage, HostSession, identityPublic,
  openPairing, parseRemoteRequest, randomBytes, Reassembler, sealPairingGrant, sha256Hex, signGrant, text,
  encodeFileChunk, MAX_BODY, MAX_FILE_CHUNK, REMOTE_FILE_LIMIT, REMOTE_FILE_STREAMS, REASSEMBLY_TTL_MS, type IdentitySecrets, type LogicalType,
  type PairingContext, type PairingQr, type PairingRequest, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";
import { deflateRawSync } from "node:zlib";
import type { LocalApi } from "../local-api";
import type { LiveFile, Store } from "../store";
import { ulid } from "../ids";
import { HttpError } from "../errors";
import { requestDigest } from "../request-digest";
import { remoteNative, type LocalAction, type RemoteNativeClient } from "../remote-native";
import { RelayBudget, RelayConnection, RelayControl, type RelayConfig, type RelaySocketFactory } from "./relay";
import { RemoteTrust, deny } from "./trust";
import { RemoteDispatcher } from "./dispatch";
import type { RemotePrincipal } from "./uv";
import { remoteError, responseError } from "./errors";
import { LocalTrustActions, validateRelay, type TrustChange } from "./local-actions";
import type { MaintenanceControl } from "./maint";
import { PushService, type PushFetch } from "./push";
import { StreamOutbox } from "./stream-outbox";

export type RemoteStatus = { state: "off" | "native_unavailable" | "activation_gated" | "connecting" | "online" | "disconnected" | "trust_mismatch"; diagnostic: string | null; devices: number };
export type RemoteNativeProvider = Pick<RemoteNativeClient, "capability" | "read" | "highwater" | "advanceHighwater" | "prepare" | "consume" | "reset">;
export type RemoteControllerOptions = {
  store: Store; api: LocalApi; config?: RelayConfig; native?: RemoteNativeProvider;
  socketFactory?: RelaySocketFactory; fetch?: typeof fetch; pushFetch?: PushFetch; now?: () => number;
  maint?: MaintenanceControl | null;
  /** Test-only upgrade pause. Production leaves this unset so transport is `policy_v2`; sends still require an open remote gate. */
  pausedUpgrade?: boolean;
};
type PendingPair = { context: PairingContext; issuedAt: number; secret: Uint8Array; request?: PairingRequest; action?: LocalAction; challenge?: string; consuming?: boolean };
type Link = { close(): void };

/** One window's worth of output per frame, and a ceiling on how much of it travels. */
const REMOTE_STREAM_WINDOW_MS = 50;
const REMOTE_STREAM_MAX_BYTES = 8 * 1024;
/** What waits for the windows after, per stream, before the oldest of it is dropped. */
const REMOTE_STREAM_BACKLOG_BYTES = 128 * 1024;

export class RemoteController {
  readonly trust: RemoteTrust;
  readonly dispatcher: RemoteDispatcher;
  readonly localActions: LocalTrustActions;
  readonly push: PushService;
  private readonly principals = new Map<string, RemotePrincipal>();
  private renewal?: { action: LocalAction; challenge: string; deviceId: string; sessionId: string; expires: number };
  private removal?: { action: LocalAction; challenge: string; deviceId: string; generation: number; expires: number };
  private readonly native: RemoteNativeProvider;
  private keys?: IdentitySecrets;
  private control?: RelayControl;
  private readonly budget = new RelayBudget();
  private stopped = true;
  private reconnect?: ReturnType<typeof setTimeout>;
  private backoff = 500;
  private statusValue: RemoteStatus = { state: "off", diagnostic: null, devices: 0 };
  private pairs = new Map<string, PendingPair>();
  private preparing = new Set<string>();
  private recovery?: { action: LocalAction; challenge: string; highwater: number; generation: number; expires: number };
  private pairTimer?: ReturnType<typeof setInterval>;
  private links = new Map<string, Link>();
  private routes = new Set<string>();
  constructor(private readonly options: RemoteControllerOptions) {
    this.native = options.native ?? remoteNative;
    this.trust = new RemoteTrust(options.store, this.native, options.now);
    this.push = new PushService({
      store: options.store,
      native: this.native,
      fetch: options.pushFetch,
      now: options.now,
      trust: this.trust,
      remoteStatus: () => this.status(),
      presence: options.api.presence,
      pausedUpgrade: options.pausedUpgrade ?? false,
    });
    this.dispatcher = new RemoteDispatcher(options.api, this.trust, options.maint ?? null, () => this.status(), this.push);
    this.localActions = new LocalTrustActions(this.trust, this.native);
    options.api.subscribeSync((frame) => {
      if (frame.type === "event") this.push.notify(frame.payload);
    });
    this.trust.onInvalidate(() => {
      for (const link of [...this.links.values()]) link.close();
      this.links.clear(); this.routes.clear(); this.clearPairs();
      this.control?.close();
    });
  }
  status(): RemoteStatus { return { ...this.statusValue, devices: this.trust.devices().filter(d => !d.revoked).length }; }
  private setStatus(state: RemoteStatus["state"], diagnostic: string | null = null): void {
    const previous = this.statusValue.state;
    this.statusValue = { state, diagnostic, devices: 0 };
    if (previous !== state && (state === "connecting" || state === "online" || state === "disconnected")) {
      this.push.recoverScheduled();
    }
  }
  async start(): Promise<void> {
    if (!this.options.config || !this.stopped) return;
    this.stopped = false;
    let capability: Awaited<ReturnType<RemoteNativeProvider["capability"]>>;
    try { capability = await this.native.capability(); }
    catch { this.setStatus("native_unavailable", "native_unavailable"); this.stopped = true; return; }
    if (!capability.nativeAvailable) { this.setStatus("native_unavailable", capability.diagnostic); this.stopped = true; return; }
    if (this.native === remoteNative && !capability.enabled) { this.setStatus("activation_gated", capability.diagnostic); this.stopped = true; return; }
    try {
      const host = await this.native.read("host_identity"), enrollment = await this.native.read("enrollment");
      try {
        if (host.length !== 64 || enrollment.length !== 32) deny();
        this.keys = { dh: new Uint8Array(host.subarray(0, 32)), signing: new Uint8Array(host.subarray(32)), enrollment: new Uint8Array(enrollment) };
        identityPublic(this.keys);
      } finally { host.fill(0); enrollment.fill(0); }
      await this.localActions.reconcile();
      const stored = this.trust.host();
      if (!stored) deny();
      this.options.config = { hostId: stored.host_id, origin: stored.relay_origin, relayId: stored.relay_id };
      await this.trust.reconcile();
      this.pairTimer = setInterval(() => this.expirePairs(), 1000);
      await this.connect();
    } catch { this.setStatus("trust_mismatch", "remote_admission_denied"); this.stopTransport(); }
  }
  /** Invoked only on the inherited desktop channel, never through LocalApi or Noise. */
  async initialize(config: RelayConfig, bootstrap?: string): Promise<void> {
    const capability = await this.native.capability();
    if (!capability.nativeAvailable) { this.setStatus("native_unavailable", capability.diagnostic); deny(); }
    if (this.native === remoteNative && !capability.enabled) { this.setStatus("activation_gated", capability.diagnostic); deny(); }
    if (this.options.config && canonicalHash(this.options.config) !== canonicalHash(config)) deny();
    validateRelay(config);
    if (!this.trust.host()) await this.trust.initialize({ host_id: config.hostId, relay_origin: config.origin, relay_id: config.relayId });
    const stored = this.trust.host();
    if (!stored || stored.host_id !== config.hostId || stored.relay_origin !== config.origin || stored.relay_id !== config.relayId) deny();
    this.options.config = { ...config };
    if (bootstrap !== undefined) {
      fromBase64url(bootstrap, 32);
      const host = await this.native.read("host_identity"), enrollment = await this.native.read("enrollment");
      try {
        const publicKeys = identityPublic({ dh: new Uint8Array(host.subarray(0, 32)), signing: new Uint8Array(host.subarray(32)), enrollment: new Uint8Array(enrollment) });
        const response = await (this.options.fetch ?? fetch)(`${config.origin}/v1/relay/bootstrap`, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
          body: new TextDecoder().decode(canonicalBytes({ bootstrap, host_id: config.hostId, enrollment_pk: base64url(publicKeys.enrollment) })) });
        if (response.status !== 201) throw new Error("relay_bootstrap");
      } finally { host.fill(0); enrollment.fill(0); }
    }
    await this.start();
  }
  async prepareChange(change: TrustChange): Promise<{ challenge: string; expiresIn: 120 }> {
    return this.localActions.prepare(change);
  }
  async confirmChange(proof: string): Promise<RemoteStatus> {
    try { await this.localActions.confirm(proof, () => this.stopTransport()); }
    catch (error) { if (this.stopped) this.setStatus("trust_mismatch", "remote_transition_pending"); throw error; }
    const host = this.trust.host()!;
    this.options.config = { hostId: host.host_id, origin: host.relay_origin, relayId: host.relay_id };
    if (this.stopped) await this.start();
    return this.status();
  }
  async prepareUvRenewal(deviceId: string): Promise<{ challenge: string; expiresIn: 120 }> {
    const principal = this.principals.get(deviceId), device = this.trust.device(deviceId);
    if (!principal || !device || device.credential_id) deny();
    this.dispatcher.uv.assert(principal);
    const action: LocalAction = { kind: "renew_first_uv", digest: canonicalHash({ action: "renew_first_uv", host: this.trust.assertHost(),
      pins: this.trust.fingerprint(device), sessionId: principal.sessionId, credentialVersion: device.credential_version }),
      display: `Renew first UV registration: ${device.name} · ${sha256Hex(fromBase64url(device.signing_pk, 32))}` };
    const prepared = await this.native.prepare(action);
    this.dispatcher.uv.assert(principal);
    this.renewal = { action, challenge: prepared.challenge, deviceId, sessionId: principal.sessionId, expires: this.trust.now() + 120_000 };
    return prepared;
  }
  async confirmUvRenewal(proof: string): Promise<void> {
    const renewal = this.renewal; this.renewal = undefined;
    if (!renewal || this.trust.now() >= renewal.expires) deny();
    await this.native.consume(renewal.action, renewal.challenge, proof);
    this.options.store.transaction(() => {
      const principal = this.principals.get(renewal.deviceId), device = this.trust.device(renewal.deviceId);
      if (!principal || !device || device.credential_id || principal.sessionId !== renewal.sessionId || this.trust.now() >= renewal.expires) deny();
      this.dispatcher.uv.assert(principal);
      if (canonicalHash({ action: "renew_first_uv", host: this.trust.assertHost(), pins: this.trust.fingerprint(device),
        sessionId: principal.sessionId, credentialVersion: device.credential_version }) !== renewal.action.digest) deny();
      this.options.store.db.run("DELETE FROM remote_challenges WHERE device_id = ?", [device.device_id]);
      this.options.store.db.run("UPDATE remote_devices SET onboarding_session = ?, onboarding_until = ? WHERE device_id = ?",
        [principal.sessionId, Math.floor(this.trust.now() / 1000) + 120, device.device_id]);
    });
  }
  async listDevices(): Promise<Array<{ id: string; name: string; lastActiveAt: number | null }>> {
    this.trust.assertHost();
    return this.trust.devices().filter(device => !device.revoked).map(device => ({
      id: device.device_id,
      name: device.name,
      lastActiveAt: device.last_active_at || null,
    }));
  }
  async prepareRemoveDevice(deviceId: string): Promise<{ challenge: string; expiresIn: 120 }> {
    const host = this.trust.assertHost(), device = this.trust.device(deviceId);
    if (!device || device.revoked) deny();
    const action: LocalAction = { kind: "remove_device", digest: canonicalHash({
      action: "remove_remote_device", host, device: this.trust.fingerprint(device),
    }), display: `Remove connected device: ${device.name} · ${sha256Hex(fromBase64url(device.signing_pk, 32))}` };
    const prepared = await this.native.prepare(action);
    this.removal = { action, challenge: prepared.challenge, deviceId, generation: host.generation, expires: this.trust.now() + 120_000 };
    return prepared;
  }
  async confirmRemoveDevice(proof: string): Promise<void> {
    const removal = this.removal; this.removal = undefined;
    if (!removal || this.trust.now() >= removal.expires || this.trust.host()?.generation !== removal.generation) deny();
    await this.native.consume(removal.action, removal.challenge, proof);
    const host = this.trust.assertHost(), device = this.trust.device(removal.deviceId);
    if (!device || device.revoked || this.trust.now() >= removal.expires || host.generation !== removal.generation ||
      canonicalHash({ action: "remove_remote_device", host, device: this.trust.fingerprint(device) }) !== removal.action.digest) deny();
    await this.trust.revoke(removal.deviceId, () => this.trust.assertHost());
  }
  async prepareRecovery(): Promise<{ challenge: string; expiresIn: 120 }> {
    const host = this.trust.host();
    if (!host) deny();
    const highwater = await this.native.highwater();
    if (highwater < host.generation) deny();
    const action: LocalAction = { kind: "recover_trust", digest: canonicalHash({ action: "recover_remote_trust", host,
      highwater, pins: await this.localActions.pins(), transition: this.options.store.db.query("SELECT * FROM remote_transition").get(),
      devices: this.trust.devices().map(d => this.trust.fingerprint(d)), revokeAll: true }),
      display: "Recover remote trust: revoke every device and require new local pairing" };
    const prepared = await this.native.prepare(action);
    this.recovery = { action, challenge: prepared.challenge, highwater, generation: host.generation, expires: this.trust.now() + 120_000 };
    return prepared;
  }
  async confirmRecovery(proof: string): Promise<void> {
    const recovery = this.recovery; this.recovery = undefined;
    if (!recovery || this.trust.host()?.generation !== recovery.generation || this.trust.now() >= recovery.expires) deny();
    await this.native.consume(recovery.action, recovery.challenge, proof);
    const host = this.trust.host();
    if (!host || this.trust.now() >= recovery.expires || canonicalHash({ action: "recover_remote_trust", host, highwater: recovery.highwater,
      pins: await this.localActions.pins(), transition: this.options.store.db.query("SELECT * FROM remote_transition").get(), devices: this.trust.devices().map(d => this.trust.fingerprint(d)), revokeAll: true }) !== recovery.action.digest) deny();
    this.stopTransport();
    await this.trust.recover(recovery.highwater);
    await this.start();
  }
  private async connect(): Promise<void> {
    if (this.stopped || !this.keys || !this.options.config) return;
    this.setStatus("connecting");
    const control = new RelayControl(this.options.config, this.keys.enrollment, value => {
      if (value.type === "route_pending") void this.route(String(value.route_id), String(value.device_id)).catch(() => control.close());
      else this.links.get(String(value.route_id))?.close();
    }, () => {
      if (this.control !== control) return;
      this.control = undefined;
      for (const link of [...this.links.values()]) link.close();
      this.routes.clear(); this.clearPairs();
      if (!this.stopped) {
        this.setStatus("disconnected", "relay_disconnected");
        this.reconnect = setTimeout(() => { void this.connect().catch(() => undefined); }, this.backoff);
        this.backoff = Math.min(30_000, this.backoff * 2);
      }
    }, this.options.socketFactory, this.budget);
    this.control = control;
    try {
      await control.connection.ready;
      this.trust.assertHost();
      for (const device of this.trust.devices()) {
        if (device.revoked && device.relay_pending) {
          await control.command("revoke_device", { device_id: device.device_id });
          this.trust.markRevokedSynced(device);
        } else if (!device.revoked && device.relay_pending) {
          await control.command("register_device", { device_id: device.device_id, enrollment_pk: device.enrollment_pk });
          this.trust.markRegistered(device);
        }
      }
      if (this.control !== control || this.stopped) return;
      this.backoff = 500;
      this.setStatus("online");
    } catch { control.close(); }
  }
  async openPair(): Promise<PairingQr> {
    const host = this.trust.assertHost();
    if (!this.control || !this.keys || this.statusValue.state !== "online" || this.pairs.size >= 4) deny();
    const context = { pairingId: ulid(), hostId: host.host_id, expiresUnix: Math.floor(this.trust.now() / 1000) + 600 };
    const issuedAt = Math.floor(this.trust.now() / 1000);
    const secret = randomBytes(32), pending = { context, secret, issuedAt };
    this.pairs.set(context.pairingId, pending);
    try { await this.control.command("open_pair", { pairing_id: context.pairingId, expires_unix: context.expiresUnix }); }
    catch (error) { this.erasePair(context.pairingId); throw error; }
    if (this.pairs.get(context.pairingId) !== pending) deny();
    const pub = identityPublic(this.keys);
    return { v: 1, ...context, issuedAt, trustEpoch: host.generation, relayOrigin: host.relay_origin, relayId: host.relay_id,
      secret: base64url(secret), hostDhPublic: base64url(pub.dh), hostSigningPublic: base64url(pub.signing) };
  }
  async preparePair(pairingId: string): Promise<{ pending: true } | { challenge: string; expiresIn: 120; name: string; fingerprint: string }> {
    if (this.preparing.has(pairingId)) deny();
    this.preparing.add(pairingId);
    try { return await this.readPair(pairingId); }
    finally { this.preparing.delete(pairingId); }
  }
  private async readPair(pairingId: string): Promise<{ pending: true } | { challenge: string; expiresIn: 120; name: string; fingerprint: string }> {
    const pair = this.pair(pairingId), control = this.control;
    if (!control || pair.consuming) deny();
    if (pair.challenge) deny();
    if (!pair.request) {
      let offset = 0, bytes: Uint8Array | undefined;
      do {
        const response = await control.command("read_pair", { pairing_id: pairingId, offset });
        if (response.pending === true) return { pending: true };
        const total = Number(response.total), chunk = fromBase64url(String(response.ciphertext));
        if (!Number.isInteger(total) || total < 40 || total > 65536 || response.offset !== offset || chunk.length === 0 || chunk.length > 16384 || offset + chunk.length > total) deny();
        bytes ??= new Uint8Array(total);
        if (bytes.length !== total) deny();
        bytes.set(chunk, offset); offset += chunk.length;
      } while (offset < bytes.length);
      try { pair.request = openPairing(bytes, pair.secret, pair.context, Math.floor(this.trust.now() / 1000)); }
      finally { bytes.fill(0); }
    }
    const request = pair.request, fingerprint = sha256Hex(fromBase64url(request.device_s_pk, 32)), host = this.trust.assertHost();
    if (/[\p{Cc}\p{Cf}]/u.test(request.name + request.ua_hint)) deny();
    const publicKeys = identityPublic(this.keys!);
    pair.action = { kind: "pair_device", digest: canonicalHash({ request, pairing: pair.context, issuedAt: pair.issuedAt, relay: host.relay_origin,
      relayId: host.relay_id, generation: host.generation, hostKeys: {
        dh: base64url(publicKeys.dh), signing: base64url(publicKeys.signing), enrollment: base64url(publicKeys.enrollment) } }),
      display: `${request.name} (${request.ua_hint.slice(0, 80)}) · ${fingerprint}` };
    const prepared = await this.native.prepare(pair.action);
    if (this.pair(pairingId) !== pair) deny();
    pair.challenge = prepared.challenge;
    return { ...prepared, name: request.name, fingerprint };
  }
  async confirmPair(pairingId: string, proof: string): Promise<{ deviceId: string }> {
    const pair = this.pair(pairingId);
    if (!pair.request || !pair.action || !pair.challenge || pair.consuming || !this.control || !this.keys) deny();
    pair.consuming = true;
    const control = this.control;
    try {
      await this.native.consume(pair.action, pair.challenge, proof);
      if (this.pair(pairingId) !== pair || control !== this.control) deny();
      const publicKeys = identityPublic(this.keys);
      const hostKeyValues = Object.values(publicKeys).map(base64url);
      if ([pair.request.device_e_pk, pair.request.device_s_pk, pair.request.enrollment_pk].some(key => hostKeyValues.includes(key))) deny();
      const device = this.trust.grant(pair.request, pairingId), host = this.trust.assertHost();
      const grant = { hostId: host.host_id, deviceId: device.device_id, deviceDhPublic: fromBase64url(device.dh_pk, 32),
        deviceSigningPublic: fromBase64url(device.signing_pk, 32), enrollmentPublic: fromBase64url(device.enrollment_pk, 32),
        trustEpoch: device.grant_epoch, protocolVersion: 1, relayOrigin: host.relay_origin, issuedAt: pair.issuedAt };
      const reply = sealPairingGrant({ grant, signature: signGrant(grant, this.keys.signing) }, pair.secret, pair.context, Math.floor(this.trust.now() / 1000));
      try {
        await control.command("register_device", { device_id: device.device_id, enrollment_pk: device.enrollment_pk });
        this.trust.markRegistered(device);
        for (let offset = 0; offset < reply.length; offset += 16384) {
          this.trust.assert(device);
          await control.command("deliver_pair", { pairing_id: pairingId, offset, total: reply.length, ciphertext: base64url(reply.subarray(offset, offset + 16384)) });
        }
      } finally { reply.fill(0); }
      return { deviceId: device.device_id };
    } finally { this.erasePair(pairingId); }
  }
  private pair(id: string): PendingPair {
    const pair = this.pairs.get(id);
    if (!pair || Math.floor(this.trust.now() / 1000) >= pair.context.expiresUnix) deny();
    this.trust.assertHost();
    return pair;
  }
  private erasePair(id: string): void { this.pairs.get(id)?.secret.fill(0); this.pairs.delete(id); }
  private clearPairs(): void { for (const id of this.pairs.keys()) this.erasePair(id); }
  private expirePairs(): void {
    for (const [id, pair] of this.pairs) if (this.trust.now() >= pair.context.expiresUnix * 1000) {
      this.erasePair(id); void this.control?.command("cancel_pair", { pairing_id: id }).catch(() => undefined);
    }
  }
  private async route(routeId: string, deviceId: string): Promise<void> {
    if (this.routes.has(routeId)) return;
    const device = this.trust.device(deviceId);
    if (!device || !this.trust.trusted(device) || !this.keys || !this.options.config || this.links.size >= 16) {
      await this.control?.command("close_route", { route_id: routeId }); return;
    }
    this.routes.add(routeId);
    const host = this.trust.assertHost();
    const session = new HostSession({ identity: this.keys, peer: { dh: fromBase64url(device.dh_pk, 32), signing: fromBase64url(device.signing_pk, 32) },
      binding: { hostId: host.host_id, deviceId, trustEpoch: device.grant_epoch, protocolVersion: 1, relayOrigin: host.relay_origin },
      isTrusted: () => this.trust.trusted(device), claimReplay: claim => this.trust.claimReplay(device, claim), recentRttMs: 5000 });
    const assembler = new Reassembler();
    let alive = true, busy = false, assembling = false, assemblyStarted = 0, principal: RemotePrincipal | undefined, unsubscribe: (() => void) | undefined, unsubscribeStreams: (() => void) | undefined, unsubscribeTools: (() => void) | undefined;
    let queuedBytes = 0, sending = false;
    /** The device asked, with `/remote/features`, for compressed answers (see {@link packJson}). */
    let deflate = false;
    const abort = new AbortController();
    const outgoing: Array<{ type: number; body: Uint8Array; stream?: number; done?: () => void }> = [];
    let streamId = 0;
    type FileStream = {
      cancelled: boolean; direction: "down" | "up"; live?: LiveFile;
      done?: (error?: HttpError, commit?: import("../store").FileCommit) => void;
    };
    const fileStreams = new Map<number, FileStream>();
    const retiredStreams = new Set<number>();
    const retire = (id: number) => {
      fileStreams.delete(id);
      retiredStreams.add(id);
      if (retiredStreams.size > 32) retiredStreams.delete(retiredStreams.values().next().value!);
    };
    const abortUploads = (code: "cancelled" | "failed" = "cancelled") => {
      for (const [id, stream] of [...fileStreams]) {
        stream.cancelled = true;
        if (stream.direction === "up" && stream.live) {
          this.options.store.abortLiveFile(stream.live);
          stream.live = undefined;
          stream.done?.(new HttpError(code === "cancelled" ? 409 : 422, code, code === "cancelled" ? "upload cancelled" : "upload failed"));
        }
        retire(id);
      }
    };
    const close = () => {
      if (!alive) return; alive = false; abort.abort();
      clearInterval(timer); clearTimeout(handshakeTimer); session.close(); assembler.clear(); unsubscribe?.();
      unsubscribeStreams?.(); unsubscribeTools?.(); clearTimeout(streamTimer); outboxes.clear();
      if (principal) {
        this.dispatcher.uv.clearSession(principal.sessionId);
        if (this.principals.get(deviceId) === principal) this.principals.delete(deviceId);
      }
      for (const message of outgoing) { message.body.fill(0); message.done?.(); }
      outgoing.length = 0; queuedBytes = 0;
      abortUploads("cancelled");
      this.links.delete(routeId); this.routes.delete(routeId); connection.close();
    };
    const pump = async () => {
      if (sending) return; sending = true;
      try {
        while (alive && outgoing.length) {
          const next = outgoing.shift()!; queuedBytes -= next.body.length;
          try {
            const deadline = Date.now() + 5000;
            // Wait only when the next ciphertext would pass the socket's 64 KiB ceiling. Waiting
            // for a completely empty buffer turns a download into stop-and-wait: the amount still
            // buffered lags the bytes, so the frame after "here is the file" sits out this
            // deadline and the link is dropped. A note never finishes opening.
            const cipherBytes = next.body.length + 41;
            while (alive && connection.socket.bufferedAmount + cipherBytes > 65536 && Date.now() < deadline) await Bun.sleep(2);
            if (!alive || connection.socket.bufferedAmount + cipherBytes > 65536) throw new Error("backpressure");
            await this.budget.take(next.body.length + 41, abort.signal);
            if (!alive) throw new Error("closed");
            if (next.stream !== undefined && fileStreams.get(next.stream)?.cancelled) continue;
            connection.send(session.send(next.type as 1, next.body));
          } finally { next.body.fill(0); next.done?.(); }
        }
      } catch { close(); } finally { sending = false; }
    };
    const enqueue = (type: number, body: Uint8Array, stream?: number, done?: () => void) => {
      if (!alive || queuedBytes + body.length > 1024 * 1024 + 65536) { done?.(); close(); return; }
      queuedBytes += body.length; outgoing.push({ type, body: new Uint8Array(body), stream, done }); void pump();
    };
    const sendFile = (body: Uint8Array, stream: number) => new Promise<void>(resolve => enqueue(5, body, stream, resolve));
    const sendJson = (type: LogicalType, value: unknown) => {
      const bytes = canonicalBytes(value);
      for (const frame of fragmentMessage(type, deflate && compressibleAnswer(type, value) ? packJson(bytes) : bytes)) enqueue(frame.type, frame.body);
    };
    /**
     * Terminal and command bytes, coalesced before they leave the machine. A Noise frame tops out
     * at 32 KiB and this is a phone on a radio, so each window sends at most one capped frame per
     * stream. That pace is the ceiling, not a filter: what comes faster waits in the stream's
     * {@link StreamOutbox} for the windows after, and only output that outruns it for the whole
     * backlog loses its oldest bytes. Dropping those beats {@link enqueue}'s backpressure — losing
     * scrollback is a scrolled past line, and closing the link would cost the session. Dropping
     * every burst past 8 KiB did too: a full-screen program redraws in bursts like that, and each
     * one printed "output outran the reader" into the middle of its screen.
     */
    const outboxes = new Map<string, StreamOutbox>();
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const flushStreams = () => {
      streamTimer = undefined;
      let more = false;
      for (const [id, outbox] of outboxes) {
        const frame = outbox.take(REMOTE_STREAM_MAX_BYTES);
        if (frame) {
          sendJson(3, {
            type: "stream", id, offset: frame.offset,
            data: Buffer.from(frame.bytes).toString("base64"),
            ...(frame.skipped ? { skipped: frame.skipped } : {}),
            ...(frame.closed ? { closed: true } : {}),
          });
        }
        if (outbox.done) outboxes.delete(id);
        else if (outbox.pending) more = true;
      }
      if (more && alive) streamTimer = setTimeout(flushStreams, REMOTE_STREAM_WINDOW_MS);
    };
    const claimedFiles = (request: RemoteRequest): Array<{ filename: string; size: number; sha256: string }> => {
      if (request.method !== "POST" || !new RegExp(`^/v1/sessions/(?:[0-9A-HJKMNP-TV-Z]{26}|${FILE_DROP_SESSION_ID})/messages$`).test(request.path)) return [];
      const files = request.body?.files;
      if (!Array.isArray(files) || !files.length) return [];
      return files.map((row) => {
        if (!row || typeof row !== "object") throw new HttpError(422, "invalid_args", "invalid remote properties");
        const file = row as { filename?: unknown; size?: unknown; sha256?: unknown };
        if (typeof file.filename !== "string" || typeof file.size !== "number" || typeof file.sha256 !== "string") throw new HttpError(422, "invalid_args", "invalid remote properties");
        if (!Number.isInteger(file.size) || file.size < 0 || file.size > REMOTE_FILE_LIMIT) throw new HttpError(413, "file_limit", "file too large");
        if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new HttpError(422, "invalid_args", "invalid remote properties");
        return { filename: file.filename, size: file.size, sha256: file.sha256 };
      });
    };
    const waitForUploads = async (request: RemoteRequest, files: Array<{ filename: string; size: number; sha256: string }>): Promise<
      { staged: Array<{ originalFilename: string; buffer: Uint8Array; staged: import("../store").FileCommit }> } | { receipt: { status: number; body: string | null; headers?: Record<string, string> } }
    > => {
      const scope = { deviceId, requestId: request.id };
      const digest = requestDigest({
        method: request.method, path: request.path,
        body: Object.fromEntries(Object.entries(request.body ?? {}).filter(([key]) => key !== "files")),
        multipart: true, normalizedFiles: files.map((file) => ({ file, filename: file.filename, hash: file.sha256 })),
      });
      const previous = this.options.store.receipts.lookup(scope);
      if (previous) {
        if (previous.payload_sha256 !== digest) throw new HttpError(409, "conflict", "request id has a different payload");
        return { receipt: this.options.store.receipts.read(scope) };
      }
      if (fileStreams.size + files.length > REMOTE_FILE_STREAMS) throw new HttpError(429, "stream_limit", "file stream limit");
      const opened: Array<{ streamId: number; filename: string; size: number; sha256: string }> = [];
      const waiters: Array<Promise<import("../store").FileCommit>> = [];
      for (const file of files) {
        const reserved = this.options.store.reserveAttachmentName(file.filename);
        const live = this.options.store.openLiveFile(reserved.root, reserved.abs, file.sha256, file.size);
        const currentStream = ++streamId;
        opened.push({ streamId: currentStream, filename: file.filename, size: file.size, sha256: file.sha256 });
        if (file.size === 0) {
          waiters.push(Promise.resolve(this.options.store.finishLiveFile(live)));
          continue;
        }
        waiters.push(new Promise((resolve, reject) => {
          fileStreams.set(currentStream, {
            cancelled: false, direction: "up", live,
            done: (error, commit) => { if (error || !commit) reject(error ?? new HttpError(422, "failed", "upload failed")); else resolve(commit); },
          });
        }));
      }
      sendJson(2, { v: 1, id: request.id, status: 202, body: { state: "upload_open" }, upload: { files: opened } });
      try {
        const staged = await Promise.all(waiters);
        return { staged: staged.map((row, index) => ({ originalFilename: files[index]!.filename, buffer: new Uint8Array(), staged: row })) };
      } catch (error) {
        for (const row of opened) {
          const stream = fileStreams.get(row.streamId);
          if (stream?.live) this.options.store.abortLiveFile(stream.live);
          retire(row.streamId);
        }
        const err = error instanceof HttpError ? error : new HttpError(422, "failed", "upload failed");
        await this.options.store.receipts.execute(
          scope, digest, request.method, request.path, request.body ?? {},
          async () => { throw err; }, [],
        );
        throw err;
      }
    };
    const respond = async (bytes: Uint8Array) => {
      let id: string | undefined;
      try {
        const request = parseRemoteRequest(bytes); id = request.id;
        this.trust.touchActive(device);
        if (request.method === "POST" && request.path === "/remote/features") {
          // What this device reads, asked once per link before anything that would use it.
          const compress = request.body?.compress;
          deflate = Array.isArray(compress) && compress.includes("deflate-raw");
          sendJson(2, { v: 1, id, status: 200, body: { compress: deflate ? "deflate-raw" : null } });
          return;
        }
        const files = claimedFiles(request);
        const waited = files.length ? await waitForUploads(request, files) : { staged: [] };
        const staged = "staged" in waited ? waited.staged : [];
        const dispatchRequest = files.length
          ? { ...request, body: Object.fromEntries(Object.entries(request.body ?? {}).filter(([key]) => key !== "files")) }
          : request;
        const response = "receipt" in waited
          ? new Response(waited.receipt.body, { status: waited.receipt.status, headers: { "Content-Type": "application/json", ...waited.receipt.headers } })
          : await this.dispatcher.dispatch(dispatchRequest, principal!, staged.length ? staged : undefined);
        this.dispatcher.uv.assert(principal!);
        const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
        const result: RemoteResponse = { v: 1, id, status: response.status, body: null,
          headers: { contentType, ...(response.headers.has("Content-Range") ? { contentRange: response.headers.get("Content-Range")! } : {}), ...(response.headers.has("ETag") ? { etag: response.headers.get("ETag")! } : {}),
            ...(response.headers.has("X-Original-Size") ? { originalSize: Number(response.headers.get("X-Original-Size")) } : {}) } };
        if (response.status >= 400) result.body = await responseError(response);
        else if (response.body && contentType.includes("application/json") && request.path !== "/v1/workspace/file" && !/^\/v1\/attachments\/[^/]+\/content$/.test(request.path) && !/^\/v1\/annotations\/[^/]+\/crop$/.test(request.path)) result.body = await response.json();
        else if (response.body) {
          const data = new Uint8Array(await response.arrayBuffer());
          try {
            if (data.length > REMOTE_FILE_LIMIT) throw new HttpError(413, "file_limit", "file too large");
            // A file whose response still fits in one frame rides inside it. The old path sent
            // "here it comes" and then the bytes, and the second frame was the one that waited.
            if (data.length > 0 && data.length <= MAX_FILE_CHUNK) {
              const inline: RemoteResponse = { ...result, file: { streamId: 0, size: data.length, bytes: base64url(data) } };
              const encoded = canonicalBytes(inline);
              const fits = encoded.length <= MAX_BODY;
              encoded.fill(0);
              if (fits) {
                sendJson(2, inline);
                return;
              }
            }
            if (fileStreams.size >= REMOTE_FILE_STREAMS || streamId === 0xffff_ffff) throw new HttpError(429, "stream_limit", "file stream limit");
            const currentStream = ++streamId, stream: FileStream = { cancelled: false, direction: "down" };
            fileStreams.set(currentStream, stream);
            result.file = { streamId: currentStream, size: data.length };
            sendJson(2, result);
            for (let offset = 0; offset < data.length || (offset === 0 && data.length === 0); offset += MAX_FILE_CHUNK) {
              this.dispatcher.uv.assert(principal!);
              if (!alive || stream.cancelled) break;
              while (alive && !stream.cancelled && queuedBytes > 65536) await Bun.sleep(2);
              if (!alive || stream.cancelled) break;
              const chunk = data.subarray(offset, offset + MAX_FILE_CHUNK);
              await sendFile(encodeFileChunk({ streamId: currentStream, offset: BigInt(offset), eof: offset + chunk.length === data.length, chunk }), currentStream);
              if (!data.length) break;
            }
            if (alive && stream.cancelled) {
              const cancelled = new Uint8Array(4); new DataView(cancelled.buffer).setUint32(0, currentStream);
              await new Promise<void>(resolve => enqueue(6, cancelled, undefined, resolve));
            }
            retire(currentStream);
            return;
          } finally { data.fill(0); }
        }
        this.dispatcher.uv.assert(principal!);
        if (staged.length && response.status < 400) {
          sendJson(2, result);
          return;
        }
        if (request.path.endsWith("/snapshot") && response.status === 200) {
          const encoded = canonicalBytes(result.body), pageBytes = 512 * 1024;
          try {
            if (encoded.length > 16 * 1024 * 1024) throw new HttpError(413, "snapshot_limit", "snapshot too large");
            if (encoded.length <= pageBytes) sendJson(8, result);
            else {
              const transferId = base64url(randomBytes(16)), count = Math.ceil(encoded.length / pageBytes);
              for (let index = 0; index < count; index++) {
                while (alive && queuedBytes > 65536) await Bun.sleep(2);
                this.dispatcher.uv.assert(principal!);
                sendJson(8, { ...result, body: null, snapshotPage: { transferId, index, count,
                  bytes: base64url(encoded.subarray(index * pageBytes, (index + 1) * pageBytes)) } });
              }
            }
          } finally { encoded.fill(0); }
        } else sendJson(2, result);
      } catch (error) {
        abortUploads("failed");
        if (id && alive && principal && this.trust.trusted(device)) sendJson(2, { v: 1, id, status: error instanceof HttpError ? error.status : 400,
          body: remoteError(error instanceof HttpError ? error.code : "rejected") });
        else close();
      } finally { bytes.fill(0); busy = false; }
    };
    const connection = new RelayConnection(this.options.config, this.keys.enrollment, "link", data => {
      try {
        if (!alive) return;
        if (!session.ready) {
          connection.send(session.accept(data)); clearTimeout(handshakeTimer);
          principal = { device, sessionId: base64url(session.authenticatedSessionId), signal: abort.signal, active: () => alive && session.ready };
          this.principals.set(deviceId, principal);
          this.trust.bindOnboarding(device, principal.sessionId);
          sendJson(3, { type: "ready", protocol: "remote-v1", ...this.options.api.syncCursor(), deviceId, trustEpoch: device.grant_epoch });
          unsubscribe = this.options.api.subscribeSync(frame => { try { sendJson(3, frame); } catch { close(); } });
          unsubscribeTools = this.options.api.subscribeTools(frame => {
            // Not watch-gated: a handful of frames a turn, and without them the bytes on screen
            // have no name and no ending.
            try { sendJson(3, frame); } catch { close(); }
          });
          unsubscribeStreams = this.options.api.subscribeStreams((id, read, watchers) => {
            // Only what this device asked to watch: a build running under a closed panel has no
            // business waking someone's radio.
            if (!watchers.includes(deviceId)) return;
            try {
              let outbox = outboxes.get(id);
              if (!outbox) outboxes.set(id, (outbox = new StreamOutbox(REMOTE_STREAM_BACKLOG_BYTES)));
              outbox.push(read);
              if (!streamTimer && outbox.pending) streamTimer = setTimeout(flushStreams, REMOTE_STREAM_WINDOW_MS);
            } catch { close(); }
          });
          return;
        }
        const frame = session.receive(data);
        if (frame.type === 7) { close(); return; }
        if (frame.type === 6) {
          if (frame.body.length !== 4) throw new Error("stream_cancel");
          const id = new DataView(frame.body.buffer, frame.body.byteOffset, 4).getUint32(0);
          const stream = fileStreams.get(id);
          if (!stream) {
            if (retiredStreams.has(id)) { enqueue(6, frame.body); return; }
            throw new Error("stream_cancel");
          }
          stream.cancelled = true;
          if (stream.direction === "up") {
            if (stream.live) this.options.store.abortLiveFile(stream.live);
            stream.live = undefined;
            stream.done?.(new HttpError(409, "cancelled", "upload cancelled"));
            retire(id);
            enqueue(6, frame.body);
            return;
          }
          for (let i = outgoing.length - 1; i >= 0; i--) if (outgoing[i]!.type === 5 &&
            new DataView(outgoing[i]!.body.buffer, outgoing[i]!.body.byteOffset, 4).getUint32(0) === id) {
            const [removed] = outgoing.splice(i, 1); queuedBytes -= removed!.body.length; removed!.body.fill(0); removed!.done?.();
          }
          return;
        }
        if (frame.type === 5) {
          const chunk = decodeFileChunk(frame.body);
          const stream = fileStreams.get(chunk.streamId);
          if (!stream || stream.direction !== "up" || !stream.live) throw new Error("stream_chunk");
          try {
            this.options.store.writeLiveFile(stream.live, Number(chunk.offset), chunk.chunk);
            if (chunk.eof) {
              const commit = this.options.store.finishLiveFile(stream.live);
              stream.live = undefined;
              stream.done?.(undefined, commit);
              retire(chunk.streamId);
            }
          } catch (error) {
            if (stream.live) this.options.store.abortLiveFile(stream.live);
            stream.live = undefined;
            stream.done?.(error instanceof HttpError ? error : new HttpError(422, "failed", "upload failed"));
            retire(chunk.streamId);
          }
          return;
        }
        if (frame.type !== 1 && frame.type !== 4) throw new Error("remote_type");
        if (busy || (assembling && frame.type !== 4)) throw new Error("remote_busy");
        if (frame.type === 4 && !assembling) assemblyStarted = performance.now();
        const logical = frame.type === 4 ? assembler.accept(frame.body, performance.now()) : { type: frame.type, body: frame.body };
        assembling = !logical;
        if (!logical) return;
        if (logical.type !== 1) throw new Error("remote_type");
        busy = true; void respond(logical.body);
      } catch { close(); }
    }, close, { route_id: routeId, device_id: deviceId }, this.options.socketFactory);
    const timer = setInterval(() => {
      try { assembler.expire(performance.now()); if (assembling && performance.now() - assemblyStarted >= REASSEMBLY_TTL_MS) close(); }
      catch { close(); }
    }, 1000);
    const handshakeTimer = setTimeout(close, 10_000);
    this.links.set(routeId, { close });
    try { await connection.ready; if (!this.trust.trusted(device)) close(); } catch { close(); }
  }
  private stopTransport(): void {
    this.stopped = true; clearTimeout(this.reconnect); clearInterval(this.pairTimer);
    this.control?.close(); this.control = undefined; this.trust.close();
    if (this.keys) for (const value of Object.values(this.keys)) value.fill(0);
    this.keys = undefined;
  }
  stop(): void { this.push.close(); this.stopTransport(); this.setStatus("off"); }
}

/**
 * Answers worth compressing once a device has asked: JSON responses and snapshot pages. Never a
 * file (its bytes may be anything, a key file included), an upload, an event, or anything the
 * device sends.
 */
function compressibleAnswer(type: LogicalType, value: unknown): boolean {
  if (type !== 2 && type !== 8) return false;
  const response = value as RemoteResponse;
  return !response.file && !response.upload;
}

const COMPRESS_OVER = 1024;

/**
 * One answer deflated on its own — no dictionary shared across messages — behind a 0x00 marker
 * byte, which JSON cannot start with. A snapshot is a fifth of its JSON this way. Compression
 * under encryption lets a length hint at content, which is why it stops at answers: they carry
 * no secret of their own (keys never leave the Mac), and a small one goes as it is.
 */
function packJson(bytes: Uint8Array): Uint8Array {
  if (bytes.length < COMPRESS_OVER) return bytes;
  const packed = deflateRawSync(bytes, { level: 6 });
  if (packed.length + 1 >= bytes.length) return bytes;
  const out = new Uint8Array(packed.length + 1);
  out.set(packed, 1);
  return out;
}
