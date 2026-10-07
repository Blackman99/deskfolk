/**
 * A Bot reading this machine's records (ADR 0065): what the tables are, a read-only query of them,
 * and the tail of the daemon's own log. Everything here only reads, and nothing a Bot must not see
 * is reachable: the tables that hold remote access's keys and your terminals are refused by name and
 * by query plan (data-query/guard.ts), and of the data folder only the daemon's logs are read, with
 * anything that looks like a key blanked out.
 */
import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locale } from "@real-bot/protocol";
import type { ToolCtx, ToolResult } from "./collab-tools";
import { RECIPES, tableNote } from "./data-query/catalog";
import { describeRecords, queryRecords } from "./data-query/runner";

const ROWS_DEFAULT = 100;
const ROWS_MAX = 1000;
const PARAMS_MAX = 50;
const SQL_MAX = 20_000;
/** The daemon's logs, by the names they have in the data folder; nothing else there is read. */
export const DATA_LOGS = ["daemon.log", "daemon-dev.stderr.log", "daemon-dev.stderr.log.1"] as const;
const LOG_TAIL_BYTES = 512 * 1024;
const LOG_LINES_DEFAULT = 200;
const LOG_LINES_MAX = 2000;

function fail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message }, emitted: [] };
}

function uiLocale(ctx: ToolCtx): Locale {
  return ctx.store.settingsCached().locale === "en" ? "en" : "zh";
}

function databaseOf(ctx: ToolCtx): string | null {
  return ctx.store.filename;
}

export async function describeData(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const db = databaseOf(ctx);
  if (!db) return fail("unavailable", "these records are not kept in a file here");
  const table = typeof args.table === "string" && args.table.trim() ? args.table.trim() : null;
  const answer = await describeRecords(db, table);
  if (!answer.ok) return fail(answer.error.startsWith("no such table") ? "not_found" : "failed", answer.error);
  const locale = uiLocale(ctx);
  return {
    ok: true,
    data: {
      note: locale === "en"
        ? "Give table to see a table's columns. Times are ISO 8601 UTC strings; ids are ULIDs; JSON columns are read with json_extract. Tables not listed are not for Bots."
        : "给 table 看一张表的列。时间是 ISO 8601 UTC 字符串；id 是 ULID；JSON 列用 json_extract 读。没列出来的表不给 Bot 看。",
      tables: answer.tables.map((shape) => ({
        name: shape.name,
        ...(shape.kind === "view" ? { kind: "view" } : {}),
        ...(tableNote(shape.name, locale) ? { about: tableNote(shape.name, locale) } : {}),
        rows: shape.rows,
        // Every table's columns at once run past what a tool result holds in context; one at a time.
        ...(table ? { columns: shape.columns } : {}),
      })),
      ...(table ? {} : { recipes: RECIPES.map((recipe) => ({ id: recipe.id, about: recipe[locale] })) }),
    },
    emitted: [],
  };
}

export async function queryData(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const db = databaseOf(ctx);
  if (!db) return fail("unavailable", "these records are not kept in a file here");
  const written = typeof args.sql === "string" ? args.sql.trim() : "";
  const named = typeof args.recipe === "string" ? args.recipe.trim() : "";
  if (written && named) return fail("invalid_args", "give sql or recipe, not both");
  const recipe = named ? RECIPES.find((candidate) => candidate.id === named) : undefined;
  if (named && !recipe) return fail("invalid_args", `recipe is one of ${RECIPES.map((candidate) => candidate.id).join(", ")}`);
  const sql = recipe ? recipe.sql : written;
  if (!sql) return fail("invalid_args", "sql (one SELECT) or recipe is required");
  if (sql.length > SQL_MAX) return fail("invalid_args", `sql is at most ${SQL_MAX} characters`);
  if (recipe && args.params !== undefined) return fail("invalid_args", "a recipe takes no params");
  const params = args.params === undefined ? [] : args.params;
  if (!Array.isArray(params) || params.length > PARAMS_MAX || !params.every((p) => p === null || typeof p === "string" || typeof p === "number")) {
    return fail("invalid_args", `params is a list of at most ${PARAMS_MAX} strings, numbers or nulls, bound to ? in order`);
  }
  const asked = typeof args.max_rows === "number" && Number.isInteger(args.max_rows) ? args.max_rows : ROWS_DEFAULT;
  const maxRows = Math.max(1, Math.min(ROWS_MAX, asked));
  const answer = await queryRecords(db, sql, params as Array<string | number | null>, maxRows);
  if (!answer.ok) return fail("query_failed", answer.error);
  return {
    ok: true,
    data: {
      ...(recipe ? { recipe: recipe.id, sql: recipe.sql } : {}),
      columns: answer.columns, rows: answer.rows, row_count: answer.rows.length, truncated: answer.truncated, elapsed_ms: answer.elapsed_ms,
    },
    emitted: [],
  };
}

/** What looks like a credential in a log line: bearer tokens, API keys, `key=` / `token=` pairs, Authorization headers. */
const SECRET_PATTERNS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)["']?[^\s"'&,;]{4,}/gi,
  /(Authorization\s*:\s*)[^\r\n]+/gi,
];

export function redactSecrets(line: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (match, keep?: string) => `${typeof keep === "string" ? keep : ""}[redacted]`), line);
}

function tail(path: string, bytes: number): string {
  const size = lstatSync(path).size;
  const start = Math.max(0, size - bytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  // Not through a link, even one put there after the check in readDataLog.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

export function readDataLog(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const db = databaseOf(ctx);
  if (!db) return fail("unavailable", "the daemon keeps no log file here");
  const name = typeof args.name === "string" ? args.name : "daemon.log";
  if (!(DATA_LOGS as readonly string[]).includes(name)) return fail("invalid_args", `name is one of ${DATA_LOGS.join(", ")}`);
  const path = join(dirname(db), name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return fail("not_found", `${name} is not there`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return fail("not_found", `${name} is not a log file`);
  const wanted = typeof args.tail_lines === "number" && Number.isInteger(args.tail_lines) ? args.tail_lines : LOG_LINES_DEFAULT;
  const lines = Math.max(1, Math.min(LOG_LINES_MAX, wanted));
  const grep = typeof args.grep === "string" && args.grep.trim() ? args.grep.trim().toLowerCase() : null;
  // Keys are blanked before the grep: matching on the raw line would let a run of greps spell one out.
  const all = tail(path, LOG_TAIL_BYTES).split("\n").filter((line) => line.length > 0).map(redactSecrets);
  const kept = (grep ? all.filter((line) => line.toLowerCase().includes(grep)) : all).slice(-lines);
  return { ok: true, data: { name, lines: kept, line_count: kept.length, size_bytes: stat.size }, emitted: [] };
}
