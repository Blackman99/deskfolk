import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from ".";

const FIXTURES = join(dirname(import.meta.path), "fixtures");

describe("holds from before the spend cap (ADR 0088)", () => {
  test("the source CHECK takes spend_cap, every hold stays and still holds, and reopening leaves the table alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-migrate-"));
    const file = join(dir, "state.sqlite");
    try {
      const old = new Database(file, { create: true, strict: true });
      old.exec(readFileSync(join(FIXTURES, "schema-pre-agent-runners.sql"), "utf8"));
      const now = "2026-10-01T00:00:00.000Z";
      old.run(`INSERT INTO holds (id, scope, scope_id, source, lift_on_next_user_message, created_at) VALUES ('hold-yours', 'global', NULL, 'user_button', 0, ?)`, [now]);
      expect(() => old.run(`INSERT INTO holds (id, scope, scope_id, source, created_at) VALUES ('hold-cap', 'global', NULL, 'spend_cap', ?)`, [now])).toThrow(/CHECK/);
      old.close();

      const store = new Store({ filename: file });
      const shape = store.db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'holds'`).get()!.sql;
      expect(shape).toContain("'spend_cap'");
      expect(store.getHold("hold-yours")).toMatchObject({ scope: "global", source: "user_button", lifted_at: null });
      store.db.run(`INSERT INTO holds (id, scope, scope_id, source, created_at) VALUES ('hold-cap', 'global', NULL, 'spend_cap', ?)`, [now]);
      // The view every "is this held?" reads still sees the table it was made over.
      expect(store.db.query<{ hold_id: string }, []>(`SELECT hold_id FROM held_scopes ORDER BY hold_id`).all().map((row) => row.hold_id)).toEqual(["hold-cap", "hold-yours"]);
      // The index on holds in force came back with the table.
      expect(store.db.query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'holds_in_force'`).get()).not.toBeNull();
      expect(() => store.db.run(`INSERT INTO holds (id, scope, scope_id, source, created_at) VALUES ('hold-bad', 'global', NULL, 'bot', ?)`, [now])).toThrow(/CHECK/);
      expect(store.db.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
      expect(store.db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
      store.close();

      const before = new Database(file, { strict: true });
      const rebuilt = before.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'holds'`).get()!.sql;
      before.close();
      new Store({ filename: file }).close();
      const after = new Database(file, { strict: true });
      expect(after.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'holds'`).get()!.sql).toBe(rebuilt);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
