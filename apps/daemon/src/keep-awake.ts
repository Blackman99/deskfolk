/**
 * Keeps a Mac on power out of idle sleep while work is under way: a turn running, or a render the
 * daemon is polling for a Bot (ADR 0047). "Hand it off and walk away" is no good if the Mac dozes
 * off ten minutes later and the work sits until you are back. `caffeinate -s` holds the assertion,
 * which macOS honours only on AC power, so a laptop on battery still sleeps rather than run flat;
 * `-w` ties it to this process, so a daemon that dies takes it along. The display still sleeps, and
 * closing the lid or choosing Sleep still puts the Mac to sleep. Off the Mac it does nothing.
 */
export type KeepAwake = {
  /** Whether work is under way now; starts or ends the assertion when that changes. */
  update: (busy: boolean) => void;
  stop: () => void;
};

type Holder = { kill: () => void; exited: Promise<unknown> };

export function keepAwake(options: { platform?: string; pid?: number; spawn?: (cmd: string[]) => Holder } = {}): KeepAwake {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const spawn = options.spawn ?? ((cmd: string[]) => Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
  let holder: Holder | null = null;

  function release(): void {
    const held = holder;
    holder = null;
    try {
      held?.kill();
    } catch {
      // already gone
    }
  }

  return {
    update(busy) {
      if (platform !== "darwin") return;
      if (busy && !holder) {
        try {
          const started = spawn(["/usr/bin/caffeinate", "-s", "-w", String(pid)]);
          holder = started;
          // Gone by itself (killed from outside): the next busy tick starts another.
          void started.exited.then(() => {
            if (holder === started) holder = null;
          });
        } catch {
          holder = null;
        }
      } else if (!busy && holder) {
        release();
      }
    },
    stop: release,
  };
}
