import { RECIPES } from "../../data-query/catalog";
import type { ToolDef } from "../tool-schema";

/** This machine's records, read-only (ADR 0065): what happened, for the evidence behind an improvement. */

export const DESCRIBE_DATA: ToolDef = {
  name: "describe_data",
  description: {
    zh: "看本机记录有哪些表：表名、行数、主要表的说明，和现成的查询（recipes）。给 table 看那张表的列和类型；写 SQL 前先看。",
    en: "See what this machine's records hold: tables, row counts, a line on the main ones, and ready-made queries (recipes). Give table for its columns and types; look before writing SQL.",
  },
  properties: {
    table: { type: "string", description: { zh: "看这一张表的列。", en: "See this table's columns." } },
  },
};

export const QUERY_DATA: ToolDef = {
  name: "query_data",
  description: {
    zh: "跑一条只读 SQLite 查询（单条 SELECT 或 WITH … SELECT，? 按 params 顺序绑定），或用 recipe 跑现成的。默认 100 行、上限 1000，10 秒就停。先在 SQL 里聚合；时间是 ISO 8601 UTC，JSON 列用 json_extract；列名写错会告诉你对的。互不依赖的查询同一步一起发。",
    en: "Run one read-only SQLite query (a single SELECT or WITH … SELECT; ? bound to params in order), or a ready-made one with recipe. 100 rows by default, 1000 at most, stopped at 10 s. Aggregate in SQL; times are ISO 8601 UTC, JSON columns need json_extract; a wrong column name comes back with the right ones. Send independent queries together in one step.",
  },
  properties: {
    sql: { type: "string", description: { zh: "一条只读的 SQL。", en: "One read-only SQL statement." } },
    recipe: { type: "string", enum: RECIPES.map((recipe) => recipe.id), description: { zh: "现成查询的名字（describe_data 列着），代替 sql。", en: "A ready-made query by name (describe_data lists them), instead of sql." } },
    params: { type: "array", items: { type: ["string", "number", "null"] }, description: { zh: "按顺序绑定到 ? 的值。", en: "Values bound to ? in order." } },
    max_rows: { type: "integer", description: { zh: "最多几行（默认 100，上限 1000）。", en: "At most this many rows (100 by default, 1000 at most)." } },
  },
};

export const READ_DATA_LOG: ToolDef = {
  name: "read_data_log",
  description: {
    zh: "读守护进程日志的末尾：daemon.log（启动、重启、读不懂的回答）或开发版的 daemon-dev.stderr.log。grep 只留含这段文字的行；像密钥的会抹掉。",
    en: "Read the end of the daemon's log: daemon.log (starts, restarts, unreadable answers) or the development build's daemon-dev.stderr.log. grep keeps matching lines; anything like a key is blanked.",
  },
  properties: {
    name: { type: "string", enum: ["daemon.log", "daemon-dev.stderr.log", "daemon-dev.stderr.log.1"], description: { zh: "哪一份；不填是 daemon.log。", en: "Which log; daemon.log when left out." } },
    tail_lines: { type: "integer", description: { zh: "最后几行（默认 200，上限 2000）。", en: "How many last lines (200 by default, 2000 at most)." } },
    grep: { type: "string", description: { zh: "只留含这段文字的行。", en: "Keep the lines holding this text." } },
  },
};
