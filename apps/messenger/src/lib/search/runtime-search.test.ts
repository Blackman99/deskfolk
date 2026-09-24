import { afterEach, expect, test } from "bun:test";
import type { SearchHit } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import { MessengerRuntime } from "../runtime.svelte.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const rt of runtimes.splice(0)) rt.destroy(); });
const hit = (id: string): SearchHit => ({ kind: "session", id, snippet: id });
function fixture() {
  const rt = new MessengerRuntime(); runtimes.push(rt);
  const pending: Array<ReturnType<typeof deferred<SearchHit[]>>> = [];
  const api = { search: () => { const d = deferred<SearchHit[]>(); pending.push(d); return d.promise; } } as unknown as MessengerApi;
  const internal = rt as unknown as { api: MessengerApi | null; resetConnection: () => void };
  internal.api = api;
  rt.connection = "connected";
  return { rt, internal, pending };
}

test("new queries own the results and loading state even when replies arrive out of order", async () => {
  const { rt, pending } = fixture();
  const a = rt.runSearch("a"); const b = rt.runSearch("b");
  expect(rt.searchLoading).toBe(true); expect(rt.searchHits).toEqual([]);
  pending[0].resolve([hit("a")]); await a;
  expect(rt.searchLoading).toBe(true); expect(rt.searchHits).toEqual([]);
  pending[1].resolve([hit("b")]); await b;
  expect(rt.searchHits).toEqual([hit("b")]); expect(rt.searchLoading).toBe(false);
});

for (const action of ["empty", "close", "disconnect", "destroy", "missing client"] as const) {
  test(`${action} invalidates an in-flight search`, async () => {
    const { rt, internal, pending } = fixture();
    const a = rt.runSearch("a");
    if (action === "empty") await rt.runSearch("   ");
    else if (action === "close") rt.closeSearch();
    else if (action === "disconnect") internal.resetConnection();
    else if (action === "destroy") rt.destroy();
    else { internal.api = null; await rt.runSearch("b"); }
    pending[0].resolve([hit("a")]); await a;
    expect(rt.searchHits).toEqual([]);
    expect(rt.searchLoading).toBe(false);
    expect(rt.searchError).toBe(false);
  });
}

test("failed queries have a retryable error, cleared by retry and close", async () => {
  const { rt, pending } = fixture();
  const a = rt.runSearch("a"); pending[0].reject(new Error("offline")); await a;
  expect(rt.searchLoading).toBe(false); expect(rt.searchError).toBe(true);
  const retry = rt.runSearch("a"); expect(rt.searchError).toBe(false);
  pending[1].resolve([hit("a")]); await retry;
  expect(rt.searchHits).toEqual([hit("a")]);
  rt.closeSearch(); expect(rt.searchQuery).toBe(""); expect(rt.searchHits).toEqual([]);
});

test("closing and immediately reopening a search rejects the old result", async () => {
  const { rt, pending } = fixture();
  const a = rt.runSearch("a"); rt.closeSearch(); const b = rt.runSearch("b");
  pending[1].resolve([hit("b")]); await b;
  pending[0].reject(new Error("old error")); await a;
  expect(rt.searchHits).toEqual([hit("b")]); expect(rt.searchError).toBe(false);
});
