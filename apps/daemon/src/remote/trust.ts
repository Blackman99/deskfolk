import { base64url, canonicalHash, fromBase64url, type PairingRequest, type ReplayClaim } from "@real-bot/remote";
import { HttpError } from "../errors";
import type { Store } from "../store";
import type { RemoteNativeClient } from "../remote-native";

export type RemoteHost = { host_id: string; relay_origin: string; relay_id: string; generation: number };
export type TrustedDevice = {
  device_id: string; name: string; ua_hint: string; dh_pk: string; signing_pk: string; enrollment_pk: string;
  grant_epoch: number; generation: number; version: number; revoked: number; relay_pending: number;
  pairing_id: string; onboarding_until: number; onboarding_session: string | null;
  credential_id: string | null; cose_key: string | null; sign_count: number; credential_version: number;
};
export function deny(): never { throw new HttpError(403, "remote_denied", "remote authorization is no longer valid"); }

export class RemoteTrust {
  private admitted = false;
  private rotating = false;
  private closeListeners = new Set<() => void>();
  constructor(readonly store: Store, private readonly native: Pick<RemoteNativeClient, "highwater" | "advanceHighwater">,
    readonly now: () => number = Date.now) {}
  host(): RemoteHost | null { return this.store.db.query<RemoteHost, []>("SELECT * FROM remote_host WHERE singleton = 1").get(); }
  devices(): TrustedDevice[] { return this.store.db.query<TrustedDevice, []>("SELECT * FROM remote_devices ORDER BY device_id").all(); }
  device(id: string): TrustedDevice | null { return this.store.db.query<TrustedDevice, [string]>("SELECT * FROM remote_devices WHERE device_id = ?").get(id); }
  onInvalidate(fn: () => void): () => void { this.closeListeners.add(fn); return () => this.closeListeners.delete(fn); }
  close(): void { this.admitted = false; for (const fn of this.closeListeners) fn(); }

