import { untrack } from "svelte";
import type { AgentUsageResponse, ClaudeUsage, UsageAgent, UsageResponse } from "@real-bot/protocol";
import { USAGE_POLL_MS, usageFromLegacy } from "./usage.ts";

/** What the feed asks; Settings' API types leave the two older routes out. */
export type UsageApi = {
  usage: (refresh?: boolean) => Promise<UsageResponse>;
  claudeUsage?: (refresh?: boolean) => Promise<ClaudeUsage>;
  agentUsage?: (refresh?: boolean) => Promise<AgentUsageResponse>;
};

/**
 * Every agent's usage as the widget, the phone's page and Settings show it (ADR 0080), asked of
 * `GET /v1/usage`. A daemon from before it answers 404 there, and is asked the two routes it had
 * instead from then on.
 */
export class UsageFeed {
  /** Null until the first answer. */
  agents = $state<UsageAgent[] | null>(null);
  busy = $state(false);
  /** The latest ask failed; what is shown is the answer before it. */
  failed = $state(false);
  /** The clock the reset times are told against, moved on with every ask and every minute. */
  now = $state(Date.now());
  #legacy = false;

  async load(api: UsageApi, refresh = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.agents = (await this.#ask(api, refresh)).agents;
      this.failed = false;
    } catch {
      this.failed = true;
    } finally {
      this.busy = false;
      this.now = Date.now();
    }
  }

  async #ask(api: UsageApi, refresh: boolean): Promise<UsageResponse> {
    if (!this.#legacy) {
      try {
        return await api.usage(refresh);
      } catch (error) {
        if ((error as { status?: number } | null)?.status !== 404) throw error;
        this.#legacy = true;
      }
    }
    const [claude, others] = await Promise.all([
      api.claudeUsage?.(refresh).catch(() => null) ?? null,
      api.agentUsage?.(refresh).catch(() => null) ?? null,
    ]);
    return usageFromLegacy(claude, others);
  }

  /**
   * Asks now, then every few minutes while the window is in front (the daemon keeps answers as
   * long, so asking more often starts nothing). Returns the stop.
   */
  watch(api: UsageApi): () => void {
    let last = 0;
    const tick = () => {
      this.now = Date.now();
      if (document.visibilityState !== "visible" || this.now - last < USAGE_POLL_MS) return;
      last = this.now;
      void this.load(api, false);
    };
    // Read and written here: tracked by the effect that starts this, every answer would ask again.
    untrack(tick);
    const timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }
}

const feeds = new WeakMap<object, UsageFeed>();

/** The one feed of a window's runtime: the widget and the phone's page read the same answers. */
export function usageFeedOf(owner: object): UsageFeed {
  let feed = feeds.get(owner);
  if (!feed) {
    feed = new UsageFeed();
    feeds.set(owner, feed);
  }
  return feed;
}
