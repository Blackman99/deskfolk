/**
 * The process a Bot's query of this machine's records runs in (ADR 0065): the daemon starts itself
 * again with `--query-data`, hands it one request on stdin and reads one JSON line back. A query is
 * synchronous in SQLite and cannot be interrupted from Bun, so it runs here, where the daemon can kill
 * it on its deadline without stalling anything of its own. The database is opened read-only.
 */
import { Database } from "bun:sqlite";
import { checkPlan, deniedTable, namedWords, scanSql, type PlanRow, type RootPages } from "./guard";

export type QueryRequest = { mode: "query"; db: string; sql: string; params: Array<string | number | null>; maxRows: number };
export type DescribeRequest = { mode: "describe"; db: string; table: string | null; budgetMs: number };

export type QueryAnswer =
  | { ok: true; columns: string[]; rows: unknown[][]; truncated: boolean; elapsed_ms: number }
  | { ok: false; error: string };
export type TableShape = { name: string; kind: "table" | "view"; columns: Array<{ name: string; type: string }>; rows: number | null };
export type DescribeAnswer = { ok: true; tables: TableShape[] } | { ok: false; error: string };

/** Past this many characters a cell is cut; past this many bytes of rows the answer stops. */
const CELL_MAX = 8000;
const ANSWER_MAX = 512 * 1024;

function cell(value: unknown): unknown {
  if (value instanceof Uint8Array) return { blob_bytes: value.byteLength };
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "string" && value.length > CELL_MAX) return `${value.slice(0, CELL_MAX)}…(${value.length - CELL_MAX} more characters)`;
  return value;
}

function open(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.run("PRAGMA query_only = ON");
  db.run("PRAGMA busy_timeout = 2000");
  return db;
}

function rootPages(db: Database): RootPages {
  const rows = db.query<{ type: string; name: string; tbl_name: string; rootpage: number | null }, []>(
    "SELECT type, name, tbl_name, rootpage FROM sqlite_schema WHERE rootpage IS NOT NULL AND rootpage > 0",
  ).all();
  return new Map(rows.map((row) => [row.rootpage!, { name: row.name, table: row.type === "index" ? row.tbl_name : row.name }]));
}

/** For a column a table does not have: the columns of every table the query names, so the next try can be right. */
function columnHint(db: Database, sql: string): string {
  const named = new Set(namedWords(sql));
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') ORDER BY name").all()
    .map((row) => row.name)
    .filter((name) => named.has(name.toLowerCase()) && !deniedTable(name));
  if (tables.length === 0) return "";
  const columns = (name: string) => db.query<{ name: string }, []>(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().map((col) => col.name).join(", ");
  return `. Columns: ${tables.map((name) => `${name}(${columns(name)})`).join("; ")}`;
}

/** How json_each and json_tree show in this connection's plans: each is one virtual table per connection. */
function jsonTables(db: Database): Set<string> {
  const out = new Set<string>();
  for (const name of ["json_each", "json_tree"]) {
    for (const row of db.query<PlanRow, []>(`EXPLAIN SELECT * FROM ${name}('[]')`).all()) {
      if (row.opcode === "VOpen") out.add(String(row.p4));
    }
  }
  return out;
}

export function runQuery(request: QueryRequest): QueryAnswer {
  const words = scanSql(request.sql);
  if (!words.ok) return { ok: false, error: words.reason };
  let db: Database;
  try {
    db = open(request.db);
  } catch (error) {
    return { ok: false, error: `the records could not be opened: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const started = Date.now();
    let plan: PlanRow[];
    try {
      plan = db.query<PlanRow, Array<string | number | null>>(`EXPLAIN ${request.sql}`).all(...request.params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: /^no such column/i.test(message) ? `${message}${columnHint(db, request.sql)}` : message };
    }
    const read = checkPlan(plan, rootPages(db), jsonTables(db));
    if (!read.ok) return { ok: false, error: read.reason };
    const statement = db.query<Record<string, unknown>, Array<string | number | null>>(request.sql);
    const columns = statement.columnNames;
    const rows: unknown[][] = [];
    let size = 0;
    let truncated = false;
    for (const row of statement.iterate(...request.params)) {
      if (rows.length >= request.maxRows) {
        truncated = true;
        break;
      }
      const values = columns.map((name) => cell(row[name]));
      size += JSON.stringify(values).length;
      if (size > ANSWER_MAX) {
        truncated = true;
        break;
      }
      rows.push(values);
    }
    return { ok: true, columns, rows, truncated, elapsed_ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db.close();
  }
}

export function describe(request: DescribeRequest): DescribeAnswer {
  let db: Database;
  try {
    db = open(request.db);
  } catch (error) {
    return { ok: false, error: `the records could not be opened: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const deadline = Date.now() + request.budgetMs;
    const names = db.query<{ name: string; type: "table" | "view" }, []>(
      "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') ORDER BY name",
    ).all().filter((row) => !deniedTable(row.name) && (request.table === null || row.name === request.table));
    if (request.table !== null && names.length === 0) return { ok: false, error: `no such table: ${request.table}` };
    const tables: TableShape[] = names.map((row) => {
      const quoted = `"${row.name.replaceAll('"', '""')}"`;
      const columns = db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${quoted})`).all().map((col) => ({ name: col.name, type: col.type }));
      let rows: number | null = null;
      if (Date.now() < deadline && row.type === "table") {
        try {
          rows = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${quoted}`).get()!.n;
        } catch {
          rows = null;
        }
      }
      return { name: row.name, kind: row.type, columns, rows };
    });
    return { ok: true, tables };
  } finally {
    db.close();
  }
}

/** `--query-data`: one request on stdin, one JSON line on stdout. */
export async function runQueryChild(): Promise<void> {
  let answer: QueryAnswer | DescribeAnswer;
  try {
    const request = JSON.parse(await Bun.stdin.text()) as QueryRequest | DescribeRequest;
    answer = request.mode === "describe" ? describe(request) : runQuery(request);
  } catch (error) {
    answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
