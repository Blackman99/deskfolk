#!/usr/bin/env bun
/**
 * Compares several golden-path-eval `results.json` files: the same matrix run on different models,
 * or the same model with and without an ablation, or just several separate runs you want side by
 * side. Grouped by (model, setup, ablation[, --by-task: task]), with a 95% Wilson interval on the
 * completion rate and a Δ against the same model+setup(+task)'s "none" ablation row.
 *
 *   bun scripts/golden-path-combine.ts <dir|results.json>... [--by-task] [--min-pass 0..1] [--out file.md]
 *
 * A directory argument means `<dir>/results.json` (what `golden-path-eval.ts --out <dir>` writes).
 * `--min-pass` re-derives completion and failure at that pass mark instead of trusting each file's
 * own `--min-pass`; without it, files run at different pass marks are compared as they were scored,
 * which the summary warns about. Prints Markdown to stdout; `--out` also writes it to a file.
 *
 * Pure logic (grouping, the Wilson interval, the table) is `scripts/golden-path/combine.ts`, with
 * its own unit tests; this file is only argv parsing and file reads.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { combine, formatComparison, readResults, type ResultsFile } from "./golden-path/combine";

const HELP = `golden-path-combine — compare several golden-path-eval results.json files

  bun scripts/golden-path-combine.ts <dir|results.json>... [--by-task] [--min-pass 0..1] [--out file.md]

A directory argument means <dir>/results.json. Prints a Markdown comparison table to stdout;
--out also writes it to that file.

  --by-task         split rows by task instead of merging every task into one row per model × setup × ablation
  --min-pass <0..1> re-derive completion/failure at this pass mark instead of trusting each file's own
  --out <file>      also write the Markdown to this file
  --help

Exit: 0 on success, 2 on bad arguments or an unreadable/malformed file.
`;

function resultsPath(arg: string): string {
  const abs = resolve(arg);
  if (existsSync(abs) && statSync(abs).isDirectory()) return join(abs, "results.json");
  return abs;
}

function main(): number {
  const argv = process.argv.slice(2);
  const inputs: string[] = [];
  let byTask = false;
  let minPass: number | undefined;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    }
    if (arg === "--by-task") {
      byTask = true;
      continue;
    }
    if (arg === "--min-pass") {
      const value = argv[i + 1];
      i += 1;
      const n = value === undefined ? Number.NaN : Number.parseFloat(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        process.stderr.write("--min-pass must be a number between 0 and 1\n");
        return 2;
      }
      minPass = n;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      i += 1;
      if (!value) {
        process.stderr.write("--out needs a file path\n");
        return 2;
      }
      out = resolve(value);
      continue;
    }
    if (arg.startsWith("--")) {
      process.stderr.write(`unknown flag ${arg}\n`);
      return 2;
    }
    inputs.push(arg);
  }
  if (inputs.length === 0) {
    process.stderr.write("usage: golden-path-combine.ts <dir|results.json>... [--by-task] [--min-pass x] [--out file.md]\n");
    return 2;
  }
  const files: Array<{ path: string; data: ResultsFile }> = [];
  for (const input of inputs) {
    const path = resultsPath(input);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      process.stderr.write(`${path}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    try {
      files.push({ path, data: readResults(raw, path) });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  const result = combine(files, { byTask, minPass });
  const markdown = formatComparison(result);
  process.stdout.write(markdown);
  if (out) writeFileSync(out, markdown);
  return 0;
}

process.exit(main());
