// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 0a778c4b788a7517
import { state } from "../../lib/reactive";
import {
  TAB_CHANNEL,
  TAB_LOCK_NAME,
  TAKEOVER_ANSWER_MS,
  TAKEOVER_MS,
  type TabControlMessage,
  type TabRole,
  isTabControlMessage,
  supportsWebLocks,
} from "./tab-owner.ts";

/** Where a notification, or an "inbox" broadcast, should take the person: a conversation, a message, or the inbox. */
export type NotificationOpenIntent = { sessionId?: string | null; messageId?: string | null; openInbox: boolean };

/**
 * What this sub-store reaches back into the runtime for: the connection loop a takeover has to
 * restart, and the notification queue an "inbox" broadcast or a completed takeover has to reach.
 * Read at call time, never cached — a takeover can happen long after this object was built.
 */
export interface TabOwnershipHost {
  resetConnection(): void;
  tick(): Promise<void>;
  dispatchNotificationIntent(intent: NotificationOpenIntent): void;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * One browser tab's claim on the single Web Lock a Mac's link is allowed to hold. Two tabs open on
 * the same origin would otherwise both dial the relay and both hold a socket open for a phone that
 * only needed one; this is how the second one notices and steps back instead, and how a person can
 * ask a background tab to give the link up on purpose.
 *
 * A tab that stepped back waits in line for the lock, so it takes the link the moment the tab
 * holding it closes or dies. It used to try once and then wait for a press: a tab stuck on a page
 * kept the lock, every tab opened after it read "connected in another tab", and the takeover
 * asked the stuck tab to let go, which it never answered.
 */
export class TabOwnership {
  #tabRole$s = state<TabRole>("single");
	get tabRole(): TabRole { return this.#tabRole$s.get(); }
	set tabRole(value: TabRole) { this.#tabRole$s.set(value); }
  #tabTakeoverTimeout$s = state(false);
	get tabTakeoverTimeout() { return this.#tabTakeoverTimeout$s.get(); }
	set tabTakeoverTimeout(value) { this.#tabTakeoverTimeout$s.set(value); }
  tabChannel: BroadcastChannel | null = null;
  releaseLock: (() => void) | null = null;
  /** The newest lock request this tab still wants. One granted or taken after it is no longer this tab's concern. */
  #want = 0;
  #seq = 0;
  /** The request a stepped-back tab waits in line with. */
  #waiting: AbortController | null = null;
  #answered: (() => void) | null = null;

  constructor(private readonly host: TabOwnershipHost) {}

  setupTabChannel(): void {
    if (typeof BroadcastChannel === "undefined") return;
    if (this.tabChannel) return;
    try {
      const ch = new BroadcastChannel(TAB_CHANNEL);
      this.tabChannel = ch;
      ch.onmessage = (ev) => {
        if (!isTabControlMessage(ev.data)) return;
        const msg = ev.data as TabControlMessage;
        if (msg.type === "inbox") {
          this.host.dispatchNotificationIntent({ openInbox: true });
        } else if (msg.type === "takeover-request") {
          if (this.tabRole === "owner") {
            this.#want = 0;
            this.releaseLock?.();
            this.releaseLock = null;
            this.host.resetConnection();
            this.tabRole = "standby";
            try { ch.postMessage({ type: "takeover-ack" }); } catch {}
            // Back in line once the asking tab has had its turn: straight away, the lock just let
            // go of would come straight back here.
            this.#wait(TAKEOVER_MS);
          }
        } else if (msg.type === "takeover-ack") {
          this.#answered?.();
        }
      };
    } catch {
      // BroadcastChannel not available in this environment
    }
  }

  async acquireTabLock(): Promise<boolean> {
    if (typeof navigator === "undefined" || !supportsWebLocks(navigator.locks)) {
      this.tabRole = "single";
      return true;
    }
    const got = await this.#hold({ ifAvailable: true });
    if (!got) {
      this.tabRole = "standby";
      this.setupTabChannel();
      this.#wait();
    }
    return got;
  }

  async requestTabTakeover(): Promise<void> {
    if (typeof navigator === "undefined" || !supportsWebLocks(navigator.locks)) return;
    if (!this.tabChannel) this.setupTabChannel();
    this.tabTakeoverTimeout = false;
    // Asked first, a tab that still answers closes its link before this one opens.
    const answered = new Promise<void>((done) => {
      this.#answered = done;
    });
    try {
      this.tabChannel?.postMessage({ type: "takeover-request" });
    } catch {}
    await Promise.race([answered, new Promise((done) => setTimeout(done, TAKEOVER_ANSWER_MS))]);
    this.#answered = null;
    // The line this tab waited in may have handed it the lock as the other tab let go.
    if (this.tabRole === "owner") return;
    // A tab that never answers (stuck on a page, or frozen in the background) holds the lock until
    // it is closed: take it from it.
    this.#waiting?.abort();
    this.#waiting = null;
    if (await this.#hold({ steal: true })) void this.host.tick();
    else this.tabTakeoverTimeout = true;
  }

  /** Waits in line for the lock, and connects once it comes. */
  #wait(delayMs = 0): void {
    if (this.#waiting) return;
    const waiting = new AbortController();
    this.#waiting = waiting;
    const join = () => {
      if (waiting.signal.aborted || this.tabRole !== "standby") {
        if (this.#waiting === waiting) this.#waiting = null;
        return;
      }
      void this.#hold({ signal: waiting.signal }).then((got) => {
        if (this.#waiting === waiting) this.#waiting = null;
        if (got) void this.host.tick();
      });
    };
    if (delayMs > 0) setTimeout(join, delayMs);
    else join();
  }

  /** The tab holding the lock now is another one, which took it from this one. */
  #lost(): void {
    this.releaseLock = null;
    this.host.resetConnection();
    this.tabRole = "standby";
    this.#wait();
  }

  /** Requests the lock and holds it until let go; resolves whether this tab holds it now. */
  #hold(options: LockOptions): Promise<boolean> {
    const id = ++this.#seq;
    this.#want = id;
    return new Promise<boolean>((resolve) => {
      let granted = false;
      navigator.locks.request(TAB_LOCK_NAME, options, async (lock) => {
        if (!lock || id !== this.#want) {
          resolve(false);
          return;
        }
        granted = true;
        this.tabRole = "owner";
        this.tabTakeoverTimeout = false;
        this.setupTabChannel();
        resolve(true);
        await new Promise<void>((held) => {
          this.releaseLock = held;
        });
      }).catch((error: unknown) => {
        if (granted) {
          if (id === this.#want && isAbort(error)) this.#lost();
          return;
        }
        if (isAbort(error)) {
          resolve(false);
          return;
        }
        // Locks refused outright (an opaque origin, say): this tab is the only one there is.
        this.tabRole = "single";
        resolve(true);
      });
    });
  }
}
