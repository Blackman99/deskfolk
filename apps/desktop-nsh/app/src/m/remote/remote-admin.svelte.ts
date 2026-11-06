// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 9f15638db9b86d6e
import { state } from "../../lib/reactive";
import type { RuntimeSnapshot } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { LocalApi } from "../local-api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { HostPairing, HostUnreachable } from "../runtime.svelte.ts";
import { RemoteApi, type RemoteDeviceRow, type RemoteDiagnostics, type RemoteMaintenanceStatus } from "./api.ts";
import { confirmPairing, initializeHost, listHostDevices, openPairing, readPairing, removeHostDevice, type HostDevice,
  type HostRelay } from "./pairing-host.ts";
import { pairFromQr, type PairingProgress } from "./pairing.ts";

/** A pairing window lasts ten minutes; checking it every three seconds is not a busy loop. */
const HOST_PAIRING_POLL_MS = 3000;

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client a
 * privileged call rides on, whether this page is the remote side of the link at all, whether the
 * page has been torn down, and restarting the connection loop after a QR pairing.
 */
export interface RemoteAdminHost {
  readonly api: MessengerApi | null;
  readonly remote: boolean;
  readonly stopped: boolean;
  start(): void;
}

/**
 * Pairing a phone to this Mac, the host side of pairing a phone in, the device list, and the
 * maintenance card's restart/stop/revoke/diagnostics actions — everything a person reaches for
 * from the settings panel's remote tab, as opposed to the connection loop that keeps a link alive
 * once it exists. `MessengerRuntime` forwards every field and method here under the same public
 * names, and reaches back in through {@link RemoteAdminHost}.
 */
