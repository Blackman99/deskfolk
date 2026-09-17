import { isTauri } from "./tauri.ts";
import {
  AUTO_CHECK_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  checkForUpdate,
  fetchAppVersion,
  loadIgnoredVersion,
  openExternalUrl,
  saveIgnoredVersion,
  shouldShowUpdate,
  type UpdateCheck,
} from "./updates.ts";

export type UpdateStatus = "idle" | "checking" | "ok" | "error";

export class UpdateChecker {
  version = $state<string | null>(null);
  status = $state<UpdateStatus>("idle");
  result = $state<UpdateCheck | null>(null);
  ignoredVersion = $state<string | null>(null);

  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  get available(): boolean {
    return isTauri();
  }

  get updateVisible(): boolean {
    return shouldShowUpdate(this.result, this.ignoredVersion);
  }

  start(): void {
    if (!this.available || this.started) return;
    this.started = true;
    this.ignoredVersion = loadIgnoredVersion();
    void fetchAppVersion().then((v) => {
      if (v) this.version = v;
    });
    this.delayTimer = setTimeout(() => void this.check(false), AUTO_CHECK_DELAY_MS);
    this.intervalTimer = setInterval(() => void this.check(false), AUTO_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.delayTimer) clearTimeout(this.delayTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.delayTimer = null;
    this.intervalTimer = null;
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
