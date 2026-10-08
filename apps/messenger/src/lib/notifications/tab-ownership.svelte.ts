import {
  TAB_CHANNEL,
  TAB_LOCK_NAME,
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

/**
 * One browser tab's claim on the single Web Lock a Mac's link is allowed to hold. Two tabs open on
 * the same origin would otherwise both dial the relay and both hold a socket open for a phone that
 * only needed one; this is how the second one notices and steps back instead, and how a person can
 * ask a background tab to give the link up on purpose.
 */
export class TabOwnership {
  tabRole = $state<TabRole>("single");
  tabTakeoverTimeout = $state(false);
  tabChannel: BroadcastChannel | null = null;
  releaseLock: (() => void) | null = null;

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
            this.releaseLock?.();
            this.releaseLock = null;
            this.host.resetConnection();
            this.tabRole = "standby";
            try { ch.postMessage({ type: "takeover-ack" }); } catch {}
          }
        } else if (msg.type === "takeover-ack") {
          if (this.tabRole === "standby") {
            void this.acquireTabLock().then((got) => {
              if (got) {
                this.tabTakeoverTimeout = false;
                void this.host.tick();
              }
            });
          }
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
    return new Promise<boolean>((resolve) => {
      navigator.locks.request(TAB_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          this.tabRole = "standby";
          this.setupTabChannel();
          resolve(false);
          return;
        }
        this.tabRole = "owner";
        this.tabTakeoverTimeout = false;
        this.setupTabChannel();
        resolve(true);
        await new Promise<void>((held) => {
          this.releaseLock = held;
        });
      }).catch(() => {
        this.tabRole = "single";
        resolve(true);
      });
    });
  }

  async requestTabTakeover(): Promise<void> {
    if (!this.tabChannel) this.setupTabChannel();
    this.tabTakeoverTimeout = false;
    try {
      this.tabChannel?.postMessage({ type: "takeover-request" });
    } catch {}

    const timer = setTimeout(() => {
      if (this.tabRole === "standby") {
        this.tabTakeoverTimeout = true;
      }
    }, TAKEOVER_MS);

    const start = Date.now();
    while (Date.now() - start < TAKEOVER_MS) {
      const got = await this.acquireTabLock();
      if (got) {
        clearTimeout(timer);
        this.tabTakeoverTimeout = false;
        void this.host.tick();
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
