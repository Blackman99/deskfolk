import { describe, expect, test } from "bun:test";
import { KEYCHAIN_NAME } from "@real-bot/protocol";
import { bundledKeyStore, KEYCHAIN_BUNDLE_NAME, perNameKeyStore, type SecretBackend } from "./secrets";

/** A Keychain stand-in: each `get` of an entry that exists is one prompt for an ad-hoc signed daemon. */
function fakeKeychain(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: string[] = [];
  const deletes: string[] = [];
  const denied = new Set<string>();
  const failDelete = new Set<string>();
  const backend: SecretBackend = {
    async get(name) {
      reads.push(name);
      await Promise.resolve();
      if (denied.has(name)) throw new Error("Keychain access denied");
      return entries.get(name) ?? null;
    },
    async set(name, value) {
      writes.push(name);
      await Promise.resolve();
      entries.set(name, value);
    },
    async delete(name) {
      deletes.push(name);
      if (failDelete.has(name)) throw new Error("delete refused");
      entries.delete(name);
    },
  };
  const bundle = () => {
    const raw = entries.get(KEYCHAIN_BUNDLE_NAME);
    return raw ? JSON.parse(raw) : null;
  };
  return { backend, entries, reads, writes, deletes, denied, failDelete, bundle };
}

describe("bundledKeyStore", () => {
  test("every credential comes out of one Keychain read, even when asked for together", async () => {
    const kc = fakeKeychain({
      [KEYCHAIN_BUNDLE_NAME]: JSON.stringify({
        v: 1,
        keys: { "endpoint-api-key:a": "sk-a", "endpoint-api-key:b": "sk-b", "mcp-auth:m": "Bearer m" },
        migrated: ["endpoint-api-key:a", "endpoint-api-key:b", "mcp-auth:m"],
      }),
    });
    const store = bundledKeyStore(kc.backend);
    const values = await Promise.all([
      store.get("endpoint-api-key:a"),
      store.get("endpoint-api-key:b"),
      store.get("mcp-auth:m"),
      store.get("endpoint-api-key:a"),
    ]);
    expect(values).toEqual(["sk-a", "sk-b", "Bearer m", "sk-a"]);
    expect(kc.reads).toEqual([KEYCHAIN_BUNDLE_NAME]);
    expect(kc.writes).toEqual([]);
  });

  test("a Mac that never stored a key writes nothing", async () => {
    const kc = fakeKeychain();
    const store = bundledKeyStore(kc.backend);
    expect(await store.get("endpoint-api-key:a")).toBeNull();
    expect(await store.get()).toBeNull();
    expect(kc.writes).toEqual([]);
    expect(kc.entries.size).toBe(0);
  });

  test("a written key survives a restart and leaves one entry", async () => {
    const kc = fakeKeychain();
    await bundledKeyStore(kc.backend).set("sk-a", "endpoint-api-key:a");
    await bundledKeyStore(kc.backend).set("Bearer m", "mcp-auth:m");
    const restarted = bundledKeyStore(kc.backend);
    expect(await restarted.get("endpoint-api-key:a")).toBe("sk-a");
    expect(await restarted.get("mcp-auth:m")).toBe("Bearer m");
    expect([...kc.entries.keys()]).toEqual([KEYCHAIN_BUNDLE_NAME]);
  });

  test("the unnamed key is the legacy single-endpoint name", async () => {
    const kc = fakeKeychain();
    const store = bundledKeyStore(kc.backend);
    await store.set("sk-old");
    expect(kc.bundle().keys).toEqual({ [KEYCHAIN_NAME]: "sk-old" });
    expect(await store.get(KEYCHAIN_NAME)).toBe("sk-old");
  });

  test("keys from before the single entry are read once, folded in, and kept for older builds", async () => {
    const kc = fakeKeychain({ "endpoint-api-key:a": "sk-a", "mcp-auth:m": "Bearer m" });
    const first = bundledKeyStore(kc.backend);
    expect(await first.get("endpoint-api-key:a")).toBe("sk-a");
    expect(await first.get("mcp-auth:m")).toBe("Bearer m");
    expect(kc.bundle()).toEqual({
      v: 1,
      keys: { "endpoint-api-key:a": "sk-a", "mcp-auth:m": "Bearer m" },
      migrated: ["endpoint-api-key:a", "mcp-auth:m"],
    });
    expect(kc.entries.get("endpoint-api-key:a")).toBe("sk-a");
    expect(kc.deletes).toEqual([]);

    kc.reads.length = 0;
    const next = bundledKeyStore(kc.backend);
    expect(await next.get("endpoint-api-key:a")).toBe("sk-a");
    expect(await next.get("mcp-auth:m")).toBe("Bearer m");
    expect(kc.reads).toEqual([KEYCHAIN_BUNDLE_NAME]);
  });

  test("two reads of the same old key ask once", async () => {
    const kc = fakeKeychain({ "endpoint-api-key:a": "sk-a" });
    const store = bundledKeyStore(kc.backend);
    expect(await Promise.all([store.get("endpoint-api-key:a"), store.get("endpoint-api-key:a")])).toEqual(["sk-a", "sk-a"]);
    expect(kc.reads.filter((name) => name === "endpoint-api-key:a")).toHaveLength(1);
  });

  test("a deleted key stays deleted even when its old entry could not be removed", async () => {
    const kc = fakeKeychain({ "endpoint-api-key:a": "sk-a" });
    kc.failDelete.add("endpoint-api-key:a");
    const store = bundledKeyStore(kc.backend);
    expect(await store.get("endpoint-api-key:a")).toBe("sk-a");
    await store.delete("endpoint-api-key:a");
    expect(await store.get("endpoint-api-key:a")).toBeNull();
    expect(kc.entries.get("endpoint-api-key:a")).toBe("sk-a");

    kc.reads.length = 0;
    expect(await bundledKeyStore(kc.backend).get("endpoint-api-key:a")).toBeNull();
    expect(kc.reads).toEqual([KEYCHAIN_BUNDLE_NAME]);
  });

  test("deleting a key that was never folded in still settles its old entry", async () => {
    const kc = fakeKeychain({ "endpoint-api-key:a": "sk-a" });
    kc.failDelete.add("endpoint-api-key:a");
    await bundledKeyStore(kc.backend).delete("endpoint-api-key:a");
    expect(await bundledKeyStore(kc.backend).get("endpoint-api-key:a")).toBeNull();
  });

  test("changing a key removes its old entry", async () => {
    const kc = fakeKeychain({ "endpoint-api-key:a": "sk-a" });
    const store = bundledKeyStore(kc.backend);
    await store.set("sk-new", "endpoint-api-key:a");
    expect(kc.entries.has("endpoint-api-key:a")).toBe(false);
    expect(await bundledKeyStore(kc.backend).get("endpoint-api-key:a")).toBe("sk-new");
  });

  test("keys written together are all kept", async () => {
    const kc = fakeKeychain();
    const store = bundledKeyStore(kc.backend);
    await Promise.all([
      store.set("sk-a", "endpoint-api-key:a"),
      store.set("sk-b", "endpoint-api-key:b"),
      store.set("Bearer m", "mcp-auth:m"),
    ]);
    expect(kc.bundle().keys).toEqual({ "endpoint-api-key:a": "sk-a", "endpoint-api-key:b": "sk-b", "mcp-auth:m": "Bearer m" });
  });

  test("a denied prompt is not asked again by reads, and a write never replaces what it could not read", async () => {
    const before = JSON.stringify({ v: 1, keys: { "endpoint-api-key:a": "sk-a" }, migrated: ["endpoint-api-key:a"] });
    const kc = fakeKeychain({ [KEYCHAIN_BUNDLE_NAME]: before });
    kc.denied.add(KEYCHAIN_BUNDLE_NAME);
    const store = bundledKeyStore(kc.backend);
    expect(await store.get("endpoint-api-key:a")).toBeNull();
    expect(await store.get("endpoint-api-key:b")).toBeNull();
    expect(kc.reads).toEqual([KEYCHAIN_BUNDLE_NAME]);

    await expect(store.set("sk-b", "endpoint-api-key:b")).rejects.toThrow("denied");
    expect(kc.entries.get(KEYCHAIN_BUNDLE_NAME)).toBe(before);
    expect(kc.writes).toEqual([]);

    kc.denied.clear();
    await store.set("sk-b", "endpoint-api-key:b");
    expect(kc.bundle().keys).toEqual({ "endpoint-api-key:a": "sk-a", "endpoint-api-key:b": "sk-b" });
  });

  test("an entry in a layout this build does not know is left alone", async () => {
    for (const raw of ["{not json", JSON.stringify({ v: 2, keys: {}, migrated: [] }), JSON.stringify({ v: 1, keys: { a: 1 }, migrated: [] })]) {
      const kc = fakeKeychain({ [KEYCHAIN_BUNDLE_NAME]: raw });
      const store = bundledKeyStore(kc.backend);
      expect(await store.get("a")).toBeNull();
      await expect(store.set("sk", "a")).rejects.toThrow();
      await expect(store.delete("a")).rejects.toThrow();
      expect(kc.entries.get(KEYCHAIN_BUNDLE_NAME)).toBe(raw);
    }
  });

  test("a failed fold still hands back the old key for this run", async () => {
    const kc = fakeKeychain({ "endpoint-api-key:a": "sk-a" });
    kc.backend.set = async () => {
      throw new Error("write refused");
    };
    const store = bundledKeyStore(kc.backend);
    expect(await store.get("endpoint-api-key:a")).toBe("sk-a");
  });
});

describe("perNameKeyStore", () => {
  test("keeps one entry per name and reads a refused entry as missing", async () => {
    const kc = fakeKeychain();
    const store = perNameKeyStore(kc.backend);
    await store.set("sk-a", "endpoint-api-key:a");
    await store.set("sk-old");
    expect(Object.fromEntries(kc.entries)).toEqual({ "endpoint-api-key:a": "sk-a", [KEYCHAIN_NAME]: "sk-old" });
    kc.denied.add("endpoint-api-key:a");
    expect(await store.get("endpoint-api-key:a")).toBeNull();
    await store.delete("endpoint-api-key:a");
    expect(kc.entries.has("endpoint-api-key:a")).toBe(false);
  });
});