export class RemoteAdmin {
  #pairing$s = state<PairingProgress>({ phase: "scan" });
	get pairing(): PairingProgress { return this.#pairing$s.get(); }
	set pairing(value: PairingProgress) { this.#pairing$s.set(value); }
  #pairingBusy$s = state(false);
	get pairingBusy() { return this.#pairingBusy$s.get(); }
	set pairingBusy(value) { this.#pairingBusy$s.set(value); }
  /** Host side of pairing: what the settings panel shows while a device is being enrolled. */
  #hostPairing$s = state<HostPairing>(null);
	get hostPairing(): HostPairing { return this.#hostPairing$s.get(); }
	set hostPairing(value: HostPairing) { this.#hostPairing$s.set(value); }
  #hostPairingBusy$s = state(false);
	get hostPairingBusy() { return this.#hostPairingBusy$s.get(); }
	set hostPairingBusy(value) { this.#hostPairingBusy$s.set(value); }
  #hostDevices$s = state<HostDevice[]>([]);
	get hostDevices(): HostDevice[] { return this.#hostDevices$s.get(); }
	set hostDevices(value: HostDevice[]) { this.#hostDevices$s.set(value); }
  #hostDevicesBusy$s = state(false);
	get hostDevicesBusy() { return this.#hostDevicesBusy$s.get(); }
	set hostDevicesBusy(value) { this.#hostDevicesBusy$s.set(value); }
  #hostDevicesError$s = state<string | null>(null);
	get hostDevicesError(): string | null { return this.#hostDevicesError$s.get(); }
	set hostDevicesError(value: string | null) { this.#hostDevicesError$s.set(value); }
  #hostRemoveDeviceId$s = state<string | null>(null);
	get hostRemoveDeviceId(): string | null { return this.#hostRemoveDeviceId$s.get(); }
	set hostRemoveDeviceId(value: string | null) { this.#hostRemoveDeviceId$s.set(value); }
  /** The connect form: registering this Mac with a relay before anything can pair. */
  #hostSetupBusy$s = state(false);
	get hostSetupBusy() { return this.#hostSetupBusy$s.get(); }
	set hostSetupBusy(value) { this.#hostSetupBusy$s.set(value); }
  #hostSetupError$s = state<string | null>(null);
	get hostSetupError(): string | null { return this.#hostSetupError$s.get(); }
	set hostSetupError(value: string | null) { this.#hostSetupError$s.set(value); }
  #enrolled$s = state(false);
	get enrolled() { return this.#enrolled$s.get(); }
	set enrolled(value) { this.#enrolled$s.set(value); }
  #hostUnreachable$s = state<HostUnreachable>("runtime");
	get hostUnreachable(): HostUnreachable { return this.#hostUnreachable$s.get(); }
	set hostUnreachable(value: HostUnreachable) { this.#hostUnreachable$s.set(value); }
  #remoteStatus$s = state<RuntimeSnapshot["remoteStatus"] | null>(null);
	get remoteStatus(): RuntimeSnapshot["remoteStatus"] | null { return this.#remoteStatus$s.get(); }
	set remoteStatus(value: RuntimeSnapshot["remoteStatus"] | null) { this.#remoteStatus$s.set(value); }
  #uvReady$s = state(false);
	get uvReady() { return this.#uvReady$s.get(); }
	set uvReady(value) { this.#uvReady$s.set(value); }
  #uvError$s = state<string | null>(null);
	get uvError(): string | null { return this.#uvError$s.get(); }
	set uvError(value: string | null) { this.#uvError$s.set(value); }
  #maintenance$s = state<RemoteMaintenanceStatus | null>(null);
	get maintenance(): RemoteMaintenanceStatus | null { return this.#maintenance$s.get(); }
	set maintenance(value: RemoteMaintenanceStatus | null) { this.#maintenance$s.set(value); }
  #maintenanceBusy$s = state(false);
	get maintenanceBusy() { return this.#maintenanceBusy$s.get(); }
	set maintenanceBusy(value) { this.#maintenanceBusy$s.set(value); }
  #maintenanceError$s = state<string | null>(null);
	get maintenanceError(): string | null { return this.#maintenanceError$s.get(); }
	set maintenanceError(value: string | null) { this.#maintenanceError$s.set(value); }
  #maintenanceForceConfirm$s = state(false);
	get maintenanceForceConfirm() { return this.#maintenanceForceConfirm$s.get(); }
	set maintenanceForceConfirm(value) { this.#maintenanceForceConfirm$s.set(value); }
  #maintenanceStopConfirm$s = state(false);
	get maintenanceStopConfirm() { return this.#maintenanceStopConfirm$s.get(); }
	set maintenanceStopConfirm(value) { this.#maintenanceStopConfirm$s.set(value); }
  #maintenanceRevokeId$s = state<string | null>(null);
	get maintenanceRevokeId(): string | null { return this.#maintenanceRevokeId$s.get(); }
	set maintenanceRevokeId(value: string | null) { this.#maintenanceRevokeId$s.set(value); }

  constructor(private readonly host: RemoteAdminHost) {}

  async submitPairing(raw: string): Promise<PairingProgress> {
    if (this.pairingBusy) return this.pairing;
    this.pairingBusy = true;
    this.pairing = { phase: "waiting" };
    try {
      const result = await pairFromQr(raw, { onWaiting: () => { this.pairing = { phase: "waiting" }; } });
      this.pairing = result;
      if (result.phase === "enrolled") {
        this.enrolled = true;
        this.host.start();
      }
      return result;
    } finally {
      this.pairingBusy = false;
    }
  }

  async registerUv(): Promise<boolean> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi)) return false;
    this.uvError = null;
    try {
      await api.registerUv();
      this.uvReady = true;
      return true;
    } catch {
      this.uvReady = false;
      this.uvError = "uv_failed";
      return false;
    }
  }

  async refreshHostDevices(): Promise<void> {
    const api = this.host.api;
    if (this.host.remote || !api || api instanceof RemoteApi || this.hostDevicesBusy) return;
    this.hostDevicesBusy = true;
    this.hostDevicesError = null;
    try {
      this.hostDevices = await listHostDevices(api);
    } catch (error) {
      this.hostDevicesError = error instanceof ApiError ? error.code : "request_unknown";
    } finally {
      this.hostDevicesBusy = false;
    }
  }

  async removeHostDevice(id: string): Promise<boolean> {
    const api = this.host.api;
    if (this.host.remote || !api || api instanceof RemoteApi || this.hostDevicesBusy) return false;
    this.hostDevicesBusy = true;
    this.hostDevicesError = null;
    try {
      await removeHostDevice(api, id);
      this.hostRemoveDeviceId = null;
      this.hostDevices = await listHostDevices(api);
      return true;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "request_unknown";
      // Dismissing the Touch ID sheet is changing one's mind, not a failure to report.
      if (code !== "cancelled") this.hostDevicesError = code;
      return false;
    } finally {
      this.hostDevicesBusy = false;
    }
  }

  /**
   * Registers this Mac with the person's relay, spending its one-time bootstrap token. On success
   * the status it answers with is the card's next state, so the form gives way to pairing at once.
   */
  async connectHost(relay: HostRelay): Promise<boolean> {
    const api = this.host.api;
    if (this.host.remote || !api || api instanceof RemoteApi || this.hostSetupBusy) return false;
    this.hostSetupBusy = true;
    this.hostSetupError = null;
    try {
      const status = await initializeHost(api, relay);
      this.remoteStatus = status as RuntimeSnapshot["remoteStatus"];
      return true;
    } catch (error) {
      this.hostSetupError = error instanceof ApiError ? error.code : "request_unknown";
      return false;
    } finally {
      this.hostSetupBusy = false;
    }
  }

  /**
   * Opens a pairing window on this Mac and keeps checking it. The window lasts ten minutes; the
   * card shows the code for that long, then says so rather than leaving a dead code on screen.
   */
  async startHostPairing(): Promise<void> {
    const api = this.host.api;
    if (this.hostPairingBusy || !api || api instanceof RemoteApi) return;
    this.hostPairingBusy = true;
    try {
      const offer = await openPairing(api);
      this.hostPairing = { phase: "offer", ...offer };
      void this.watchHostPairing(api, offer.pairingId);
    } catch (error) {
      this.hostPairing = { phase: "failed", error: error instanceof ApiError ? error.code : "request_unknown" };
    } finally {
      this.hostPairingBusy = false;
    }
  }

  private async watchHostPairing(api: LocalApi, pairingId: string): Promise<void> {
    while (!this.host.stopped) {
      const current = this.hostPairing;
      if (this.host.api !== api || current?.phase !== "offer" || current.pairingId !== pairingId) return;
      if (Math.floor(Date.now() / 1000) >= current.expiresUnix) {
        this.hostPairing = { phase: "failed", error: "expired" };
        return;
      }
      try {
        const waited = await readPairing(api, pairingId);
        const live = this.hostPairing;
        if (this.host.api !== api || live?.phase !== "offer" || live.pairingId !== pairingId) return;
        if (waited.phase === "confirm") {
          this.hostPairing = { ...live, phase: "confirm", name: waited.name, deviceFingerprint: waited.fingerprint, challenge: waited.challenge };
          return;
        }
      } catch (error) {
        this.hostPairing = { phase: "failed", error: error instanceof ApiError ? error.code : "request_unknown" };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, HOST_PAIRING_POLL_MS));
    }
  }

  /** The person compared the fingerprint on the device; this is the local confirmation. */
  async confirmHostPairing(): Promise<void> {
    const api = this.host.api, current = this.hostPairing;
    if (this.hostPairingBusy || !api || api instanceof RemoteApi || current?.phase !== "confirm") return;
    this.hostPairingBusy = true;
    try {
      const deviceId = await confirmPairing(api, current.pairingId, current.challenge);
      if (this.hostPairing === current) this.hostPairing = { phase: "paired", deviceId };
      await this.refreshHostDevices();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "request_unknown";
      // A dismissed or failed Touch ID sheet spent nothing; the approve button stays for another go.
      // So does a Windows without Hello set up, saying what to set up first.
      if (this.hostPairing === current && code === "hello_not_configured") {
        this.hostPairing = { ...current, note: code };
      } else if (this.hostPairing === current && code !== "cancelled" && code !== "authentication") {
        this.hostPairing = { phase: "failed", error: code };
      }
    } finally {
      this.hostPairingBusy = false;
    }
  }

  /** Closing the card abandons the window; it still expires on the host by itself. */
  closeHostPairing(): void {
    if (this.hostPairingBusy) return;
    this.hostPairing = null;
  }

  async refreshMaintenance(): Promise<void> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi)) return;
    try {
      this.maintenance = await api.remoteStatus();
      this.uvReady = api.uvReady || this.maintenance.devices.some((row) => row.id === api.enrollment.deviceId && row.hasUv);
      this.maintenanceError = null;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "request_unknown";
    }
  }

  async downloadDiagnostics(): Promise<boolean> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      const report = await api.privilegedAction({ action: "diagnostics.download", targetId: "runtime" }) as RemoteDiagnostics;
      const blob = new Blob([JSON.stringify(report)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "real-bot-diagnostics.json";
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  async restartRuntime(force = false): Promise<boolean> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      await api.privilegedAction({ action: "runtime.restart", targetId: "runtime", force });
      this.maintenanceForceConfirm = false;
      await this.refreshMaintenance();
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      await this.refreshMaintenance();
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  async stopRuntime(): Promise<boolean> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      await api.privilegedAction({ action: "runtime.stop", targetId: "runtime" });
      this.maintenanceStopConfirm = false;
      await this.refreshMaintenance();
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      await this.refreshMaintenance();
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  async revokeRemoteDevice(id: string): Promise<boolean> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      await api.privilegedAction({ action: "device.revoke", targetId: id });
      this.maintenanceRevokeId = null;
      await this.refreshMaintenance();
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      await this.refreshMaintenance();
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  otherRemoteDevices(): RemoteDeviceRow[] {
    const api = this.host.api;
    if (!(api instanceof RemoteApi) || !this.maintenance) return [];
    return this.maintenance.devices.filter((row) => row.id !== api.enrollment.deviceId && !row.revoked);
  }
}
