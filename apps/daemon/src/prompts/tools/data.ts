import type { ToolDef } from "../tool-schema";

/** This machine's records, read-only (ADR 0065): what happened, for the evidence behind an improvement. */

export const DESCRIBE_DATA: ToolDef = {
  name: "describe_data",
  description: {
    zh: "看本机记录有哪些表：每张表的列、行数，主要的表附一句说明（消息、轮次与工具调用、工作记录、质量事件、规划与任务、交付与审查、需求台账、整理跳记录、判断、花费、复盘、记忆与技能、内置提示词的修改……）。给 table 只看那一张，带列的类型。查不到的表就是不给 Bot 看的。只读。",
    en: "See what tables this machine's records hold: each table's columns and row count, with a line on the main ones (messages, turns and tool calls, the work log, quality events, plans and tickets, hand-overs and reviews, the requirements ledger, organizer runs, judgements, spend, retrospectives, memories and skills, built-in prompt changes…). Give table to see one, with column types. A table you cannot find is not for Bots. Read-only.",
  },
  properties: {
    table: { type: "string", description: { zh: "只看这一张表。", en: "Only this table." } },
  },
};

export const QUERY_DATA: ToolDef = {
  name: "query_data",
  description: {
    zh: "在本机记录上跑一条只读的 SQLite 查询：单条 SELECT（或 WITH … SELECT），参数用 ? 按 params 的顺序绑定。默认最多 100 行、上限 1000，长的格子会截断，二进制只给字节数，跑过 10 秒就停。尽量在 SQL 里 COUNT / GROUP BY 先聚合，少拉原始行；时间是 ISO 8601 UTC 字符串，JSON 列用 json_extract 读。先用 describe_data 看表和列。只在用户要你分析、改进时用。只读。",
    en: "Run one read-only SQLite query on this machine's records: a single SELECT (or WITH … SELECT), with ? bound to params in order. At most 100 rows by default, 1000 at most; long cells are cut, binary shows only its size, and a query past 10 seconds is stopped. Aggregate in SQL (COUNT, GROUP BY) rather than pulling raw rows; times are ISO 8601 UTC strings, JSON columns are read with json_extract. Look at the tables with describe_data first. Use it only when the user asks you to analyze or improve something. Read-only.",
  },
  properties: {
    sql: { type: "string", description: { zh: "一条只读的 SQL。", en: "One read-only SQL statement." } },
    params: { type: "array", items: { type: ["string", "number", "null"] }, description: { zh: "按顺序绑定到 ? 的值。", en: "Values bound to ? in order." } },
    max_rows: { type: "integer", description: { zh: "最多返回几行（默认 100，上限 1000）。", en: "At most this many rows (100 by default, 1000 at most)." } },
  },
  required: ["sql"],
};

export const READ_DATA_LOG: ToolDef = {
  name: "read_data_log",
  description: {
    zh: "读守护进程日志的末尾：daemon.log（启动、重启、整理跳和读句没读懂这类记录），开发版的 daemon-dev.stderr.log。grep 只留含这段文字的行（不分大小写）；像密钥的内容会抹掉。只读。",
    en: "Read the end of the daemon's log: daemon.log (starts, restarts, what the organizer and line readings could not read), and the development build's daemon-dev.stderr.log. grep keeps only lines containing that text (any case); anything that looks like a key is blanked out. Read-only.",
  },
  properties: {
    name: { type: "string", enum: ["daemon.log", "daemon-dev.stderr.log", "daemon-dev.stderr.log.1"], description: { zh: "哪一份日志；不填是 daemon.log。", en: "Which log; daemon.log when left out." } },
    tail_lines: { type: "integer", description: { zh: "最后几行（默认 200，上限 2000）。", en: "How many of the last lines (200 by default, 2000 at most)." } },
    grep: { type: "string", description: { zh: "只留含这段文字的行。", en: "Keep only lines containing this text." } },
  },
};
