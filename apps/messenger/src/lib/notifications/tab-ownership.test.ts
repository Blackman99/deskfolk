import { afterEach, beforeEach, expect, test } from "bun:test";
import { TabOwnership } from "./tab-ownership.svelte.ts";

type Request = {
  options: LockOptions;
  callback: (lock: Lock | null) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/** One browser's lock manager, as the spec has it: a line, `ifAvailable`, `signal` and `steal`. */
class Locks {
  holder: Request | null = null;
  line: Request[] = [];

  request(_name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req: Request = { options, callback, resolve, reject };
      if (options.steal) {
        this.holder?.reject(new DOMException("stolen", "AbortError"));
        this.holder = null;
        this.grant(req);
      } else if (!this.holder && this.line.length === 0) {
        this.grant(req);
      } else if (options.ifAvailable) {
        Promise.resolve(callback(null)).then(resolve, reject);
      } else {
        this.line.push(req);
        options.signal?.addEventListener("abort", () => {
          if (!this.line.includes(req)) return;
          this.line = this.line.filter((r) => r !== req);
          reject(new DOMException("aborted", "AbortError"));
        });
      }
    });
  }

  grant(req: Request): void {
    this.holder = req;
    Promise.resolve(req.callback({ name: "lock", mode: "exclusive" } as Lock)).then((value) => {
      if (this.holder !== req) return;
      req.resolve(value);
      this.free();
    });
  }

  /** The tab holding the lock closed, or its page died: the browser frees what it held. */
  free(): void {
    this.holder = null;
    const next = this.line.shift();
    if (next) this.grant(next);
  }
}

/** A BroadcastChannel between the tabs here; a stuck tab hears nothing. */
class Channel {
  static open: Channel[] = [];
  static stuck = new Set<Channel>();
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    Channel.open.push(this);
  }
  postMessage(data: unknown): void {
    for (const other of Channel.open) {
      if (other === this || other.name !== this.name || Channel.stuck.has(other)) continue;
      setTimeout(() => other.onmessage?.({ data }), 0);
    }
  }
  close(): void {}
}

const realLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
const realChannel = globalThis.BroadcastChannel;
let locks: Locks;
let owners: TabOwnership[] = [];

beforeEach(() => {
  locks = new Locks();
  Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
  globalThis.BroadcastChannel = Channel as unknown as typeof BroadcastChannel;
  Channel.open = [];
  Channel.stuck.clear();
  owners = [];
});

afterEach(() => {
  // A tab that answered a takeover gets back in line TAKEOVER_MS later, long after its test: by then
  // the real navigator.locks is back (null under happy-dom) and the request throws in whichever test
  // file runs then. A tab that is no longer in line does not ask.
  for (const owner of owners) owner.tabRole = "single";
  if (realLocks) Object.defineProperty(globalThis.navigator, "locks", realLocks);
  else delete (globalThis.navigator as { locks?: unknown }).locks;
  globalThis.BroadcastChannel = realChannel;
});

function tab() {
  const calls = { ticks: 0, resets: 0 };
  const owner = new TabOwnership({
    resetConnection: () => { calls.resets += 1; },
    tick: async () => { calls.ticks += 1; },
    dispatchNotificationIntent: () => {},
  });
  owners.push(owner);
  return { owner, calls };
}

const settle = (ms = 5) => new Promise((done) => setTimeout(done, ms));

test("a tab that stepped back takes the link once the tab holding it goes", async () => {
  const a = tab(), b = tab();
  expect(await a.owner.acquireTabLock()).toBe(true);
  expect(await b.owner.acquireTabLock()).toBe(false);
  expect(b.owner.tabRole).toBe("standby");

  locks.free();
  await settle();
  expect(b.owner.tabRole).toBe("owner");
  expect(b.calls.ticks).toBe(1);
});

test("a takeover takes the link from a tab that never answers", async () => {
  const a = tab(), b = tab();
  await a.owner.acquireTabLock();
  Channel.stuck.add(a.owner.tabChannel as unknown as Channel);
  await b.owner.acquireTabLock();

  await b.owner.requestTabTakeover();
  expect(b.owner.tabRole).toBe("owner");
  expect(b.owner.tabTakeoverTimeout).toBe(false);
  expect(b.calls.ticks).toBe(1);

  // The stuck tab, once it runs again, has lost the lock: it drops its link and waits in line.
  await settle();
  expect(a.owner.tabRole).toBe("standby");
  expect(a.calls.resets).toBe(1);
  locks.free();
  await settle();
  expect(a.owner.tabRole).toBe("owner");
});

test("a tab that answers lets go first, and does not take the lock straight back", async () => {
  const a = tab(), b = tab();
  await a.owner.acquireTabLock();
  await b.owner.acquireTabLock();

  await b.owner.requestTabTakeover();
  await settle(20);
  expect(b.owner.tabRole).toBe("owner");
  expect(a.owner.tabRole).toBe("standby");
  expect(a.calls.resets).toBe(1);
  expect(a.calls.ticks).toBe(0);
});
