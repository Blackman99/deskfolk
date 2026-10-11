/**
 * One job on screen: the jobs to switch between, the one picked, its trace and its plan, and what is
 * picked in it — a ticket, a step. Everything that shows the job reads the same copy, so a ticket
 * picked in one place is the ticket lit everywhere and a job switched to is switched to everywhere.
 *
 * What it does not own is the trace's picture: the camera, the folds, the measured cards and what a
 * job's board is kept as between visits stay with the trace, which hears of a switch through
 * `onSwitch` before the next job's picture is read.
 */
import type { SessionTaskSummary, TaskDetail, TaskTrace, Ticket } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import { defaultJob } from "./plan-board.ts";
import { lineBoard } from "./trace-steps.ts";

export type JobHost = {
  api: () => MessengerApi | null;
  /** The conversation whose jobs are listed. */
  sessionId: () => string;
  /** The job asked for from outside, read again when the one on screen is not known yet. */
  taskId: () => string | null;
  /** A line of yours filed under no job, drawn as a flow of its own (ADR 0083). */
  line: () => string | null;
  /** The job actually on screen, so the address follows the switcher. */
  onTask?: (taskId: string) => void;
  /**
   * Another job is about to be the one on screen: the picture keeps the one it leaves and takes up
   * how the next was left. Called before `currentId` moves.
   */
  onSwitch?: (sessionId: string, next: string | null) => void;
};

export class JobState {
  jobs = $state<SessionTaskSummary[]>([]);
  trace = $state<TaskTrace | null>(null);
  currentId = $state<string | null>(null);
  loading = $state(true);
  failed = $state(false);
  /**
   * The plan behind the trace: its spec, revision and tickets. Null until it arrives, and null
   * for good on a daemon that predates plans — the tree still draws, without the panel and rail.
   */
  detail = $state<TaskDetail | null>(null);
  /** The ticket whose cards are lit; the rest of the board dims. One at a time, like a highlight. */
  selectedTicket = $state<string | null>(null);
  /** The step whose panel is open. */
  openStep = $state<string | null>(null);
  /**
   * The conversation the job on screen was listed for. It is the key the board is kept under, and
   * by the time a different conversation's job is being loaded the prop already names that one.
   */
  boardSession: string | null = null;
  #loadSeq = 0;
  readonly #host: JobHost;

  constructor(host: JobHost) {
    this.#host = host;
  }

  /** The plan behind a trace; none from a daemon that predates plans, and none is not a failure. */
  async #readDetail(id: string): Promise<TaskDetail | null> {
    try {
      return await this.#host.api()!.taskDetail(id);
    } catch {
      return null;
    }
  }

  async load(id: string | null): Promise<void> {
    const seq = ++this.#loadSeq;
    const api = this.#host.api();
    if (!api) {
      this.loading = false;
      this.failed = true;
      return;
    }
    this.loading = true;
    this.failed = false;
    const session = this.#host.sessionId();
    const line = this.#host.line();
    if (line) {
      // One line's own board: no jobs to switch between, no plan behind it.
      try {
        const board = lineBoard(await api.lineTrace(line));
        if (seq !== this.#loadSeq) return;
        this.jobs = [];
        this.detail = null;
        this.currentId = null;
        this.boardSession = session;
        this.trace = board;
      } catch {
        if (seq === this.#loadSeq) this.failed = true;
      } finally {
        if (seq === this.#loadSeq) this.loading = false;
      }
      return;
    }
    try {
      const listed = await api.sessionTasks(session);
      if (seq !== this.#loadSeq) return;
      this.jobs = listed;
      // With none asked for, the newest job that was work: a question and its answer is not what you came back to.
      const next = id && listed.some((job) => job.id === id) ? id : (defaultJob(listed)?.id ?? null);
      // A refresh of the same plan keeps what you unfolded and lit. Switching plans leaves this
      // one as it is, to come back to, and takes the next one up as it was left, or fresh.
      if (next !== this.currentId) this.#host.onSwitch?.(session, next);
      this.currentId = next;
      this.boardSession = session;
      if (next) this.#host.onTask?.(next);
      // The tree and the plan, together. A daemon that predates plans answers the second with a
      // 404, and the board is then the tree alone — as it was.
      const [nextTrace, nextDetail] = next ? await Promise.all([api.taskTrace(next), this.#readDetail(next)]) : [null, null];
      if (seq !== this.#loadSeq) return;
      this.trace = nextTrace;
      this.detail = nextDetail;
      if (next && !this.trace) this.failed = true;
    } catch {
      if (seq !== this.#loadSeq) return;
      this.failed = true;
    } finally {
      if (seq === this.#loadSeq) this.loading = false;
    }
  }

  /** Another job, picked in the switcher. */
  selectJob(id: string): void {
    if (id === this.currentId) return;
    void this.load(id);
  }

  /** The plan changed under an edit, or a ticket moved: read it again, the tree with it. */
  reloadPlan(): void {
    void this.load(this.currentId ?? this.#host.taskId());
  }

  /** A ticket you moved comes back alone; the plan's counts and revision moved with it. */
  ticketPatched(ticket: Ticket): void {
    if (!this.detail) return;
    this.detail = {
      ...this.detail,
      revision: this.detail.revision + 1,
      revision_actor: "user",
      tickets: this.detail.tickets.map((row) => (row.id === ticket.id ? { ...row, ...ticket } : row)),
    };
    this.reloadPlan();
  }
}
