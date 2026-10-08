/**
 * How a check proves its acceptance line: a file on disk, a command the app runs itself, or —
 * `continuity`, labelled 衔接一致 / "Seams" in the UI (the stored value stays `continuity`) — a
 * judge comparing adjacent parts of a deliverable several Bots made piecemeal (chapters, shots,
 * images, slides) against the plan's own rules and a fixed checklist (style, terms and names,
 * numbers and units, spatial/left-right consistency, missing transitions, repeated content). The
 * only kind that asks a model anything; every other kind is pure evaluation. `measure` is a video's
 * running time, resolution, aspect or frame rate, read with ffprobe against a range taken from
 * your words (`origin: "derived"`, ADR 0040 P3); only the app makes one, so it is not an input kind.
 */
export type AcceptanceCheckKind = "exists" | "contains" | "matches" | "command" | "continuity" | "measure";

/**
 * `pass`/`fail` are evidence either way. `blocked` (outside the workspace, or none set) and
 * `error` (the check itself is broken — a bad regex, a file too large, a spawn failure) are
 * neither: they hold nothing open and prove nothing done.
 */
export type AcceptanceCheckOutcome = "pass" | "fail" | "blocked" | "error";

/** Who may turn a command into a check: only the app, on the user's own words or a run it already saw. */
export type AcceptanceCheckSource = "organizer" | "user";

/**
 * Where a check came from: the organizer, you by hand, or `derived` — read by the app from a number
 * in your words about the job (ADR 0040 P3). A derived check's `source` is `user`: your words are
 * what it stands on, and the organizer never touches it.
 */
/** `reflection`: a check a Bot's reflection proposed and you adopted (ADR 0051) — a gate, but not yours until you edit it. */
/** `sample`: a standard check (照样片, ADR 0060) the app made when you approved a large job's sample — yours, as the sample it holds to is. */
export type AcceptanceCheckOrigin = "derived" | "organizer" | "user" | "reflection" | "sample";

/** Where a check from your words stands: offered to you, or a gate you confirmed. */
export type DerivedCheckState = "proposed" | "active";

/**
 * What a `measure` check reads off a video, and the range it must fall in; a null end is open.
 * `duration` in seconds, `resolution` in lines of the picture's short side, `fps` in frames a
 * second. `aspect` is a ratio ("16:9", "2.35:1"), met within 1%, or `portrait` / `landscape`.
 */
export type CheckMeasure =
  | { dimension: "duration" | "resolution" | "fps"; min: number | null; max: number | null }
  | { dimension: "aspect"; ratio: string };

/** Why a run happened: filing the plan, the user's own click, or a definition just (re)created. */
export type AcceptanceCheckRunCause = "settle" | "user" | "edit";

/** One run of one check: started, and — once it finishes — what came of it. */
export type AcceptanceCheckRun = {
  id: string;
  check_id: string;
  task_id: string;
  cause: AcceptanceCheckRunCause;
  started_at: string;
  finished_at: string | null;
  outcome: AcceptanceCheckOutcome | null;
  exit_code: number | null;
  detail: string;
  /** Tail of what the check produced; null when it has none (a file check, or nothing captured). */
  output: string | null;
  /** `vision` when a model looking at pictures gave the verdict: from engine level 5 a reference only (ADR 0046). */
  judged_by?: "vision" | null;
};

/**
 * An executable acceptance check (可执行验收): the app's own proof that one acceptance line holds,
 * run on this Mac, never on the Bot's say-so. `item` is the acceptance line it proves; a check
 * whose line no longer matches the plan's spec still runs and still counts, shown as an orphan.
 */
export type AcceptanceCheck = {
  id: string;
  task_id: string;
  ticket_id: string | null;
  item: string;
  kind: AcceptanceCheckKind;
  /**
   * `exists` / `contains` / `matches`: the file, workspace-root relative. `continuity`: the
   * deliverable, workspace-root relative — one file split into parts (a video by scene detection, a
   * Markdown/HTML file by its headings), or a glob whose matches are the ordered parts (natural
   * sort), or, for a single re-cut video master with no list command, the newest match.
   */
  path: string | null;
  /** `contains`: the needle. `matches`: the regex source (flags `mi`). */
  pattern: string | null;
  negate: boolean;
  /**
   * `command`: the shell command, run with `/bin/sh -c`. `continuity`: optional — a command whose
   * stdout lists the ordered part files, one per line, so seams are found between them instead of
   * by scene detection or a glob.
   */
  command: string | null;
  /** `command` / `continuity`: workspace-relative; null defaults to the ticket's dir, else the plan's. */
  cwd: string | null;
  expect_exit: number | null;
  expect_stdout: string | null;
  timeout_sec: number | null;
  source: AcceptanceCheckSource;
  /** Absent from a daemon older than checks from your words; read it as `source` then. */
  origin?: AcceptanceCheckOrigin;
  /** `measure`: what it reads and the range; null on every other kind. */
  measure?: CheckMeasure | null;
  /**
   * How a derived check found the file it looks at (`path`): `glob`, the job's final deliverable by
   * its name (`bind_glob`: `*MASTER*`, `*final*` or `deliverables/**`). Null while it has found
   * none: then it has never run, holds nothing open and proves nothing, shown as not bound yet.
   */
  bind_kind?: "glob" | null;
  bind_glob?: string | null;
  /**
   * A derived check's standing (ADR 0040 P3): `proposed`, offered to you — measured once it has a
   * file, its result shown, holding nothing back; `active`, a gate, which only your confirm makes.
   * Null on every other check.
   */
  derived_state?: DerivedCheckState | null;
  /**
   * A standard check (照样片, ADR 0060): the sample ticket this ticket's hand-over is compared with —
   * kind `continuity`, made by the app when you approve the sample. Null on every other check.
   */
  standard_of?: string | null;
  created_at: string;
  updated_at: string;
  /** When this definition took effect; a redefinition bumps it and drops the runs before it. */
  defined_at: string;
  /** The first time this definition passed; null until it has, reset on redefinition. */
  first_passed_at: string | null;
  last_run: AcceptanceCheckRun | null;
  /** A run is in flight right now. */
  running: boolean;
};

/** `POST /v1/tasks/:id/checks` and the writable fields of `PATCH /v1/checks/:id`. */
export type AcceptanceCheckInput = {
  item: string;
  ticket_id?: string | null;
  kind: Exclude<AcceptanceCheckKind, "measure">;
  path?: string | null;
  pattern?: string | null;
  negate?: boolean;
  command?: string | null;
  cwd?: string | null;
  expect_exit?: number | null;
  expect_stdout?: string | null;
  timeout_sec?: number | null;
};

export type PatchAcceptanceCheckRequest = Partial<AcceptanceCheckInput> & {
  /** The check's `updated_at` you edited from; a mismatch is refused. */
  if_revision?: string;
};

/** `POST /v1/tasks/:id/checks/run`: one check, or every active check when absent. */
export type RunAcceptanceChecksRequest = {
  check_id?: string;
};
