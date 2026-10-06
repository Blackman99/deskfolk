/**
 * Compiled by `compiled-daemon.test.ts` together with the daemon's Worker entrypoints and run from
 * `/`, the way the shipped daemon runs: one `matches` check through the same regex Worker. Nothing in
 * the daemon imports it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceCheck } from "@real-bot/protocol";
import { evaluateFileCheck } from "../acceptance-eval";

const root = mkdtempSync(join(tmpdir(), "regex-probe-"));
try {
  writeFileSync(join(root, "a.txt"), "hello world\n");
  const check = {
    id: "probe",
    task_id: "probe",
    ticket_id: null,
    item: "probe",
    kind: "matches",
    path: "a.txt",
    pattern: "hel+o",
    negate: false,
    command: null,
    cwd: null,
    expect_exit: null,
    expect_stdout: null,
  } as unknown as AcceptanceCheck;
  console.log(JSON.stringify(await evaluateFileCheck(root, check, "en")));
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
