/**
 * Runs a query of this machine's records in a child process (ADR 0065): the daemon starts itself
 * again with `--query-data` (the compiled binary is one file, so a child script cannot ship beside
 * it), sends the request on stdin and reads one JSON line back. A child past its deadline is killed,
 * whatever SQLite is doing; at most two run at once per database.
 */
import { join } from "node:path";
import { isCompiledBinary } from "../platform";
import type { DescribeAnswer, DescribeRequest, QueryAnswer, QueryRequest } from "./child";

export const QUERY_TIMEOUT_MS = 10_000;
const DESCRIBE_BUDGET_MS = 5_000;
const OUTPUT_MAX = 4 * 1024 * 1024;
const CHILDREN_MAX = 2;

const running = new Map<string, number>();

/** The command that runs this daemon again as a query child. */
export function childCommand(): string[] {
  if (isCompiledBinary(import.meta.path)) return [process.execPath, "--query-data"];
  return [process.execPath, join(import.meta.dir, "..", "main.ts"), "--query-data"];
}

async function call<T extends { ok: boolean }>(request: QueryRequest | DescribeRequest, timeoutMs: number): Promise<T | { ok: false; error: string }> {
  const busy = running.get(request.db) ?? 0;
  if (busy >= CHILDREN_MAX) return { ok: false, error: "two queries are already running; try again in a moment" };
  running.set(request.db, busy + 1);
  try {
    const child = Bun.spawn(childCommand(), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "" },
      windowsHide: true,
    });
    child.stdin.write(JSON.stringify(request));
    await child.stdin.end();
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > OUTPUT_MAX) {
          child.kill("SIGKILL");
          return { ok: false, error: "the answer is too large; select fewer columns or aggregate in SQL" };
        }
        chunks.push(value);
      }
      await child.exited;
      if (killed) return { ok: false, error: `the query ran past ${Math.round(timeoutMs / 1000)} seconds and was stopped; narrow it or aggregate in SQL` };
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const line = text.split("\n").at(-1) ?? "";
      try {
        return JSON.parse(line) as T;
      } catch {
        return { ok: false, error: "the query process gave no answer" };
      }
    } finally {
      clearTimeout(timer);
    }
  } finally {
    const left = (running.get(request.db) ?? 1) - 1;
    if (left <= 0) running.delete(request.db);
    else running.set(request.db, left);
  }
}

export function queryRecords(db: string, sql: string, params: Array<string | number | null>, maxRows: number, timeoutMs = QUERY_TIMEOUT_MS) {
  return call<QueryAnswer>({ mode: "query", db, sql, params, maxRows }, timeoutMs);
}

export function describeRecords(db: string, table: string | null, timeoutMs = QUERY_TIMEOUT_MS) {
  return call<DescribeAnswer>({ mode: "describe", db, table, budgetMs: Math.min(DESCRIBE_BUDGET_MS, timeoutMs - 1000) }, timeoutMs);
}
