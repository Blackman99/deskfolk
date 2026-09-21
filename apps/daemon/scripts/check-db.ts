/**
 * Opens a copy of a real database with the current `Store`.
 *
 * `bun test` only ever opens `:memory:` and the fixtures under `src/store/fixtures/`, so it says
 * nothing about the database on this machine — the one the daemon opens at startup, and the one
 * whose failure to open reads in the window as nothing but "can't reach the runtime". Run this
 * after touching `schema.ts` or `migrate.ts`.
 *
 *   pnpm --filter @real-bot/daemon check:db            # the daemon's own database
 *   pnpm --filter @real-bot/daemon check:db <path>     # some other one
 *
 * It copies first and opens the copy, so the real database is never migrated by this check.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { APP_SUPPORT_DIRNAME, STATE_DB_NAME } from "@real-bot/protocol";
import { Store } from "../src/store";

const source =
  process.argv[2] ?? join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME, STATE_DB_NAME);

if (!existsSync(source)) {
  console.error(`no database at ${source}`);
  console.error("Run the app once, or pass a path.");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "real-bot-check-db-"));
const copy = join(dir, STATE_DB_NAME);
try {
  copyFileSync(source, copy);
  // WAL and shm hold writes the main file does not; without them the copy is an older state.
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${copy}${suffix}`);
  }

  const store = new Store({ filename: copy });
  const tables = store.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .get();
  const turns = store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM turns`).get();
  store.close();
  console.log(`opened a copy of ${source}`);
  console.log(`  ${tables?.n ?? 0} tables, ${turns?.n ?? 0} turns`);
} catch (error) {
  console.error(`FAILED to open a copy of ${source}`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  console.error("The daemon would not start against this database.");
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
