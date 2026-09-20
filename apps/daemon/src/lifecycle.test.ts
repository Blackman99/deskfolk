import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeLifecycle } from "./lifecycle";

test("stop latch is durable, private and never installs or exits a supervisor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc07-latch-"));
  try {
    const lifecycle = new RuntimeLifecycle(dir, "none");
    expect(lifecycle.kind).toBe("none"); expect(lifecycle.isStopped()).toBe(false);
    await lifecycle.writeStopLatch();
    expect(statSync(lifecycle.latchPath).mode & 0o777).toBe(0o600);
    const restarted = new RuntimeLifecycle(dir, "window");
    expect(restarted.isStopped()).toBe(true);
    await restarted.clearStopLatch(); await restarted.clearStopLatch();
    expect(lifecycle.isStopped()).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
