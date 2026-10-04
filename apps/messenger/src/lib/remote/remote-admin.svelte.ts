import type { RuntimeSnapshot } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { LocalApi } from "../local-api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { SessionView } from "../session-view.svelte.ts";
import type { DraftReconnect, HostPairing, HostUnreachable } from "../runtime.svelte.ts";
import { RemoteApi, type RemoteDeviceRow, type RemoteDiagnostics, type RemoteMaintenanceStatus } from "./api.ts";
import { confirmPairing, initializeHost, listHostDevices, openPairing, readPairing, removeHostDevice, type HostDevice,
  type HostRelay } from "./pairing-host.ts";
import { pairFromQr, type PairingProgress } from "./pairing.ts";

/** A pairing window lasts ten minutes; checking it every three seconds is not a busy loop. */
const HOST_PAIRING_POLL_MS = 3000;

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client a
 * privileged call rides on, whether this page is the remote side of the link at all, whether the
 * page has been torn down, restarting the connection loop after a QR pairing, and the view a
 * discarded draft is cleared from.
 */
export interface RemoteAdminHost {
  readonly api: MessengerApi | null;
  readonly remote: boolean;
  readonly stopped: boolean;
  start(): void;
  sessionView(id: string): SessionView;
}

/**
 * Pairing a phone to this Mac, the host side of pairing a phone in, the device list, and the
 * maintenance card's restart/stop/revoke/diagnostics actions — everything a person reaches for
 * from the settings panel's remote tab, as opposed to the connection loop that keeps a link alive
 * once it exists. `MessengerRuntime` forwards every field and method here under the same public
 * names, and reaches back in through {@link RemoteAdminHost}.
 */
export class RemoteAdmin {
  pairing = $state<PairingProgress>({ phase: "scan" });
  pairingBusy = $state(false);
  /** Host side of pairing: what the settings panel shows while a device is being enrolled. */
  hostPairing = $state<HostPairing>(null);
  hostPairingBusy = $state(false);
  hostDevices = $state<HostDevice[]>([]);
  hostDevicesBusy = $state(false);
  hostDevicesError = $state<string | null>(null);
  hostRemoveDeviceId = $state<string | null>(null);
  /** The connect form: registering this Mac with a relay before anything can pair. */
  hostSetupBusy = $state(false);
  hostSetupError = $state<string | null>(null);
  enrolled = $state(false);
  hostUnreachable = $state<HostUnreachable>("runtime");
  draftReconnect = $state<DraftReconnect>(null);
  remoteStatus = $state<RuntimeSnapshot["remoteStatus"] | null>(null);
  uvReady = $state(false);
  uvError = $state<string | null>(null);
  maintenance = $state<RemoteMaintenanceStatus | null>(null);
  maintenanceBusy = $state(false);
  maintenanceError = $state<string | null>(null);
  maintenanceForceConfirm = $state(false);
  maintenanceStopConfirm = $state(false);
  maintenanceRevokeId = $state<string | null>(null);

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

  confirmDraftReconnect(): void {
    this.draftReconnect = this.draftReconnect ? { ...this.draftReconnect, confirm: true } : null;
  }

  discardDraftReconnect(): void {
    const kept = this.draftReconnect;
    if (kept) this.host.sessionView(kept.sessionId).draft = "";
    this.draftReconnect = null;
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
