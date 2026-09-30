/**
 * Telling you what a restart cut off (ADR 0041). A restart ends every turn that was running, and
 * the 「中断」 line goes where the turn ran — for a long job, mostly a Bot↔Bot direct you are not
 * in — so on 2026-09-26 a job cut off that way sat for 7.6 hours until you noticed. At boot, as soon
 * as the engine is up and before the scheduler's first tick (so a check-back that fell due while the
 * daemon was down cannot wake a Bot first), each job the restart cut off gets one line in the
 * conversation it belongs to where you are, with a notification: why the daemon started again, each
 * of its turns and the step it was on, and two buttons, 继续 and 不续.
 *
 * Why it started again is read from how this run is started and how the last one ended: `dev` for a
 * development run whatever the last one wrote, else `clean` after a deliberate stop
 * (`settings.last_shutdown`), else `crash`.
 * Nothing goes on by itself yet: which restarts may pick work up on their own, and how often, is
 * the supervisor's (ADR 0040 P4c), and until it can check whether the last call's side effect went
 * through, going on unasked could submit a paid render twice. So every cause waits for your button;
 * the cause is recorded and said.
 */
import { USER_MEMBER, type ControlActionResult, type Message, type RestartCause, type Session, type Turn } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { restartNoticeBody, type ControlTurnLine } from "../prompts";
import type { Store } from "../store";

export type RestartDeps = {
  store: Store;
  publishMessage: (message: Message) => void;
  /** Continue on an interrupted turn's 「中断」 line, as its own Continue does (holds and all). */
  continueFromInterrupt: (messageId: string) => Turn;
};

/** What a boot told you: the jobs it put a line in for, and the turns in them. */
export type RestartSummary = { cause: RestartCause; jobs: number; turns: number };

export type Restart = {
  /** Called once at boot, after recovery and before the scheduler starts: one line per job the restart cut off, and a work-log row. */
  announce: (cause: RestartCause) => RestartSummary;
  /**
   * `POST /v1/messages/:id/control` on a restart notice: 继续 (`resume`) or 不续 (`leave`). A 继续
   * that a stop of yours kept from some of the turns returns `partial` and leaves the notice unanswered.
   */
  act: (message: Message, input: { action: unknown }) => ControlActionResult;
};

/** How this process runs, as far as telling a development run apart goes. */
export type RunShape = { execArgv: readonly string[]; env: Readonly<Record<string, string | undefined>> };

/** How many hops up a Bot↔Bot direct's origins the notice looks for a conversation you are in. */
const ORIGIN_HOPS = 5;
/** How much of the last step a notice shows. */
const STEP_MAX = 80;

/**
 * Why the daemon started again. A deliberate stop wrote `clean` on its way out; anything else left
 * the `crash` every boot writes for itself. A development run is `dev` whatever the flag says:
 * `bun --watch` sends SIGTERM and restarts the process in place without waiting for it to exit,
 * and the SIGTERM handler's stop writes `clean` before its first await, so there the flag cannot
 * tell a save from a quit. Counting a deliberate quit of a development run as `dev` is the careful
 * side of that.
 */
export function classifyRestart(previous: "clean" | "crash", run: RunShape): RestartCause {
  if (isDevRun(run)) return "dev";
  return previous;
}

/** A source run that restarts itself when its code changes (`bun --watch` / `--hot`), or one started with `REAL_BOT_DEV=1`. */
export function isDevRun(run: RunShape): boolean {
  return run.execArgv.some((arg) => arg === "--watch" || arg === "--hot") || run.env.REAL_BOT_DEV === "1";
}

