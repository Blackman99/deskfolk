import { realpathSync, statSync } from "node:fs";
import { base64url, canonicalHash, canonicalize, identityPublic } from "@real-bot/remote";
import type { LocalAction } from "../remote-native";
import type { RemoteNativeProvider } from "./controller";
import { RemoteTrust, deny } from "./trust";
import { deletePushSubs } from "./push";
import type { RelayConfig } from "./relay";

export type TrustChange = { kind: "reset_identity" | "change_relay"; config: RelayConfig } |
  { kind: "change_workspace"; path: string };
type Prepared = { action: LocalAction; challenge: string; expires: number; payload: Record<string, unknown>; change: TrustChange };
type Transition = { kind: string; expected: number; next: number; payload: string; phase: string };
export function validateRelay(config: RelayConfig): void {
  if (!config || Object.keys(config).sort().join() !== "hostId,origin,relayId" || typeof config.origin !== "string" ||
    typeof config.hostId !== "string" || typeof config.relayId !== "string") deny();
  const url = new URL(config.origin);
  if (url.protocol !== "https:" || url.origin !== config.origin || url.username || url.password ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(config.hostId) || !/^[A-Za-z0-9_-]{1,64}$/.test(config.relayId)) deny();
}
function workspace(path: string) {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 4096) deny();
  const real = realpathSync(path), stat = statSync(real);
  if (!stat.isDirectory()) deny();
  return { path: real, dev: stat.dev, ino: stat.ino };
}
export class LocalTrustActions {
  private prepared?: Prepared;
  constructor(private readonly trust: RemoteTrust, private readonly native: RemoteNativeProvider) {}
  async pins(): Promise<string> {
    const host = await this.native.read("host_identity"), enrollment = await this.native.read("enrollment");
    try {
      const keys = { dh: new Uint8Array(host.subarray(0, 32)), signing: new Uint8Array(host.subarray(32)), enrollment: new Uint8Array(enrollment) };
      try { return canonicalHash(Object.fromEntries(Object.entries(identityPublic(keys)).map(([k, v]) => [k, base64url(v)]))); }
      finally { for (const key of Object.values(keys)) key.fill(0); }
    } finally { host.fill(0); enrollment.fill(0); }
  }
  async prepare(change: TrustChange): Promise<{ challenge: string; expiresIn: 120 }> {
    const host = this.trust.assertHost();
    if (this.trust.store.db.query("SELECT 1 FROM remote_transition").get()) deny();
    if (change.kind !== "change_workspace") {
      validateRelay(change.config);
      if (change.kind === "reset_identity" && change.config.hostId === host.host_id) deny();
      if (change.kind === "change_relay" && canonicalHash(change.config) === canonicalHash({ hostId: host.host_id, origin: host.relay_origin, relayId: host.relay_id })) deny();
    }
    const normalized: TrustChange = change.kind === "change_workspace" ? { kind: change.kind, path: workspace(change.path).path } : { kind: change.kind, config: { ...change.config } };
    const payload = { change: normalized, host, keys: await this.pins(), devices: this.trust.devices().map(d => this.trust.fingerprint(d)),
      workspace: this.trust.store.workspacePath(), settingsRevision: this.trust.store.settingsCached().settings_rev,
      targetDirectory: normalized.kind === "change_workspace" ? workspace(normalized.path) : null };
    if (host.generation !== await this.native.highwater()) deny();
    const action: LocalAction = { kind: change.kind, digest: canonicalHash(payload),
      display: change.kind === "change_workspace" ? `Change workspace to ${normalized.kind === "change_workspace" ? normalized.path : ""}` :
        `${change.kind === "reset_identity" ? "Reset remote identity" : "Change relay"}: ${change.config.origin}; revoke all devices` };
    const prepared = await this.native.prepare(action);
    this.prepared = { action, challenge: prepared.challenge, expires: this.trust.now() + 120_000, payload, change: normalized };
    return prepared;
  }
  async confirm(proof: string, pause: () => void): Promise<void> {
    const pending = this.prepared; this.prepared = undefined;
    if (!pending || this.trust.now() >= pending.expires) deny();
    const host = this.trust.assertHost(), change = pending.change;
    const current = { ...pending.payload, host, keys: await this.pins(), devices: this.trust.devices().map(d => this.trust.fingerprint(d)),
      workspace: this.trust.store.workspacePath(), settingsRevision: this.trust.store.settingsCached().settings_rev,
      targetDirectory: change.kind === "change_workspace" ? workspace(change.path) : null };
    if (canonicalHash(current) !== pending.action.digest || await this.native.highwater() !== host.generation || this.trust.now() >= pending.expires) deny();
    if (change.kind === "change_workspace") {
      await this.native.consume(pending.action, pending.challenge, proof);
      this.trust.store.transaction(() => {
        this.trust.assertHost();
        if (this.trust.now() >= pending.expires || this.trust.host()!.generation !== host.generation ||
          canonicalHash(this.trust.devices().map(d => this.trust.fingerprint(d))) !== canonicalHash(current.devices) || this.trust.store.settingsCached().settings_rev !== current.settingsRevision ||
          canonicalHash(workspace(change.path)) !== canonicalHash(current.targetDirectory)) deny();
        this.trust.store.patchSettingsSync({ workspace_path: change.path });
      });
      return;
    }
    if (host.generation === 0xffff_ffff) deny();
    const next = host.generation + 1;
    if (change.kind !== "reset_identity") await this.native.consume(pending.action, pending.challenge, proof);
    this.trust.store.transaction(() => {
      this.trust.assertHost();
      if (this.trust.now() >= pending.expires || this.trust.host()!.generation !== host.generation || canonicalHash(this.trust.devices().map(d => this.trust.fingerprint(d))) !== canonicalHash(current.devices)) deny();
      this.trust.store.db.run("INSERT INTO remote_transition VALUES (1, ?, ?, ?, ?, 'native_uncertain')", [change.kind, host.generation, next, canonicalize({ config: change.config, oldPins: current.keys })]);
    });
    pause();
    if (change.kind === "reset_identity") await this.native.reset(pending.action, pending.challenge, proof, host.generation);
    else await this.native.advanceHighwater(host.generation, next);
    if (await this.native.highwater() !== next) deny();
    const pins = await this.pins();
    this.trust.store.transaction(() => this.trust.store.db.run("UPDATE remote_transition SET phase = 'native_done', payload = ? WHERE singleton = 1",
      [canonicalize({ config: change.config, pins })]));
    await this.reconcile();
  }
  async reconcile(): Promise<void> {
    const pending = this.trust.store.db.query<Transition, []>("SELECT * FROM remote_transition WHERE singleton = 1").get();
    if (!pending) return;
    this.trust.close();
    if (pending.phase !== "native_done" || await this.native.highwater() !== pending.next) deny();
    const payload = JSON.parse(pending.payload) as { config: RelayConfig; pins: string };
    validateRelay(payload.config);
    if (await this.pins() !== payload.pins) deny();
    this.trust.store.transaction(() => {
      const current = this.trust.store.db.query<Transition, []>("SELECT * FROM remote_transition WHERE singleton = 1").get();
      if (this.trust.host()?.generation !== pending.expected || !current || canonicalHash(current) !== canonicalHash(pending)) deny();
      this.trust.store.db.run("UPDATE remote_host SET host_id = ?, relay_origin = ?, relay_id = ?, generation = ? WHERE singleton = 1",
        [payload.config.hostId, payload.config.origin, payload.config.relayId, pending.next]);
      this.trust.store.db.run("UPDATE remote_devices SET revoked = 1, relay_pending = 1, generation = ?, onboarding_until = 0, onboarding_session = NULL", [pending.next]);
      deletePushSubs(this.trust.store, null);
      this.trust.store.db.run("DELETE FROM remote_challenges");
      this.trust.store.db.run("DELETE FROM remote_revocations");
      this.trust.store.db.run("DELETE FROM remote_transition");
    });
  }
}
