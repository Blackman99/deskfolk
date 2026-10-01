import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDbPath, writeDescriptor } from "../src/descriptor";
import { createLocalApi } from "../src/local-api";
import { memoryKeyStore } from "../src/secrets";
import { Store } from "../src/store";
import { ENGINE_LEVEL, SCHEMA_LEVEL } from "../src/store/schema-gate";
import { parseArgs, run, USAGE } from "./engine-level.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A data folder whose database a daemon opened once and stopped cleanly. */
function dataFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-engine-level-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store({ filename: stateDbPath(dir) });
  store.recordCleanShutdown();
  store.close();
  return dir;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { env: {}, print: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
}

function optInRow(dir: string): string | null {
  const db = new Database(stateDbPath(dir), { readonly: true });
  try {
    return db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'engine_gate_optin'").get()?.value ?? null;
  } finally {
    db.close();
  }
}

test("it takes one of --accept-older-app or --clear, and the data folder the daemon would pick", () => {
  expect(parseArgs(["--accept-older-app", "--data-dir", "/tmp/x"], {})).toEqual({ action: "accept", dataDir: "/tmp/x" });
  expect(parseArgs(["--clear"], { REAL_BOT_DATA_DIR: "/tmp/y" })).toEqual({ action: "clear", dataDir: "/tmp/y" });
  expect(parseArgs([], {})).toEqual({ error: USAGE });
  expect(parseArgs(["--accept-older-app", "--clear"], {})).toEqual({ error: USAGE });
  expect(parseArgs(["--accept-older-app", "--data-dir"], {})).toEqual({ error: USAGE });
  expect(parseArgs(["--accept-older-app", "--force"], {})).toMatchObject({ error: expect.stringContaining("unknown argument --force") });
});

test("with no daemon running it writes the opt-in without opening a Store, and the next start raises past the older app", async () => {
  const dir = dataFolder();
  const { out, err, io: streams } = io();
  expect(await run(["--accept-older-app", "--data-dir", dir], streams)).toBe(0);
  expect(err).toEqual([]);
  expect(out[0]).toContain("the next start raises the engine level");
  // Written, not raised: the capabilities it prints are the database's as it stands.
  expect(JSON.parse(out[1]!)).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: 0, features: [] });
  expect(JSON.parse(optInRow(dir)!)).toMatchObject({ by: "script", level: ENGINE_LEVEL });

  const next = new Store({ filename: stateDbPath(dir) });
  // The script never opened a Store, so the clean stop before it still reads as clean.
  expect(next.previousShutdown).toBe("clean");
  const lines = next.catchUpEngineLevel({ version: "0.1.0-rc.11" });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("past the installed app (0.1.0-rc.11)");
  expect(lines[0]).toContain("(script, ");
  expect(next.capabilities().engine_level).toBe(ENGINE_LEVEL);
  next.close();
});

test.each([1, 2])("an opt-in accepting only historical engine level %s cannot authorize the current level past an older installed app", (acceptedLevel) => {
  const dir = dataFolder();
  const db = new Database(stateDbPath(dir));
  db.run("INSERT INTO settings (key, value) VALUES ('engine_gate_optin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify({ at: '2026-01-01T00:00:00.000Z', by: 'script', level: acceptedLevel })]);
  db.run("INSERT INTO settings (key, value) VALUES ('engine_level', ?), ('schema_min_compatible', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(acceptedLevel), String(acceptedLevel)]);
  db.close();
  const next = new Store({ filename: stateDbPath(dir) });
  try {
    const refused = next.raiseEngineLevel({ version: '0.1.0-rc.11' });
    expect(refused.raised).toBe(false);
    expect(refused.level).toBe(acceptedLevel);
    expect(refused.refused).not.toBeNull();
    expect(next.capabilities().engine_level).toBe(acceptedLevel);
    expect(next.engineGateOptIn()?.level).toBe(acceptedLevel);
    expect(next.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe(String(acceptedLevel));
  } finally { next.close(); }
});

test("--clear with no daemon running takes the opt-in back and leaves the level where it is", async () => {
  const dir = dataFolder();
  const raised = new Store({ filename: stateDbPath(dir) });
  raised.acceptOlderApp("api");
  raised.catchUpEngineLevel({ version: "0.1.0-rc.11" });
  raised.recordCleanShutdown();
  raised.close();

  const { out, io: streams } = io();
  expect(await run(["--clear", "--data-dir", dir], streams)).toBe(0);
  expect(optInRow(dir)).toBeNull();
  expect(JSON.parse(out[1]!)).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL, features: ["holds", "work_items", "delegation"] });
});

test("a data folder with no database yet is left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-engine-level-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { err, io: streams } = io();
  expect(await run(["--accept-older-app", "--data-dir", dir], streams)).toBe(2);
  expect(err[0]).toContain("no database at");
});

test("with a daemon running it asks that daemon, which raises at once", async () => {
  const dir = dataFolder();
  const store = new Store({ filename: stateDbPath(dir), endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "test-token", schedule: false, installedApp: () => ({ version: "0.1.0-rc.11" }) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  cleanups.push(async () => {
    await api.engine.close();
    store.close();
    await server.stop(true);
  });
  writeDescriptor(dir, { pid: process.pid, port: server.port!, token: "test-token", started_at: new Date().toISOString() });

  const accepted = io();
  expect(await run(["--accept-older-app", "--data-dir", dir], accepted.io)).toBe(0);
  expect(accepted.out[0]).toContain("raised the engine level now");
  expect(JSON.parse(accepted.out[1]!)).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL, features: ["holds", "work_items", "delegation"] });
  expect(store.engineGateOptIn()?.by).toBe("script");

  const cleared = io();
  expect(await run(["--clear", "--data-dir", dir], cleared.io)).toBe(0);
  expect(store.engineGateOptIn()).toBeNull();
  expect(JSON.parse(cleared.out[1]!)).toMatchObject({ engine_level: ENGINE_LEVEL });
});

test("a daemon that says no is reported, and its database is not written from here", async () => {
  const dir = dataFolder();
  // An installed app's daemon from before the route: the token is good, the route unknown.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { code: "not_found", message: "unknown route" } }, { status: 404 }) });
  cleanups.push(() => server.stop(true));
  writeDescriptor(dir, { pid: process.pid, port: server.port!, token: "t", started_at: new Date().toISOString() });
  const { err, io: streams } = io();
  expect(await run(["--accept-older-app", "--data-dir", dir], streams)).toBe(1);
  expect(err[0]).toContain("answered 404");
  expect(optInRow(dir)).toBeNull();
});
