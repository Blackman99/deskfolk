import { isTauri } from "./tauri.ts";
import {
  AUTO_CHECK_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  IDLE_INSTALL,
  INSTALL_POLL_MS,
  cancelUpdateInstall,
  canInstallUpdate,
  checkForUpdate,
  fetchAppVersion,
  installErrorCode,
  isInstallActive,
  loadIgnoredVersion,
  openExternalUrl,
  readUpdateInstall,
  saveIgnoredVersion,
  shouldShowUpdate,
  startUpdateInstall,
  type UpdateCheck,
  type UpdateInstallState,
} from "./updates.ts";

export type UpdateStatus = "idle" | "checking" | "ok" | "error";

export class UpdateChecker {
  version = $state<string | null>(null);
  status = $state<UpdateStatus>("idle");
  result = $state<UpdateCheck | null>(null);
  ignoredVersion = $state<string | null>(null);
  /** The in-app download + install job, mirrored from the window process. */
  install = $state<UpdateInstallState>(IDLE_INSTALL);
  /** Whether this copy can replace itself at all; answered once at start. */
  canInstall = $state(false);

  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private installTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  get available(): boolean {
    return isTauri();
  }

  get updateVisible(): boolean {
    return shouldShowUpdate(this.result, this.ignoredVersion);
  }

  /** A job is running: the card shows the bar instead of the buttons. */
  get installing(): boolean {
    return isInstallActive(this.install);
  }

  /** The offered build can be installed in place rather than in the browser. */
  get installable(): boolean {
    return this.canInstall && Boolean(this.result?.downloadUrl?.endsWith(".dmg"));
  }

  start(): void {
    if (!this.available || this.started) return;
    this.started = true;
    this.ignoredVersion = loadIgnoredVersion();
    void fetchAppVersion().then((v) => {
      if (v) this.version = v;
    });
    void canInstallUpdate().then((can) => {
      this.canInstall = can;
    });
    // A job outlives this page: a reload mid-download reattaches to it.
    void readUpdateInstall().then((state) => {
      if (!state) return;
      this.install = state;
      if (isInstallActive(state)) this.watchInstall();
    });
    this.delayTimer = setTimeout(() => void this.check(false), AUTO_CHECK_DELAY_MS);
    this.intervalTimer = setInterval(() => void this.check(false), AUTO_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.delayTimer) clearTimeout(this.delayTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.delayTimer = null;
    this.intervalTimer = null;
    this.stopWatching();
    this.started = false;
  }

  async checkNow(): Promise<void> {
    await this.check(true);
  }

  private async check(force: boolean): Promise<void> {
    this.status = "checking";
    try {
      const result = await checkForUpdate(force);
      this.result = result;
      if (result.current) this.version = result.current;
      this.status = "ok";
    } catch {
      this.status = "error";
    }
  }

  ignoreLatest(): void {
    const latest = this.result?.latest;
    if (!latest) return;
    saveIgnoredVersion(latest);
    this.ignoredVersion = latest;
  }

  /**
   * Download the build and let the window process replace itself with it. The
   * app quits and comes back on its own once the swap is staged, so there is
   * no Finder step and no Gatekeeper prompt.
   */
  async startInstall(): Promise<void> {
    const url = this.result?.downloadUrl;
    const version = this.result?.latest;
    if (!url || !version || this.installing) return;
    this.install = { ...IDLE_INSTALL, phase: "downloading", version };
    try {
      this.install = await startUpdateInstall(url, version);
    } catch (error) {
      this.install = {
        ...IDLE_INSTALL,
        phase: "failed",
        version,
        error: installErrorCode(error),
      };
      return;
    }
    this.watchInstall();
  }

  /** Cancel a running download, or dismiss a failed one. */
  async cancelInstall(): Promise<void> {
    this.stopWatching();
    this.install = await cancelUpdateInstall();
  }

  private watchInstall(): void {
    this.stopWatching();
    this.installTimer = setInterval(() => {
      void readUpdateInstall().then((state) => {
        if (!state) return;
        this.install = state;
        if (!isInstallActive(state)) this.stopWatching();
      });
    }, INSTALL_POLL_MS);
  }

  private stopWatching(): void {
    if (this.installTimer) clearInterval(this.installTimer);
    this.installTimer = null;
  }

  /** The fallback when this copy cannot replace itself: the system browser. */
  async download(): Promise<boolean> {
    const url = this.result?.downloadUrl;
    return url ? openExternalUrl(url) : false;
  }

  async openNotes(): Promise<boolean> {
    const url = this.result?.releaseUrl;
    return url ? openExternalUrl(url) : false;
  }
}

export const updateChecker = new UpdateChecker();