  async reconcile(): Promise<void> {
    this.close();
    const highwater = await this.native.highwater();
    if (this.host()?.generation !== highwater || this.store.db.query("SELECT 1 FROM remote_transition").get()) deny();
    const pending = this.store.db.query<{ request_id: string; target_id: string; generation: number }, []>("SELECT * FROM remote_revocations").all();
    if (pending.length) {
      if (pending.length !== 1 || pending[0]!.generation !== highwater || highwater === 0xffff_ffff) deny();
      this.admitted = true;
      await this.revoke(pending[0]!.target_id, () => this.assertHost());
      return;
    }
    this.admitted = true;
  }
  async initialize(host: Omit<RemoteHost, "generation">): Promise<void> {
    if (this.host()) deny();
    const highwater = await this.native.highwater();
    // A missing DB at a later high-water is a restore, not first setup.
    if (highwater !== 1) deny();
    this.store.transaction(() => this.store.db.run("INSERT INTO remote_host VALUES (1, ?, ?, ?, ?)",
      [host.host_id, host.relay_origin, host.relay_id, highwater]));
    await this.reconcile();
  }
  assertHost(): RemoteHost {
    const host = this.host();
    if (!this.admitted || this.rotating || !host) deny();
    return host;
  }
  trusted(pin: TrustedDevice): boolean {
    try {
      const host = this.assertHost(), current = this.device(pin.device_id);
      return !!current && !current.revoked && current.generation === host.generation && pin.generation === host.generation &&
        current.version === 1 && pin.version === 1 && current.grant_epoch === pin.grant_epoch &&
        current.dh_pk === pin.dh_pk && current.signing_pk === pin.signing_pk && current.enrollment_pk === pin.enrollment_pk;
    } catch { return false; }
  }
  assert(pin: TrustedDevice): void { if (!this.trusted(pin)) deny(); }
  grant(request: PairingRequest, pairingId: string): TrustedDevice {
    const host = this.assertHost();
    return this.store.transaction(() => {
      this.assertHost();
      if (this.devices().filter(d => !d.revoked).length >= 16 || this.device(request.device_id)) deny();
      const keys = [request.device_e_pk, request.device_s_pk, request.enrollment_pk];
      for (const value of keys) fromBase64url(value, 32);
      if (new Set(keys).size !== 3 || this.devices().some(d => [d.dh_pk, d.signing_pk, d.enrollment_pk].some(key => keys.includes(key)))) deny();
      this.store.db.run(`INSERT INTO remote_devices (device_id,name,ua_hint,dh_pk,signing_pk,enrollment_pk,grant_epoch,generation,pairing_id,onboarding_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [request.device_id, request.name, request.ua_hint, request.device_e_pk,
        request.device_s_pk, request.enrollment_pk, host.generation, host.generation, pairingId, Math.floor(this.now() / 1000) + 120]);
      return this.device(request.device_id)!;
    });
  }
  markRegistered(pin: TrustedDevice): void {
    this.store.transaction(() => { this.assert(pin); this.store.db.run("UPDATE remote_devices SET relay_pending = 0 WHERE device_id = ?", [pin.device_id]); });
  }
  markRevokedSynced(pin: TrustedDevice): void {
    this.store.transaction(() => {
      this.assertHost();
      const current = this.device(pin.device_id);
      if (!current?.revoked || this.fingerprint(current) !== this.fingerprint(pin)) deny();
      this.store.db.run("UPDATE remote_devices SET relay_pending = 0 WHERE device_id = ?", [pin.device_id]);
    });
  }
  bindOnboarding(pin: TrustedDevice, sessionId: string): void {
    this.store.transaction(() => {
      this.assert(pin);
      this.store.db.run(`UPDATE remote_devices SET onboarding_session = ? WHERE device_id = ? AND onboarding_session IS NULL
        AND credential_id IS NULL AND onboarding_until > ?`, [sessionId, pin.device_id, Math.floor(this.now() / 1000)]);
    });
  }
  claimReplay(pin: TrustedDevice, claim: ReplayClaim): boolean {
    try {
      return this.store.transaction(() => {
        this.assert(pin);
        if (claim.deviceId !== pin.device_id || !Number.isFinite(claim.minimumTtlMs) || claim.minimumTtlMs > 600_000) return false;
        const now = this.now();
        this.store.db.run("DELETE FROM remote_replays WHERE expires_ms <= ?", [now]);
        const count = this.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM remote_replays").get()!.n;
        if (count >= 2048) return false;
        const sid = base64url(claim.sessionId), ephemeral = base64url(claim.ephemeralPublic);
        fromBase64url(sid, 16); fromBase64url(ephemeral, 32);
        this.store.db.run("INSERT INTO remote_replays VALUES (?, ?, ?, ?)",
          [sid, pin.device_id, ephemeral, now + Math.max(120_000, claim.minimumTtlMs)]);
        return true;
      });
    } catch { return false; }
  }
  async revoke(deviceId: string | null, guard: () => void): Promise<void> {
    guard();
    const host = this.assertHost();
    if (deviceId !== null && !this.device(deviceId)) deny();
    const generation = host.generation;
    const targets = this.devices().map(d => this.fingerprint(d));
    if (host.generation === 0xffff_ffff) deny();
    this.rotating = true;
    this.close();
    try {
      // Every removal advances high-water, including a single-device revoke.
      await this.native.advanceHighwater(host.generation, host.generation + 1);
      this.store.transaction(() => {
        if (this.host()?.generation !== generation || canonicalHash(this.devices().map(d => this.fingerprint(d))) !== canonicalHash(targets)) deny();
        this.store.db.run("UPDATE remote_host SET generation = ? WHERE singleton = 1", [host.generation + 1]);
        this.store.db.run("UPDATE remote_devices SET generation = ?, onboarding_until = 0, onboarding_session = NULL", [host.generation + 1]);
        this.store.db.run("UPDATE remote_devices SET revoked = 1, relay_pending = 1 WHERE (? IS NULL OR device_id = ?)", [deviceId, deviceId]);
        this.store.db.run("DELETE FROM remote_challenges");
        this.store.db.run(`UPDATE request_receipts SET status = 204, body = NULL WHERE EXISTS
          (SELECT 1 FROM remote_revocations r WHERE r.request_id = request_receipts.request_id AND r.requester_id = request_receipts.device_id)`);
        this.store.db.run("DELETE FROM remote_revocations");
      });
    } finally { this.rotating = false; }
    await this.reconcile();
  }
  async recover(authorizedHighwater: number): Promise<void> {
    this.close();
    let highwater = await this.native.highwater();
    const host = this.host();
    const devices = canonicalHash(this.devices().map(d => this.fingerprint(d)));
    if (!host || highwater !== authorizedHighwater || highwater < host.generation) deny();
    if (highwater === host.generation) {
      if (highwater === 0xffff_ffff) deny();
      await this.native.advanceHighwater(highwater, highwater + 1);
      highwater++;
    }
    this.store.transaction(() => {
      if (this.host()?.generation !== host.generation || canonicalHash(this.devices().map(d => this.fingerprint(d))) !== devices) deny();
      this.store.db.run("UPDATE remote_host SET generation = ? WHERE singleton = 1", [highwater]);
      this.store.db.run("UPDATE remote_devices SET revoked = 1, relay_pending = 1, generation = ?, onboarding_until = 0, onboarding_session = NULL", [highwater]);
      this.store.db.run("DELETE FROM remote_challenges");
      this.store.db.run("DELETE FROM remote_revocations");
      this.store.db.run("DELETE FROM remote_transition");
    });
    await this.reconcile();
  }
  fingerprint(pin: TrustedDevice): string {
    return canonicalHash({ id: pin.device_id, dh: pin.dh_pk, signing: pin.signing_pk, enrollment: pin.enrollment_pk,
      epoch: pin.grant_epoch, generation: pin.generation, version: pin.version, revoked: pin.revoked });
  }
}
