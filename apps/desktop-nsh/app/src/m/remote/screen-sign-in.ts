import { REMOTE_DB, REMOTE_STORE, type StoredEnrollment } from "./idb.ts";

/** The Mac account Screen Sharing asked for, kept after it let this phone in once. */
export type ScreenSignIn = { username?: string; password: string };

type Row = { hostId: string; deviceId: string; username?: string; password: string };

/**
 * Where a remembered sign-in lives: next to this device's pairing keys, in the same IndexedDB
 * store under a key of its own (the pairing row itself takes no application data). It is kept for
 * the Mac and the pairing it was typed under — a phone paired again, or to another Mac, starts
 * over — and dropped the moment Screen Sharing refuses it.
 */
export type SignInDriver = {
  get(): Promise<unknown>;
  set(row: Row): Promise<void>;
  remove(): Promise<void>;
};

const KEY = "screen-sign-in";

function memoryDriver(): SignInDriver {
  let row: Row | null = null;
  return {
    async get() { return row; },
    async set(next) { row = next; },
    async remove() { row = null; },
  };
}

function idbDriver(): SignInDriver {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(REMOTE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(REMOTE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = work(db.transaction(REMOTE_STORE, mode).objectStore(REMOTE_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () => run("readonly", (store) => store.get(KEY)),
    set: async (row) => { await run("readwrite", (store) => store.put(row, KEY)); },
    remove: async () => { await run("readwrite", (store) => store.delete(KEY)); },
  };
}

let driver: SignInDriver | null = null;
let fallback: SignInDriver | null = null;

export function useSignInDriver(next: SignInDriver | null): void {
  driver = next;
}

function activeDriver(): SignInDriver {
  if (driver) return driver;
  if (typeof indexedDB === "undefined") return (fallback ??= memoryDriver());
  return idbDriver();
}

export type RememberedSignIn = {
  load(): Promise<ScreenSignIn | null>;
  save(signIn: ScreenSignIn): Promise<void>;
  forget(): Promise<void>;
};

/** The remembered sign-in for this pairing. Storage that fails is a sign-in that is asked for again. */
export function rememberedSignIn(enrollment: Pick<StoredEnrollment, "hostId" | "deviceId">): RememberedSignIn {
  return {
    async load() {
      try {
        const row = (await activeDriver().get()) as Partial<Row> | null;
        if (!row || row.hostId !== enrollment.hostId || row.deviceId !== enrollment.deviceId || typeof row.password !== "string") return null;
        return { ...(typeof row.username === "string" ? { username: row.username } : {}), password: row.password };
      } catch {
        return null;
      }
    },
    async save(signIn) {
      try {
        await activeDriver().set({ hostId: enrollment.hostId, deviceId: enrollment.deviceId, ...signIn });
      } catch {
        // Not remembered; asked again next time.
      }
    },
    async forget() {
      try {
        await activeDriver().remove();
      } catch {
        // Nothing stored to forget.
      }
    },
  };
}
