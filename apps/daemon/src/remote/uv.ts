import { base64url, canonicalHash, canonicalize, createUvChallenge, fromBase64url, registrationOperationDigest,
  verifyAssertion, verifyRegistration, type AssertionResponse, type OperationBinding, type RegistrationResponse,
  type StoredCredential, type UvChallenge, type VerifiedUv } from "@real-bot/remote";
import { RemoteTrust, deny, type TrustedDevice } from "./trust";

export type RemotePrincipal = { device: TrustedDevice; sessionId: string; active: () => boolean };
export class RemoteUv {
  constructor(private readonly trust: RemoteTrust) {}
  assert(principal: RemotePrincipal): void { if (!principal.active()) deny(); this.trust.assert(principal.device); }
  private current(principal: RemotePrincipal): TrustedDevice { this.assert(principal); return this.trust.device(principal.device.device_id)!; }
  private seconds(): number { return Math.floor(this.trust.now() / 1000); }
  issue(principal: RemotePrincipal, requestId: string, action: string, targetId: string, digest: string,
    kind: UvChallenge["kind"] = "assertion"): UvChallenge {
    const current = this.current(principal);
    if (kind === "assertion" && !current.credential_id) deny();
    if (kind === "registration" && !current.credential_id &&
      (current.onboarding_session !== principal.sessionId || current.onboarding_until <= this.seconds())) deny();
    const binding: OperationBinding = { deviceId: current.device_id, sessionId: principal.sessionId,
      trustEpoch: current.grant_epoch, requestId, action, targetId, operationDigest: digest };
    return this.trust.store.transaction(() => {
      this.assert(principal);
      this.trust.store.db.run("DELETE FROM remote_challenges WHERE expires_unix <= ?", [this.seconds()]);
      const records = this.trust.store.db.query<{ record: string }, [string]>("SELECT record FROM remote_challenges WHERE device_id = ?").all(current.device_id);
      for (const row of records) {
        const existing = JSON.parse(row.record) as UvChallenge;
        if (canonicalHash(existing.binding) === canonicalHash(binding) && existing.kind === kind) return existing;
      }
      if (records.length >= 8) deny();
      const record = createUvChallenge(binding, kind, this.seconds());
      this.trust.store.db.run("INSERT INTO remote_challenges VALUES (?, ?, ?, ?, ?)",
        [record.challenge, current.device_id, principal.sessionId, canonicalize(record), record.expiresAt]);
      return record;
    });
  }
  private record(principal: RemotePrincipal, challenge: string): UvChallenge {
    this.assert(principal);
    const row = this.trust.store.db.query<{ record: string }, [string, string, string]>(
      "SELECT record FROM remote_challenges WHERE challenge = ? AND device_id = ? AND session_id = ?").get(challenge, principal.device.device_id, principal.sessionId);
    if (!row) deny();
    return JSON.parse(row.record) as UvChallenge;
  }
  private context(record: UvChallenge, expectedBinding: OperationBinding) {
    const host = this.trust.assertHost();
    return { record, expectedBinding, nowUnix: this.seconds(), relayOrigin: host.relay_origin, rpId: new URL(host.relay_origin).hostname };
  }
  private consume(principal: RemotePrincipal, record: UvChallenge, before: TrustedDevice): TrustedDevice {
    const current = this.current(principal), stored = this.record(principal, record.challenge);
    if (current.credential_version !== before.credential_version || current.credential_id !== before.credential_id ||
      current.cose_key !== before.cose_key || current.sign_count !== before.sign_count ||
      canonicalHash(stored) !== canonicalHash(record) || this.seconds() < record.issuedAt || this.seconds() >= record.expiresAt) deny();
    const consumed = this.trust.store.db.query("DELETE FROM remote_challenges WHERE challenge = ? RETURNING challenge").get(record.challenge);
    if (!consumed) deny();
    return current;
  }
  async assertion(principal: RemotePrincipal, challenge: string, binding: OperationBinding, response: AssertionResponse,
    effect: () => void = () => {}): Promise<VerifiedUv> {
    const before = this.current(principal), record = this.record(principal, challenge);
    if (!before.credential_id || !before.cose_key) deny();
    const credential: StoredCredential = { credentialId: before.credential_id, cosePublicKey: fromBase64url(before.cose_key), signCount: before.sign_count };
    return verifyAssertion(response, credential, this.context(record, binding), update => this.trust.store.transaction(() => {
      this.consume(principal, record, before);
      if (update.previousSignCount !== before.sign_count || update.credentialId !== before.credential_id) deny();
      this.trust.store.db.run("UPDATE remote_devices SET sign_count = ? WHERE device_id = ?", [update.signCount, before.device_id]);
      effect();
      return true;
    }));
  }
  async register(principal: RemotePrincipal, challenge: string, response: RegistrationResponse,
    replacement?: { challenge: string; assertion: AssertionResponse }, committed?: () => void): Promise<void> {
    const before = this.current(principal), record = this.record(principal, challenge);
    if (record.binding.action !== "webauthn.register" || record.binding.targetId !== before.device_id) deny();
    let authorization: VerifiedUv | undefined;
    if (before.credential_id) {
      if (!replacement) deny();
      authorization = await this.assertion(principal, replacement.challenge,
        { ...record.binding, operationDigest: registrationOperationDigest(response) }, replacement.assertion);
    } else if (replacement) deny();
    const current = this.current(principal);
    await verifyRegistration(response, { ...this.context(record, record.binding), existingCredentialId: current.credential_id,
      pendingPair: { pairingId: current.pairing_id, deviceId: current.device_id, sessionId: current.onboarding_session ?? "",
        trustEpoch: current.grant_epoch, expiresAt: current.onboarding_until } }, authorization
        ? { kind: "prior-uv", authorization } : { kind: "pending-pair", pairingId: current.pairing_id }, update => this.trust.store.transaction(() => {
      const fresh = this.consume(principal, record, current);
      if (fresh.credential_id === null && (fresh.onboarding_until <= this.seconds() || fresh.onboarding_session !== principal.sessionId)) deny();
      this.trust.store.db.run(`UPDATE remote_devices SET credential_id = ?, cose_key = ?, sign_count = ?,
        credential_version = credential_version + 1, onboarding_until = 0, onboarding_session = NULL WHERE device_id = ?`,
      [update.credential.credentialId, base64url(update.credential.cosePublicKey), update.credential.signCount, current.device_id]);
      committed?.();
      return true;
    }));
  }
  registrationChallenge(principal: RemotePrincipal, requestId: string): UvChallenge {
    return this.issue(principal, requestId, "webauthn.register", principal.device.device_id,
      canonicalHash({ action: "webauthn.register", device: principal.device.device_id }), "registration");
  }
  replacementChallenge(principal: RemotePrincipal, createChallenge: string, response: RegistrationResponse): UvChallenge {
    const create = this.record(principal, createChallenge);
    if (create.kind !== "registration" || create.binding.action !== "webauthn.register") deny();
    return this.issue(principal, create.binding.requestId, "webauthn.register", principal.device.device_id, registrationOperationDigest(response));
  }
  clearSession(sessionId: string): void {
    this.trust.store.db.run("DELETE FROM remote_challenges WHERE session_id = ?", [sessionId]);
  }
}
