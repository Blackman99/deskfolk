import { KEYCHAIN_NAME, KEYCHAIN_SERVICE } from "@real-bot/protocol";
import type { EndpointKeyStore } from "./store";

function secretName(name?: string): string {
  return name && name.length > 0 ? name : KEYCHAIN_NAME;
}

/** One OS credential entry per name under a fixed service: the shape `Bun.secrets` offers. */
export type SecretBackend = {
  /** null when there is no such entry; rejects when the entry exists but could not be read. */
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
};

export function bunSecretBackend(service: string): SecretBackend {
  return {
    get: (name) => Bun.secrets.get({ service, name }),
    set: (name, value) => Bun.secrets.set({ service, name, value, allowUnrestrictedAccess: false }),
    async delete(name) {
      await Bun.secrets.delete({ service, name });
    },
  };
}

/** Each credential in its own entry. Used where the OS store never asks the person (Windows, Linux). */
export function perNameKeyStore(backend: SecretBackend): EndpointKeyStore {
  return {
    async get(name) {
      try {
        return await backend.get(secretName(name));
      } catch {
        return null;
      }
    },
    async set(value, name) {
      await backend.set(secretName(name), value);
    },
    async delete(name) {
      await backend.delete(secretName(name));
    },
  };
}

/** The single Keychain entry every credential lives in on macOS (ADR 0034). */
export const KEYCHAIN_BUNDLE_NAME = "credentials";

type Bundle = {
  v: 1;
  keys: Record<string, string>;
  /** Names already settled against their old per-name entry, so a deleted key never comes back from it. */
  migrated: string[];
};

function parseBundle(raw: string | null): Bundle {
  if (raw == null) return { v: 1, keys: {}, migrated: [] };
  const parsed = JSON.parse(raw) as Partial<Bundle> | null;
  const keys = parsed?.keys;
  const migrated = parsed?.migrated;
  if (
    parsed?.v !== 1 ||
    typeof keys !== "object" || keys === null || Array.isArray(keys) ||
    Object.values(keys).some((value) => typeof value !== "string") ||
    !Array.isArray(migrated) || migrated.some((name) => typeof name !== "string")
  ) {
    // A newer build's layout, or damage: never overwrite what this build cannot read.
    throw new Error("credential entry has an unknown layout");
  }
  return { v: 1, keys: { ...keys }, migrated: [...migrated] };
}

function settled(bundle: Bundle, name: string): string[] {
  return bundle.migrated.includes(name) ? bundle.migrated : [...bundle.migrated, name];
}

/**
 * Every credential in one entry. An ad-hoc signed daemon is a new program to the Keychain after every
 * update, so each entry it reads asks the person for their password again; one entry makes that one
 * prompt instead of one per endpoint and MCP server. Names written before this existed are read from
 * their old entry once and folded in; the old entry stays so an older build still finds it, until the
 * key is changed or deleted here.
 */
export function bundledKeyStore(backend: SecretBackend, entry = KEYCHAIN_BUNDLE_NAME): EndpointKeyStore {
  let bundle: Bundle | null = null;
  let loading: Promise<Bundle> | null = null;
  // A denied or failed read is not asked again for reads, so dismissing the prompt stays dismissed; a
  // write asks again, because it must not replace an entry it could not see.
  let unreadable = false;
  let queue: Promise<unknown> = Promise.resolve();
  const legacyReads = new Map<string, Promise<string | null>>();

  function load(): Promise<Bundle> {
    if (bundle) return Promise.resolve(bundle);
    loading ??= backend
      .get(entry)
      .then(parseBundle)
      .then(
        (loaded) => {
          bundle = loaded;
          unreadable = false;
          return loaded;
        },
        (error) => {
          unreadable = true;
          throw error;
        },
      )
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  }

  async function save(next: Bundle): Promise<void> {
    await backend.set(entry, JSON.stringify(next));
    bundle = next;
  }

  async function dropLegacy(name: string): Promise<void> {
    try {
      await backend.delete(name);
    } catch {
      // The new entry already holds the truth, and `migrated` keeps the old one from being read again.
    }
  }

  function readLegacy(name: string): Promise<string | null> {
    let read = legacyReads.get(name);
    if (!read) {
      read = backend.get(name).catch(() => null).finally(() => legacyReads.delete(name));
      legacyReads.set(name, read);
    }
    return read;
  }

  return {
    async get(name) {
      const key = secretName(name);
      if (unreadable && !bundle) return null;
      let current: Bundle;
      try {
        current = await load();
      } catch {
        return null;
      }
      if (Object.hasOwn(current.keys, key)) return current.keys[key]!;
      if (current.migrated.includes(key)) return null;
      const legacy = await readLegacy(key);
      if (legacy == null) return null;
      try {
        await exclusive(async () => {
          const latest = await load();
          if (Object.hasOwn(latest.keys, key) || latest.migrated.includes(key)) return;
          await save({ v: 1, keys: { ...latest.keys, [key]: legacy }, migrated: settled(latest, key) });
        });
      } catch {
        // Still usable for this run; the fold is tried again next time.
      }
      return bundle && Object.hasOwn(bundle.keys, key) ? bundle.keys[key]! : legacy;
    },
    async set(value, name) {
      const key = secretName(name);
      await exclusive(async () => {
        const latest = await load();
        await save({ v: 1, keys: { ...latest.keys, [key]: value }, migrated: settled(latest, key) });
      });
      await dropLegacy(key);
    },
    async delete(name) {
      const key = secretName(name);
      await exclusive(async () => {
        const latest = await load();
        if (!Object.hasOwn(latest.keys, key) && latest.migrated.includes(key)) return;
        const keys = { ...latest.keys };
        delete keys[key];
        await save({ v: 1, keys, migrated: settled(latest, key) });
      });
      await dropLegacy(key);
    },
  };
}

export const bunKeyStore: EndpointKeyStore =
  process.platform === "darwin"
    ? bundledKeyStore(bunSecretBackend(KEYCHAIN_SERVICE))
    : perNameKeyStore(bunSecretBackend(KEYCHAIN_SERVICE));

export function memoryKeyStore(initial: string | null = null): EndpointKeyStore {
  const values = new Map<string, string>();
  if (initial !== null) values.set(KEYCHAIN_NAME, initial);
  return {
    async get(name) {
      return values.get(secretName(name)) ?? null;
    },
    async set(next, name) {
      values.set(secretName(name), next);
    },
    async delete(name) {
      values.delete(secretName(name));
    },
  };
}
