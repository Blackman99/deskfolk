import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorControl } from "./quiesce";

/** Supervision/exit remains the caller's job; the latch is durable across process restarts. */
export class RuntimeLifecycle implements SupervisorControl {
  readonly latchPath: string;
  constructor(private readonly dataDir: string, readonly kind: SupervisorControl["kind"]) {
    this.latchPath = join(dataDir, "runtime.stop");
  }
  isStopped(): boolean { return existsSync(this.latchPath); }
  async writeStopLatch(): Promise<void> {
    const temporary = `${this.latchPath}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, "stopped\n", { mode: 0o600, flag: "wx" });
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.latchPath);
      this.syncDirectory();
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  async clearStopLatch(): Promise<void> {
    try { unlinkSync(this.latchPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.syncDirectory();
  }
  private syncDirectory(): void {
    const directory = openSync(this.dataDir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
