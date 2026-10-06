/**
 * Your lines in one conversation, taken in the order they came (连发, ADR 0063). Reading a line and
 * filing it take model calls, so a second line sent while the first is still being read used to be
 * routed whenever its own calls came back: before the first, as the trigger of the turn, with the
 * first heard into it afterwards. Now each line waits for the one before it to be routed — the turn
 * it opened is there to hear the next — while a line that is only a stop goes ahead of all of them
 * (turn-engine.ts never queues one the rules carry out).
 *
 * The wait has a ceiling, counted from when the line ahead started, not from when this one came:
 * a line stuck on its reading holds up the next one for at most that long, never the whole queue
 * behind it once per line. Shutting down, nobody waits.
 */

export type IntakePlace = {
  /** Settles once the line ahead has been routed, or the wait has lasted the ceiling, or the daemon drains. */
  ready: Promise<void>;
  /** This line is routed (or was dropped): the next one goes. Safe to call more than once. */
  release: () => void;
};

/**
 * How long a line waits for the one before it. Reading and filing a line give up after 20 s each
 * (`reader.ts`), and the two run at once; this leaves room for both and for a slow route behind them.
 */
export const INTAKE_CAP_MS = 45_000;

type Entry = { started: Promise<void>; done: Promise<void> };

export function createIntake(opts: { capMs: number; draining?: () => boolean }): { enter: (sessionId: string) => IntakePlace } {
  const tails = new Map<string, Entry>();

  function enter(sessionId: string): IntakePlace {
    const ahead = tails.get(sessionId) ?? null;
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve));
    const done = new Promise<void>((resolve) => (finish = resolve));
    const entry: Entry = { started, done };
    tails.set(sessionId, entry);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      start();
      finish();
      if (tails.get(sessionId) === entry) tails.delete(sessionId);
    };
    const ready = (async () => {
      if (ahead && !opts.draining?.()) {
        await ahead.started;
        const cap = ceiling(opts.capMs, opts.draining);
        try {
          await Promise.race([ahead.done, cap.reached]);
        } finally {
          cap.cancel();
        }
      }
      start();
    })();
    return { ready, release };
  }

  return { enter };
}

/** Reached after `ms`, or as soon as the daemon starts draining. Never keeps the process alive. */
function ceiling(ms: number, draining?: () => boolean): { reached: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    timer = null;
    poll = null;
  };
  const reached = new Promise<void>((resolve) => {
    const finish = (): void => {
      cancel();
      resolve();
    };
    timer = setTimeout(finish, ms);
    poll = draining ? setInterval(() => { if (draining()) finish(); }, 250) : null;
    timer.unref?.();
    poll?.unref?.();
  });
  return { reached, cancel };
}
