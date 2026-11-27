import { state } from "../../lib/reactive";
import { untrack } from "../../lib/reactive";
import type { AgentUsageResponse, ClaudeUsage, UsageAgent, UsageResponse } from "@real-bot/protocol";
import { USAGE_FOLLOW_LIMIT_MS, USAGE_FOLLOW_MS, USAGE_POLL_MS, usageFromLegacy } from "./usage.ts";

/** What the feed asks; Settings' API types leave the two older routes out. */
export type UsageApi = {
  /** `quick`: at once, each account still being asked marked `pending` (`GET /v1/usage?wait=0`). */
  usage: (refresh?: boolean, quick?: boolean) => Promise<UsageResponse>;
  claudeUsage?: (refresh?: boolean) => Promise<ClaudeUsage>;
  agentUsage?: (refresh?: boolean) => Promise<AgentUsageResponse>;
};

/** Some account in it is still being asked. */
const stillAsked = (answer: UsageResponse) => answer.agents.some((agent) => agent.accounts.some((account) => account.pending === true));

/** In a row, asking again while following fails this many times before it stops. */
const FOLLOW_MISSES = 3;

/**
 * Every agent's usage as the widget, the phone's page and Settings show it (ADR 0080), asked of
 * `GET /v1/usage`. It asks for what is known at once (`wait=0`), then asks again every
 * `USAGE_FOLLOW_MS` while some account is still being asked, so each card fills as its own answer
 * comes and none waits for the slowest (2026-11-27 addendum). A daemon from before `wait=0` gives
 * its whole answer, marking nothing pending; a phone's refuses the query, and is asked without it
 * from then on. A daemon from before ADR 0080 answers 404, and is asked the two routes it had.
 */
export class UsageFeed {
  /** Null until the first answer. */
  #agents$s = state<UsageAgent[] | null>(null);
	get agents(): UsageAgent[] | null { return this.#agents$s.get(); }
	set agents(value: UsageAgent[] | null) { this.#agents$s.set(value); }
  /** Asking: the first answer, or accounts still being asked after it. */
  #busy$s = state(false);
	get busy() { return this.#busy$s.get(); }
	set busy(value) { this.#busy$s.set(value); }
  /** The latest ask failed; what is shown is the answer before it. */
  #failed$s = state(false);
	get failed() { return this.#failed$s.get(); }
	set failed(value) { this.#failed$s.set(value); }
  /** The clock the reset times are told against, moved on with every ask and every minute. */
  #now$s = state(Date.now());
	get now() { return this.#now$s.get(); }
	set now(value) { this.#now$s.set(value); }
  #legacy = false;
  /** The daemon refused `wait=0`: its whole answer is waited for. */
  #whole = false;
  /** The answer shown, as text: one that says the same again changes nothing on screen. */
  #shown = "";

  async load(api: UsageApi, refresh = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let answer: UsageResponse;
      try {
        answer = await this.#ask(api, refresh, true);
      } catch {
        this.failed = true;
        return;
      }
      this.#take(answer);
      this.failed = false;
      // Each account still being asked fills its card when its own answer comes.
      const until = Date.now() + USAGE_FOLLOW_LIMIT_MS;
      let misses = 0;
      while (stillAsked(answer)) {
        if (Date.now() >= until || misses >= FOLLOW_MISSES) {
          this.#giveUp();
          this.failed = misses >= FOLLOW_MISSES;
          break;
        }
        await new Promise((done) => setTimeout(done, USAGE_FOLLOW_MS));
        try {
          answer = await this.#ask(api, false, true);
          misses = 0;
          this.#take(answer);
        } catch {
          misses += 1;
        }
      }
    } finally {
      this.busy = false;
      this.now = Date.now();
    }
  }

  #take(answer: UsageResponse): void {
    const text = JSON.stringify(answer.agents);
    if (this.agents && text === this.#shown) return;
    this.#shown = text;
    this.agents = answer.agents;
  }

  /** Stops waiting on the accounts still asked: one with no answer at all says it could not be read. */
  #giveUp(): void {
    if (!this.agents) return;
    this.agents = this.agents.map((agent) => ({
      ...agent,
      accounts: agent.accounts.map((account) =>
        account.pending
          ? { ...account, pending: false, ...(account.checked_at === null && account.windows.length === 0 ? { reason: "failed" as const } : {}) }
          : account),
    }));
    this.#shown = JSON.stringify(this.agents);
  }

  async #ask(api: UsageApi, refresh: boolean, quick: boolean): Promise<UsageResponse> {
    if (!this.#legacy) {
      try {
        return await api.usage(refresh, quick && !this.#whole);
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        if (quick && !this.#whole && status === 422) {
          this.#whole = true;
          return this.#ask(api, refresh, quick);
        }
        if (status !== 404) throw error;
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
