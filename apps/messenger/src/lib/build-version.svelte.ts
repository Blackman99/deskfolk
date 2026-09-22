import { BUILD_POLL_MS, offersRefresh, publishedVersion } from "./build-version.ts";

/** Reads the deployed `version.json`; injected so a test answers without a server. */
export type VersionReader = () => Promise<unknown>;

/**
 * Polls for a newer build and remembers what the person already waved off. Nothing here reloads
 * the page: the notice offers, the person decides.
 */
export class BuildUpdates {
  published = $state<string | null>(null);
  dismissed = $state<string | null>(null);

  private readonly running: string;
  private readonly read: VersionReader;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(running: string, read: VersionReader) {
    this.running = running;
    this.read = read;
  }

  get offered(): boolean {
    return offersRefresh(this.running, this.published, this.dismissed);
  }

  /**
   * Starts polling and returns the stop. A backgrounded phone freezes its timers, so coming back
   * to the page checks straight away rather than waiting out an interval that never ran.
   */
  start(): () => void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), BUILD_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void this.poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      this.stop();
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A failed check is not news — offline, or the server caught mid-deploy. Keep what we have. */
  async poll(): Promise<void> {
    try {
      const found = publishedVersion(await this.read());
      if (found) this.published = found;
    } catch {
      /* the page keeps running the build it already has */
    }
  }

  dismiss(): void {
    this.dismissed = this.published;
  }
}
