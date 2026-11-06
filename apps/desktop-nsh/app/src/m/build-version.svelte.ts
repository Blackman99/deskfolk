// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: b5e7ebbc6049295c
import { state } from "../lib/reactive";
import { BUILD_POLL_MS, offersRefresh, publishedVersion } from "./build-version.ts";

/** Reads the deployed `version.json`; injected so a test answers without a server. */
export type VersionReader = () => Promise<unknown>;

/**
 * Polls for a newer build and remembers what the person already waved off. Nothing here reloads
 * the page: the notice offers, the person decides.
 */
export class BuildUpdates {
  #published$s = state<string | null>(null);
	get published(): string | null { return this.#published$s.get(); }
	set published(value: string | null) { this.#published$s.set(value); }
  #dismissed$s = state<string | null>(null);
	get dismissed(): string | null { return this.#dismissed$s.get(); }
	set dismissed(value: string | null) { this.#dismissed$s.set(value); }

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
