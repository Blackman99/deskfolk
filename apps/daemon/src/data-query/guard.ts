/**
 * What a Bot's query of this machine's records may be (ADR 0065), checked before it runs: one
 * statement that only reads (SELECT, WITH … SELECT, VALUES), naming no table that holds a secret or
 * what Bots must not see, and — read from its query plan, not its words — opening no such table
 * through a view or an index, no other database, no virtual table but json_each and json_tree, and
 * nothing that writes. The connection it runs on
 * is read-only besides; this is what keeps it to the tables Bots may read.
 */

/** Tables Bots never read: remote access's keys and receipts, push delivery, your terminals. */
export const DENIED_TABLES: ReadonlySet<string> = new Set([
  "pending_keys",
  "request_receipts",
  "notification_push_config",
  "notification_devices",
  "terminals",
]);

/** Every `remote_*` table is remote access's (device keys, push subscriptions, pairing); `sqlite_*` is SQLite's own. */
const DENIED_PREFIXES = ["remote_", "sqlite_"];

export function deniedTable(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_TABLES.has(lower) || DENIED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Words that never belong in a read: attaching, pragmas, writes, schema and transactions. */
const FORBIDDEN_WORDS = new Set([
  "attach", "detach", "pragma", "vacuum", "insert", "update", "delete", "create", "drop", "alter",
  "reindex", "analyze", "begin", "commit", "rollback", "savepoint", "release", "upsert",
]);

/** Functions and table-valued functions that reach past the tables: extensions, files, raw pages, pragmas, other statements. */
const FORBIDDEN_NAMES = new Set(["load_extension", "readfile", "writefile", "edit", "fsdir", "fts3_tokenizer", "dbstat", "sqlite_dbpage", "sqlite_stmt", "bytecode", "tables_used", "zipfile", "sqlar_compress", "sqlar_uncompress"]);

type Token = { kind: "word" | "quoted" | "string" | "number" | "punct"; text: string };

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** Splits SQL into tokens, comments dropped; strings and quoted names kept whole. */
function tokens(sql: string): Token[] | string {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return "an unterminated comment";
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= sql.length) return "an unterminated quote";
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) { text += close; j += 2; continue; }
          break;
        }
        text += sql[j];
        j += 1;
      }
      out.push({ kind: c === "'" ? "string" : "quoted", text });
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (word) { out.push({ kind: "word", text: word[0] }); i += word[0].length; continue; }
    const number = /^(?:0x[0-9A-Fa-f]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(sql.slice(i));
    if (number) { out.push({ kind: "number", text: number[0] }); i += number[0].length; continue; }
    out.push({ kind: "punct", text: c });
    i += 1;
  }
  return out;
}

/** The words of a query: one statement that only reads, naming nothing it may not. */
export function scanSql(sql: string): GuardResult {
  const list = tokens(sql);
  if (typeof list === "string") return { ok: false, reason: `the query has ${list}` };
  const semicolon = list.findIndex((token) => token.kind === "punct" && token.text === ";");
  if (semicolon !== -1 && semicolon < list.length - 1) return { ok: false, reason: "one statement at a time" };
  const body = semicolon === -1 ? list : list.slice(0, semicolon);
  if (body.length === 0) return { ok: false, reason: "the query is empty" };
  const first = body[0]!;
  if (first.kind !== "word" || !["select", "with", "values"].includes(first.text.toLowerCase())) {
    return { ok: false, reason: "only a read: SELECT, WITH … SELECT or VALUES" };
  }
  for (const token of body) {
    if (token.kind !== "word" && token.kind !== "quoted") continue;
    const name = token.text.toLowerCase();
    if (token.kind === "word" && FORBIDDEN_WORDS.has(name)) return { ok: false, reason: `only a read: ${token.text.toUpperCase()} is not allowed` };
    if (FORBIDDEN_NAMES.has(name) || name.startsWith("pragma_")) return { ok: false, reason: `${token.text} is not available` };
    if (deniedTable(name)) return { ok: false, reason: `no such table: ${token.text}` };
  }
  return { ok: true };
}

/** One row of `EXPLAIN <query>`. */
export type PlanRow = { opcode: string; p1: number; p2: number; p3: number; p4: unknown; p5: number };
/** `sqlite_schema` rows by root page: the table, or the table an index belongs to. */
export type RootPages = ReadonlyMap<number, { name: string; table: string }>;

/**
 * What writes the database file: a write cursor on a real b-tree, a write transaction, schema changes.
 * Insert and Delete alone are not here: a recursive CTE, DISTINCT or a sort writes its own ephemeral
 * table with them, and writing a real table needs an OpenWrite cursor first.
 */
const WRITE_OPCODES = new Set([
  "OpenWrite", "Clear", "Destroy", "CreateBtree", "ParseSchema", "DropTable", "DropIndex", "DropTrigger",
  "VUpdate", "Vacuum", "IncrVacuum", "JournalMode", "SqlExec", "Expire",
]);
/** OPFLAG_P2ISREG (sqliteInt.h): the root page is in a register, so it cannot be told from the plan. 0x02 is OPFLAG_SEEKEQ. */
const P2ISREG = 0x10;

/**
 * The query plan: which tables it opens, in which database, and whether anything in it writes.
 * `vtabs` are the virtual tables it may scan, as `VOpen` shows them (`vtab:<address>`): json_each and
 * json_tree on the connection the query runs on, whatever the query calls them. Any other — `bytecode`,
 * `carray`, or one a future SQLite build adds — is refused, since the word list cannot know them all.
 */
export function checkPlan(plan: readonly PlanRow[], roots: RootPages, vtabs: ReadonlySet<string>): GuardResult {
  for (const row of plan) {
    if (WRITE_OPCODES.has(row.opcode)) return { ok: false, reason: "only a read" };
    if (row.opcode === "Transaction" && row.p2 !== 0) return { ok: false, reason: "only a read" };
    if (row.opcode === "VOpen" && !vtabs.has(String(row.p4))) return { ok: false, reason: "only the records, json_each and json_tree can be read" };
    if (row.opcode !== "OpenRead" && row.opcode !== "ReopenIdx") continue;
    if (row.p3 !== 0) return { ok: false, reason: "only this machine's records" };
    if ((row.p5 & P2ISREG) !== 0) return { ok: false, reason: "a table the query names cannot be told" };
    if (row.p2 === 1) return { ok: false, reason: "no such table: sqlite_schema" };
    const root = roots.get(row.p2);
    if (!root) return { ok: false, reason: "a table the query reads cannot be told" };
    if (deniedTable(root.table)) return { ok: false, reason: `no such table: ${root.table}` };
  }
  return { ok: true };
}