export function createRestart(deps: RestartDeps): Restart {
  const { store, publishMessage, continueFromInterrupt } = deps;

  function announce(cause: RestartCause): RestartSummary {
    const cut = store.takeTurnsCutByRestart();
    store.recordWorkEvent({ kind: "daemon.restart", actor: "app", payload: { cause, cut: cut.map((row) => row.turn.id) } });
    // One line per job and place: a plan's turns go to the plan's conversation, turns on no plan to
    // wherever each is told, so the turns of one plan cut in three directs make one line.
    const jobs = new Map<string, { where: string; plan: string | null; cut: typeof cut }>();
    for (const row of cut) {
      const where = placeToTell(row.turn);
      if (!where) continue;
      const plan = row.turn.task_id ?? null;
      const key = `${where}|${plan ?? ""}`;
      const job = jobs.get(key) ?? { where, plan, cut: [] };
      job.cut.push(row);
      jobs.set(key, job);
    }
    let turns = 0;
    for (const job of jobs.values()) {
      turns += job.cut.length;
      const notice = store.transaction(() => {
        const notice = store.insertMessage({
          sessionId: job.where,
          kind: "system",
          author: job.cut[0]!.turn.bot_id,
          body: restartNoticeBody(locale(), {
            cause,
            plan: job.plan ? planTitle(job.plan) : null,
            turns: job.cut.map((row) => turnLine(row.turn, job.where)),
          }),
          // For you: a Bot reading "the daemon restarted, the job was cut off" would take it as a cue.
          hiddenFromBots: true,
          control: { kind: "restart", cause, notes: job.cut.map((row) => row.note.id), offer: ["resume", "leave"] },
        });
        // One notification per job: the notice's stands for the ones the turns' own lines made.
        for (const row of job.cut) store.updateNotificationActionState(`interrupted:${row.turn.id}`, "voided", "restart_notice");
        store.createNotification({
          semantic_key: `restart:${notice.id}`,
          kind: "interrupted",
          session_id: job.where,
          message_id: notice.id,
          action_state: "open",
        });
        return notice;
      });
      publishMessage(notice);
    }
    return { cause, jobs: jobs.size, turns };
  }

  function act(message: Message, input: { action: unknown }): ControlActionResult {
    const control = message.control;
    if (control?.kind !== "restart") throw new HttpError(422, "invalid_args", "this line is not a restart notice");
    const action = input.action;
    if ((action !== "resume" && action !== "leave") || !control.offer.includes(action)) {
      throw new HttpError(422, "invalid_args", "this line does not offer that button");
    }
    // One press per notice, as on every line with buttons: a second tap or a retry does nothing more.
    if ((control.acted ?? []).length > 0) return { made: [], lifted: [] };
    if (action === "resume") {
      // Each turn goes on the way its own Continue would. One that cannot any more — continued
      // already (from its own 「中断」 line, say: then a press with nothing left to do is a quiet
      // success), its Bot already at work there, the conversation or Bot gone — is left as it is.
      // A drain fails the press so it can be pressed again once it is over. A turn a stop of yours
      // holds stays stopped: with nothing else to go on, the press fails with the stop's 409; beside
      // turns that did go on, it says how many of each and stays unanswered, so 继续 takes the rest
      // once the stop is lifted.
      let refused: unknown = null;
      let held: unknown = null;
      let heldCount = 0;
      let continued = 0;
      for (const noteId of control.notes) {
        try {
          if (store.getMessage(noteId).source_turn_id) continue;
          continueFromInterrupt(noteId);
          continued += 1;
        } catch (error) {
          if (error instanceof HttpError && (error.status === 422 || error.status === 404)) continue;
          if (error instanceof HttpError && error.status === 409 && error.code === "held") {
            held ??= error;
            heldCount += 1;
            continue;
          }
          refused ??= error;
        }
      }
      if (refused) throw refused;
      if (heldCount > 0 && continued === 0) throw held;
      if (heldCount > 0) return { made: [], lifted: [], partial: { continued, held: heldCount } };
    }
    store.transaction(() => {
      store.setMessageControl(message.id, { ...control, acted: [action] });
      store.updateNotificationActionState(`restart:${message.id}`, "resolved", action === "resume" ? "continued" : "left", true);
    });
    return { made: [], lifted: [] };
  }

  /**
   * Where you are told about a turn: its plan's conversation when you are in it; else its own
   * conversation when you are; else, from a Bot↔Bot direct, the first conversation you are in up
   * the line that opened it; else your direct with the Bot. Null when there is none of these.
   */
  function placeToTell(turn: Turn): string | null {
    const withYou = (id: string | null | undefined): string | null => {
      if (!id) return null;
      try {
        const session = store.getSession(id);
        return !session.archived_at && store.isPresent(id, USER_MEMBER) ? id : null;
      } catch {
        return null;
      }
    };
    const home = turn.task_id ? taskSession(turn.task_id) : null;
    const near = withYou(home) ?? withYou(turn.session_id);
    if (near) return near;
    let at: Session | null = safeSession(turn.session_id);
    for (let hop = 0; at?.origin_session_id && hop < ORIGIN_HOPS; hop += 1) {
      const up = withYou(at.origin_session_id);
      if (up) return up;
      at = safeSession(at.origin_session_id);
    }
    return withYou(store.findDirectSession(USER_MEMBER, turn.bot_id)?.id);
  }

  function turnLine(turn: Turn, where: string): ControlTurnLine {
    // A shell run records its command line; an MCP call, `server.tool` and its arguments.
    const last = store.turnRuns(turn.id).at(-1);
    const step = last ? clip(last.command) : null;
    return {
      bot: botName(turn.bot_id),
      plan: turn.task_id ? planTag(turn.task_id, turn.ticket_id ?? null) : null,
      where: turn.session_id === where ? null : placeOf(turn.session_id, turn.bot_id),
      lastStep: step,
    };
  }

  function locale() {
    return store.settingsCached().locale;
  }

  function taskSession(taskId: string): string | null {
    try {
      return store.getTask(taskId).session_id;
    } catch {
      return null;
    }
  }

  function safeSession(id: string): Session | null {
    try {
      return store.getSession(id);
    } catch {
      return null;
    }
  }

  function planTitle(taskId: string): string {
    try {
      return store.getTask(taskId).title;
    } catch {
      return taskId;
    }
  }

  /** The turn's part of the plan: its ticket, or the plan itself when it had none. */
  function planTag(taskId: string, ticketId: string | null): string {
    const en = locale() === "en";
    if (ticketId) {
      try {
        const ticket = store.getTicket(ticketId);
        const seq = String(ticket.seq).padStart(2, "0");
        return en ? `ticket ${seq} "${ticket.title}"` : `任务 ${seq}《${ticket.title}》`;
      } catch {
        // the ticket went with a cleared plan; the plan still names the work
      }
    }
    const title = planTitle(taskId);
    return en ? `the plan "${title}"` : `规划「${title}」`;
  }

  /** A conversation, as you would name it; a direct between Bots names `first` first, the Bot the line is about. */
  function placeOf(sessionId: string, first: string): string {
    const en = locale() === "en";
    const session = safeSession(sessionId);
    if (!session) return en ? "a conversation since deleted" : "一个已删除的会话";
    if (session.kind === "group") return session.name ? (en ? `group "${session.name}"` : `群「${session.name}」`) : en ? "a group" : "一个群";
    const ids = store.presentBotIds(sessionId);
    const bots = [...ids.filter((id) => id === first), ...ids.filter((id) => id !== first)].map(botName);
    if (store.isPresent(sessionId, USER_MEMBER)) return en ? `your direct with ${bots[0] ?? "?"}` : `你和${bots[0] ?? "?"}的私聊`;
    return en ? `the direct between ${bots.join(" and ")}` : `${bots.join("和")}的私聊`;
  }

  function botName(id: string): string {
    try {
      return store.getBot(id).name;
    } catch {
      return id;
    }
  }

  return { announce, act };
}

function clip(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > STEP_MAX ? `${chars.slice(0, STEP_MAX - 1).join("")}…` : chars.join("");
}
