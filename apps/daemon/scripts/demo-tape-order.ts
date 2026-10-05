/**
 * The order a replay hands out what the shoot recorded (2026-10-05). A Bot's own answers come back
 * in its own order anyway; what drifts is how they interleave with another Bot's, and with the
 * renders the app polls on its own clock. Replayed answers come faster than the model gave them, so
 * the poll that told the Producer its second render was done landed after its turn had ended
 * instead of during it, the Reviewer's verdict woke it first, and the rest of the tape answered a
 * story that was no longer being told.
 *
 * So the answers that move the story — every Bot's turns, and each check that ended a render — go
 * out in the order the shoot recorded them, which is the order they ended in: one starts only when
 * those recorded before it have gone out in full.
 * When the next one is a render's end, `onNext` lets demo-tape ask the app to poll it now, as the
 * shoot's clock had it polled by then. An entry that never comes (a replay that went another way)
 * holds the rest up only so long before it is skipped, and the log says so.
 */
import { jobStatusOf } from "../src/engine/job-adapter";
import type { CheckArgs } from "./demo-tape-keys";

/** A sequenced tape entry: the queue it is answered from (`model:turn:制片`) and its place in it. */
export type Slot = { queue: string; index: number };

export type TurnstileOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** The entry next in line changed, or has stood there a while (`tick`): a render's end asks for its poll. */
  onNext?: (slot: Slot) => void;
  /** How long the entry next in line may keep a waiting request waiting before it is skipped. */
  patience?: (slot: Slot) => number;
  /** How long an entry waits after the one before it went out (another Bot's tools finishing first). */
  gap?: (previous: Slot, next: Slot) => number;
};

const NUDGE_AGAIN_MS = 20_000;

export class Turnstile {
  private readonly place = new Map<string, number>();
  private readonly gone = new Set<number>();
  private next = 0;
  private nextSince: number;
  private nudgedAt = 0;
  private last: { slot: Slot; at: number } | null = null;
  readonly skipped: string[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly patience: (slot: Slot) => number;

  constructor(
    private readonly order: Slot[],
    private readonly options: TurnstileOptions = {},
  ) {
    order.forEach((slot, position) => this.place.set(`${slot.queue}#${slot.index}`, position));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => {});
    this.patience = options.patience ?? (() => 60_000);
    this.nextSince = this.now();
    this.nudge();
  }

  /** Whether the entry may go out now: every sequenced one recorded before it has (or was skipped). An unsequenced entry always may. */
  due(queue: string, index: number): boolean {
    const position = this.place.get(`${queue}#${index}`);
    return position === undefined || position <= this.next || this.gone.has(position);
  }

  served(queue: string, index: number): void {
    const position = this.place.get(`${queue}#${index}`);
    if (position === undefined) return;
    this.gone.add(position);
    this.last = { slot: this.order[position]!, at: this.now() };
    this.advance();
  }

  /** An entry given back (its request was abandoned before the answer was out): next in line again. */
  unserved(queue: string, index: number): void {
    const position = this.place.get(`${queue}#${index}`);
    if (position === undefined) return;
    this.gone.delete(position);
    this.advance();
  }

  /**
   * Waits until the entry is due. The one next in line that keeps it waiting past its patience
   * (counted from when it came up, or from when this request came if later) is skipped. False when
   * the request was abandoned while it waited.
   */
  async wait(queue: string, index: number, signal?: AbortSignal): Promise<boolean> {
    const arrived = this.now();
    while (!this.due(queue, index)) {
      if (signal?.aborted) return false;
      const ahead = this.order[this.next]!;
      if (this.now() - Math.max(this.nextSince, arrived) >= this.patience(ahead)) {
        const what = `${ahead.queue} #${ahead.index}`;
        this.log(`SKIP ${what}: it never came, and ${queue} #${index} was waiting on it`);
        this.skipped.push(what);
        this.gone.add(this.next);
        this.advance();
        continue;
      }
      await this.sleep(100);
    }
    const last = this.last;
    const gap = last ? (this.options.gap?.(last.slot, { queue, index }) ?? 0) : 0;
    while (last && this.now() - last.at < gap) {
      if (signal?.aborted) return false;
      await this.sleep(50);
    }
    return true;
  }

  /** Called every few seconds: the entry next in line is nudged again while it stands there. */
  tick(): void {
    if (this.next < this.order.length && this.now() - this.nudgedAt >= NUDGE_AGAIN_MS) this.nudge();
  }

  /** The entries not out yet, in order: what the shoot recorded that this replay never asked for. */
  remaining(): string[] {
    return this.order.flatMap((slot, position) => (this.gone.has(position) ? [] : [`${slot.queue} #${slot.index}`]));
  }

  private advance(): void {
    let next = 0;
    while (this.gone.has(next)) next++;
    if (next === this.next) return;
    this.next = next;
    this.nextSince = this.now();
    this.nudge();
  }

  private nudge(): void {
    this.nudgedAt = this.now();
    const slot = this.order[this.next];
    if (slot) this.options.onNext?.(slot);
  }
}

/** What a recorded check answer (its JSON-RPC message) says, read the way the daemon reads it. */
export function checkState(answer: any): "pending" | "ended" {
  return jobStatusOf(answer?.result).state === "pending" ? "pending" : "ended";
}

/**
 * A "still going" answer for a check asked before the shoot's answer that ended the render is due:
 * the job's last recorded "still going" when the shoot heard one, else one written the way its end
 * was — `key: value` lines, or JSON.
 */
export function stillGoing(end: any, recorded: any | undefined, check: CheckArgs): any {
  if (recorded) return recorded;
  const texts: string[] = (end?.result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text));
  const json = texts.some((text) => {
    try {
      const value = JSON.parse(text);
      return value !== null && typeof value === "object";
    } catch {
      return false;
    }
  });
  const text = json
    ? JSON.stringify({ [check.param]: check.id, status: "pending" })
    : `status: pending\n${check.param}: ${check.id} (poll ${check.tool} again)`;
  return { jsonrpc: "2.0", result: { content: [{ type: "text", text }], isError: false } };
}
