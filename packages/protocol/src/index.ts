/** Local API types, thinking-level helpers, mention parsing, and cited-path detection. */

export const LOCAL_API_BIND = "127.0.0.1:17890" as const;
export const LOCAL_API_HOST = "127.0.0.1" as const;
export const LOCAL_API_PORT = 17890 as const;
export const LOCAL_API_NAME = "real-bot" as const;
export const LOCAL_API_PREFIX = "/v1" as const;

export const KEYCHAIN_SERVICE = "com.real-bot.daemon" as const;
export const KEYCHAIN_NAME = "endpoint-api-key" as const;
export const KEYCHAIN_REF = "keychain:com.real-bot.daemon/endpoint-api-key" as const;

export function providerKeychainName(id: string): string {
  return `${KEYCHAIN_NAME}:${id}`;
}

export function providerKeychainRef(id: string): string {
  return `keychain:${KEYCHAIN_SERVICE}/${providerKeychainName(id)}`;
}

export const MCP_AUTH_KEYCHAIN_NAME = "mcp-auth" as const;

export function mcpAuthKeychainName(id: string): string {
  return `${MCP_AUTH_KEYCHAIN_NAME}:${id}`;
}

export type McpTransport = "stdio" | "http";

export type McpHeader = {
  name: string;
  value: string;
};

export const APP_SUPPORT_DIRNAME = "real-bot" as const;
export const LOCAL_API_DESCRIPTOR_NAME = "local-api.json" as const;
export const STATE_DB_NAME = "state.sqlite" as const;



export const USER_MEMBER = "user" as const;

/**
 * The one you↔Mac conversation that exists only to receive files sent over remote control.
 * Not a Bot: a file posted here is copied into `inbox/` and never starts a turn.
 */
export const FILE_DROP_SESSION_ID = "filedrop" as const;

/** Bot `update_profile` used to insert these; they are no longer shown. */
export function isHiddenTranscriptKind(kind: string): boolean {
  return kind === "profile_change";
}

/** Transcript body when a live turn is marked interrupted. Chinese in every locale. */
export const INTERRUPT_NOTE_BODY = "中断" as const;

export const UNREACHABLE_NOTE_BODIES = [
  "这一轮没写完：连不上端点",
  "This turn did not finish: Couldn't reach the endpoint",
] as const;

/** A turn that stopped on its own, in either locale: 「这一轮没写完：…」. */
const FAIL_NOTE = /^(?:这一轮没写完：|This turn did not finish:)/;

export function isInterruptNote(message: Pick<Message, "kind" | "body">): boolean {
  return message.kind === "system" && message.body === INTERRUPT_NOTE_BODY;
}

export function isUnreachableNote(message: Pick<Message, "kind" | "body">): boolean {
  return (
    message.kind === "system" &&
    (UNREACHABLE_NOTE_BODIES as readonly string[]).includes(message.body)
  );
}

export function isContinuableNote(message: Pick<Message, "kind" | "body">): boolean {
  return isInterruptNote(message) || (message.kind === "system" && FAIL_NOTE.test(message.body));
}

/** Encrypted Web Push body. Visible copy is fixed; never titles, filenames or Bot names. */
export const WEB_PUSH_PAYLOAD = { t: "pending" } as const;
export const WEB_PUSH_COPY = {
  zh: "Deskfolk 有待处理事项",
  en: "Deskfolk has pending items",
} as const;

export const REACTION_EMOJI = ["👍", "👀", "❤️", "❗"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export type HealthResponse = {
  ok: true;
  name: typeof LOCAL_API_NAME;
};

export type RuntimeResponse = {
  pid: number;
  bind: typeof LOCAL_API_BIND;
  version?: string;
  mode?: "window" | "standalone" | "none";
  stopped?: boolean;
  restart?: "available" | "unavailable";
};

/**
 * `GET /v1/capabilities`: this build's engine, not the app version. A phone page is deployed
 * separately from the daemon it talks to and can be the newer of the two, so it reads this instead
 * of assuming its own build's features are all there (ADR 0040's version gate).
 */
export type CapabilitiesResponse = {
  schema_level: number;
  engine_level: number;
  features: string[];
};

/**
 * `POST /v1/capabilities/raise`, local only (never on the remote whitelist): a developer's word that
 * this data folder's engine level may go up although an installed app that shares it predates the
 * version gate, which would not honor what the level writes if opened without this daemon (ADR
 * 0041). Recorded, then carried out at once; answered with `CapabilitiesResponse`. `by` is
 * `script` from `apps/daemon/scripts/engine-level.ts`, `api` otherwise. `DELETE` on the same path
 * takes the word back and leaves the level where it is.
 */
/** `level`: how far the opt-in lets the data folder go (1 up to this build's top level, which it defaults to). */
export type RaiseEngineLevelRequest = { accept_older_app: true; by?: "api" | "script"; level?: number };

export type LocalApiDescriptor = {
  pid: number;
  port: number;
  token: string;
  started_at: string;
};

export type LocalApiDiscovery = {
  port: number;
  token: string;
};

export type ErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "not_found"
  | "conflict"
  | "key_write_pending"
  | "credential_superseded"
  | "receipt_expired"
  | "not_retryable"
  | "invalid_args"
  | "not_a_member"
  | "ambiguous"
  | "denied"
  | "not_text"
  | "too_large"
  | "failed";

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
  };
};

export type ListPage<T> = {
  items: T[];
  next?: string | null;
};

/**
 * Fallback thinking levels when a catalog row does not list any. Endpoints may advertise others
 * (`xhigh`, `max`, `minimal`, …) as `reasoning_effort` values; those names are stored and sent as-is.
 */
export const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
/** A completion `reasoning_effort` name: the four fallbacks, or whatever the endpoint advertised. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number] | string;

const THINKING_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  min: 1,
  low: 2,
  medium: 3,
  default: 3,
  high: 4,
  xhigh: 5,
  extra_high: 5,
  max: 6,
  maximum: 6,
};

/** Token the completions API will accept as `reasoning_effort`. */
const THINKING_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function isThinkingLevel(value: string): boolean {
  return THINKING_TOKEN.test(value.trim());
}

export function thinkingLevelRank(level: string): number {
  const key = level.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(THINKING_RANK, key)) return THINKING_RANK[key]!;
  return 3.5;
}

/** Dedupes (case-insensitive, first spelling wins) and orders from lightest to heaviest. */
export function sortThinkingLevels(levels: readonly string[]): ThinkingLevel[] {
  const out: ThinkingLevel[] = [];
  const seen = new Set<string>();
  for (const raw of levels) {
    const level = raw.trim();
    if (!level) continue;
    const key = level.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(level as ThinkingLevel);
  }
  out.sort((a, b) => {
    const delta = thinkingLevelRank(a) - thinkingLevelRank(b);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  return out;
}

/** USD per million tokens, captured when a spend row is written. */
export type ModelPricing = { input: number; output: number; cached_input?: number };

/** A completion name with independent routing reference price and optional billing rates. */
export type EndpointModel = {
  name: string;
  price: number | null;
  pricing?: ModelPricing;
  thinking_levels: ThinkingLevel[];
  strengths: string[];
  /** Output token cap each turn hop sends as `max_tokens`, reasoning included; absent uses the daemon's default. */
  max_output?: number;
  /** Measured streaming speed, 10th percentile, in tokens per second; sizes how long one hop may stream. */
  stream_tps_p10?: number;
  /**
   * Whether raising the thinking level actually buys more reasoning past a tool loop's first two
   * hops (the model-probe's measure: none vs high, hop ≥3 reasoning-token share); absent means
   * unmeasured. Stored only for now — P5's escalation ladder reads it before deciding whether to
   * raise a model's thinking level or skip straight to the next model.
   */
  reasoning_effective?: boolean;
  /**
   * Whether the model takes pictures as input (ADR 0049): true or false as you set it (or a probe
   * read it); absent means not known, and is treated as able. From engine level 7 a turn that needs
   * to see pictures only runs on a model not marked false.
   */
  input_image?: boolean;
};

export type EndpointModelInput = string | {
  name: string;
  price?: number | null;
  pricing?: ModelPricing;
  thinking_levels?: ThinkingLevel[];
  strengths?: string[];
  /** Left out, a saved entry keeps the value it had; null clears it. */
  max_output?: number | null;
  stream_tps_p10?: number | null;
  reasoning_effective?: boolean | null;
  input_image?: boolean | null;
};

/** One name from an endpoint `GET /models`, plus thinking levels that object advertised. */
export type ProbedModel = {
  name: string;
  thinking_levels: ThinkingLevel[];
};

export type ProbeModelsResponse = {
  models: string[];
  catalog: ProbedModel[];
};

export type Settings = {
  settings_rev?: number;
  workspace_path: string | null;
  endpoint_base_url: string | null;
  endpoint_key_set: boolean;
  endpoint_models: string[];
  endpoint_model_catalog: EndpointModel[];
  endpoint_default_model: string | null;
  default_provider_id: string | null;
  /**
   * The model that reads each line for what the app acts on (读句, ADR 0055); null follows the
   * default endpoint's default model. Null as well once the endpoint is gone or no longer lists it;
   * absent from a daemon older than that ADR.
   */
  reader_model?: ReaderModel | null;
  launch_at_login: boolean;
  locale: Locale;
  theme: Theme;
  wizard_complete: boolean;
};

/** An endpoint and one of its models, for reading lines (`Settings.reader_model`). */
export type ReaderModel = { provider_id: string; model: string };

export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
};

/** What a plan's entry lists: every path its messages cited that is still there, newest citation first. */
export type TaskArtifacts = {
  id: string;
  dir: string;
  title: string;
  closed_at: string | null;
  items: Array<{ path: string; last_cited_at: string; turn_id: string | null; ticket_id: string | null }>;
};

/** A plan (规划) is active until the organizer or you say it is done or parked. */
export type PlanStatus = "active" | "done" | "parked";

/** A ticket (任务) moves through these as the work does; done and parked close it. */
export type TicketStatus = "todo" | "doing" | "review" | "done" | "parked";

/**
 * A ticket's stage (ADR 0046, engine level 5): handed over (`submitted`), with its reviewer
 * (`in_review`), sent back (`rework`), passed (`approved`). Only a submission's checks, a review or
 * the app's no-reviewer approval moves it; `status` is written beside it (submitted and in_review
 * read review, rework reads doing, approved reads done, dropped reads parked).
 */
export type TicketStage = "todo" | "doing" | "submitted" | "in_review" | "rework" | "approved" | "dropped";

/** One hand-over of a ticket's work (ADR 0046): its files by content hash, the checks the app ran, the reviews it got. */
export type Submission = {
  id: string;
  work_item_id: string | null;
  task_id: string;
  ticket_id: string;
  part_keys: string[];
  bot_id: string;
  model: string | null;
  turn_id: string | null;
  /** `submit` when the Bot handed it over; `implicit` when the app did, for new files a segment cited in its ticket's folder. */
  origin: "submit" | "implicit";
  artifacts: Array<{ path: string; sha256: string }>;
  claims: Array<{ requirement_id: string; claim: string; evidence: string }>;
  note: string | null;
  state: "checking" | "checks_failed" | "submitted" | "in_review" | "approved" | "rejected" | "superseded";
  /** Each check the app ran on it: `gate` ones decide; the rest (your words not confirmed yet) are shown, never a block. */
  checks: Array<{ check_id: string; item: string; gate: boolean; outcome: string; detail: string }>;
  reviews: Array<{
    reviewer_bot_id: string;
    reviewer_model: string | null;
    /** The reviewer ran on the producer's own model. */
    same_model: boolean;
    turn_id: string;
    verdicts: Array<{ requirement_id: string; verdict: "pass" | "fail" | "unknown" | "n/a"; evidence: string[] }>;
    outcome: "approve" | "reject";
    note: string | null;
    at: string;
  }>;
  /** Its approval waiting on you: the required items nothing backs, the card that asks you, the review it would complete. */
  awaiting: {
    requirement_ids: string[];
    check_ids: string[];
    message_id: string | null;
    review: Submission["reviews"][number] | null;
    at: string;
  } | null;
  created_at: string;
  updated_at: string;
};

/** A part of a ticket (分件, ADR 0046): one shot or piece, from the plan's items, a delivered file's name, or you. */
export type TicketPart = {
  id: string;
  ticket_id: string;
  key: string;
  title: string;
  declared_by: "plan_items" | "filename" | "user";
  stage: "todo" | "in_progress" | "submitted" | "approved" | "rework" | "blocked" | "waived";
  owner_bot_id: string | null;
  current_artifact: string | null;
  attempts: number;
};

/**
 * A plan's spec (要点): what the organizer last understood the plan to be. Every field is the
 * app's reading of the conversation, revised as it goes; you can edit it, and each version is kept.
 */
export type PlanSpec = {
  /** A short label for what kind of job this is, which the organizer reuses across plans. */
  kind: string | null;
  goal: string;
  /** What counts as done: lines you write on the board (the organizer no longer writes them, ADR 0042). */
  acceptance: string[];
  /** Standing constraints and the preferences you stated, written the same way. */
  rules: string[];
  /** How the team goes about it, and who does which part. */
  process: string[];
  progress: { done: string[]; open: string[]; blocked: string[] };
  status: PlanStatus;
};

/** The smallest unit of a plan that hands something over, with its own folder inside the plan's. */
export type Ticket = {
  id: string;
  task_id: string;
  /** The ticket's number in its plan; the folder is `NN-slug/`. */
  seq: number;
  title: string;
  slug: string;
  dir: string;
  spec: string;
  status: TicketStatus;
  /** The Bot observed working on it, as a record, not an assignment. */
  worker: string | null;
  /**
   * Who the supervisor calls back to it (ADR 0045): the worker, written alongside it; for a ticket
   * older than the supervisor with no worker, the Bot with the most turns on it. Absent from a
   * daemon before that level.
   */
  owner_bot_id?: string | null;
  /** Tickets of the same plan this one waits for (ADR 0045); absent from a daemon before that level. */
  depends_on?: string[];
  /** Its stage (ADR 0046); null until engine level 5 moves it, and then read it before `status`. Absent from older daemons. */
  stage?: TicketStage | null;
  /** The Bot that reviews its submissions (ADR 0046), set on the board; never its owner; null for none. Absent from older daemons. */
  reviewer_bot_id?: string | null;
  /** The model its turns run on, set on the board from level 7 (ADR 0049): over the Bot's pin and default. Null for none. */
  model_override?: TicketModel | null;
  /**
   * The job's sample (样片, ADR 0060): the one unit made first to the full standard, which the job's
   * other tickets wait for and are compared with; you approve it yourself. Absent from older daemons.
   */
  sample?: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type TicketArtifactRef = { path: string; message_id: string; attachment_id: string; exists?: boolean };

/**
 * Who has the ball on a ticket (ADR 0045), as the board shows it from engine level 4: a Bot (its
 * owner, the plan's lead, the Bot a delegation went to, its reviewer), the app (an approval due at
 * the next tick, a render it polls), or you (a question, something blocked, a stop, an approval, the
 * capability ceiling, or nobody on it). `since`: when a delegation went out.
 */
export type TicketBall = {
  kind: "owner" | "lead" | "delegation" | "reviewer" | "app" | "user";
  bot_id?: string | null;
  reason?: "approval" | "job" | "ask" | "blocked" | "held" | "held_dependency" | "waits" | "review" | "ceiling" | "unclaimed";
  since?: string;
  /** `waits`: the ticket it waits for, not through yet (ADR 0060) — nobody starts it meanwhile. */
  waits_for?: string;
};

export type TicketWithArtifacts = Ticket & {
  artifacts: TicketArtifactRef[];
  /** Its parts (ADR 0046): how many there are and how many passed (「11/12 已通过」); absent from older daemons. */
  parts?: { total: number; approved: number };
  /** From level 4, an open ticket's: who it waits on now. Absent on a closed ticket and below the level. */
  ball?: TicketBall;
};

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

/** One version of a plan's spec, with the tickets as they stood after it. */
export type TaskSpecRevision = {
  id: string;
  task_id: string;
  revision: number;
  actor: "app" | "user";
  spec: PlanSpec;
  tickets_snapshot: Ticket[];
  /** The message that prompted the organizer, when one did. */
  source_message_id: string | null;
  source_turn_id: string | null;
  /** The session that message is in, so the board can jump to it. */
  session_id: string | null;
  created_at: string;
  /**
   * `hold`: a hold of yours parked the plan, or lifting it put the plan back (ADR 0040); not a
   * filing by the organizer or you, though `actor` says app. Null for every other version; absent
   * from a daemon older than holds.
   */
  cause?: "hold" | null;
};

export type TicketCounts = Record<TicketStatus, number>;

/**
 * One card on a plan's trace: a turn that happened, with the files that turn handed over.
 * Computed when the trace is opened. The ticket it worked in is a record, not an assignment.
 */
export type TaskTraceNode = {
  turn_id: string;
  session_id: string;
  /** `user` for the card that stands for your own message; otherwise the Bot who took the turn. */
  actor: typeof USER_MEMBER | string;
  status: TurnStatus;
  /** The turn whose message woke this one. Null when you started it, or when that turn is elsewhere. */
  woken_by_turn_id: string | null;
  /**
   * Set when what woke this turn is not on this board: a Bot's handoff that belongs to another
   * job. Without it such a turn reads as though you sent the message yourself.
   */
  woken_elsewhere: { actor: string; message_id: string } | null;
  trigger_message_id: string;
  /** The message to scroll to: the 中断 note on a cut turn, else this turn's last word, else the trigger. */
  focus_message_id: string;
  /** One line, already clipped. */
  summary: string;
  created_at: string;
  /** `exists` is set by the trace endpoint; absent from a daemon that predates it. */
  artifacts: Array<{ path: string; message_id: string; attachment_id: string; exists?: boolean }>;
  /** Set only while the turn is still waiting on you. */
  ask: { message_id: string; question: string } | null;
  approval: { message_id: string | null; summary: string } | null;
  /** Bots who watched the trigger instead of joining. Only the card that opened them carries it. */
  passed: number;
  /** The ticket this turn worked in; null on your own card and on turns filed under no ticket. */
  ticket_id: string | null;
  /**
   * The model choice this turn ran on and what came of it. Null on your own card and on a turn
   * older than model choices; absent altogether from a daemon that predates it.
   */
  route?: TaskTraceRoute | null;
};

/** One card's model choice: the record, and the review and learning of the chain it started. */
export type TaskTraceRoute = {
  record: RouteRecord;
  /** Set on the turn that started a correction chain, once that chain has been reviewed. */
  review: RouteReview | null;
  /** What the learning hop kept for that chain, on the same turn. */
  learning: RouteLearning | null;
  /**
   * From engine level 8 (ADR 0050): whether you marked this turn's trouble as the model's, which
   * files a quality event in the model category. Absent below level 8.
   */
  marked_model?: boolean;
};

/** A job as one picture: the turns that share its work dir, across sessions. */
export type TaskTrace = {
  id: string;
  dir: string;
  title: string;
  /** The session the work dir was opened in. Null once that session is gone. */
  session_id: string | null;
  closed_at: string | null;
  nodes: TaskTraceNode[];
};

/** One row of the switcher: a plan this session took part in. */
export type SessionTaskSummary = {
  id: string;
  dir: string;
  title: string;
  session_id: string | null;
  closed_at: string | null;
  last_activity_at: string;
  /** The spec's goal, null until the organizer has run. */
  goal: string | null;
  kind: string | null;
  status: PlanStatus;
  ticket_counts: TicketCounts;
  /**
   * Set while the plan is set aside because its conversation was cleared or deleted (ADR 0040):
   * nothing files or calls back in it until it wakes. Absent from a daemon older than dormancy.
   */
  dormant_since?: string | null;
};

/**
 * Where an entry of the requirements ledger (需求台账, ADR 0040 P3) holds: one ticket, the plan, the
 * conversation the plan lives in and every plan in it (`project`), or every plan of a kind of work
 * (`standing`, `domain` saying which).
 */
export type RequirementScope = "part" | "ticket" | "plan" | "project" | "standing";

/**
 * What the board may do to an entry (`POST /v1/requirements/:id/action`), each only where it applies:
 * - `confirm`: a proposed entry or an old rule nobody found your words for is yours — in force from
 *   now; a proposed replacement takes the place of the entry it replaces.
 * - `reject`: it is not a requirement of yours.
 * - `waive`: an entry in force no longer holds.
 * - `not_here` / `here_again`: an entry this plan inherits does not hold for it, or holds again.
 * - `whole_project`: an entry of this plan holds for every plan of its conversation from now on.
 */
export type RequirementAction = "confirm" | "reject" | "waive" | "not_here" | "here_again" | "whole_project";

/** `POST /v1/requirements/:id/action`: the plan the board shows it on. Returns that plan's `TaskDetail`. */
export type RequirementActionRequest = { action: RequirementAction; task_id: string };

/**
 * One entry of the ledger as a plan's board shows it: your words, a Bot's restatement beside them,
 * how many times and in how many plans you said it, where it holds, where the words were said.
 */
export type PlanRequirement = {
  id: string;
  /** The ledger's own number, R-N, the same wherever the entry shows. */
  seq: number;
  quote: string;
  restated: string | null;
  category: string | null;
  polarity: "must" | "must_not";
  /** A number you gave (`duration`, `resolution`, `aspect` or `fps`), as the app read it from the words; null otherwise. */
  dimension: string | null;
  /** That number and its bound, as the app keeps it; null with `dimension`. */
  value: unknown;
  /** `unverified`: an old rule the app found none of your words for, shown for reference only. */
  status: "open" | "proposed" | "unverified";
  scope: RequirementScope;
  /** The ticket a ticket entry holds for; null otherwise. */
  ticket_id: string | null;
  domain: string | null;
  times_raised: number;
  /** In how many plans the words raising it were said. */
  plans_raised: number;
  last_raised_at: string;
  source_kind: "message" | "ask_answer" | "annotation" | "board" | "accepted_suggestion" | "legacy";
  /** The words it stands on and where they were said; `message_id` is null once the transcript is cleared. */
  source: { via: "message" | "ask_answer" | "annotation" | "board"; session_id: string | null; message_id: string | null; at: string } | null;
  /** Who wrote it down: `user`, `scribe`, `capture` (a complaint kept whole), `import` (an old rule). */
  added_by: string;
  /** The plan it was first said in, when that is another one: this plan inherits it. */
  inherited_from: { task_id: string; title: string } | null;
  /** You said it does not hold for this plan. */
  excluded: boolean;
  /** A proposed replacement: the entry it would replace, which stays in force until you choose. */
  supersedes: { id: string; seq: number; quote: string } | null;
};

/**
 * A plan's size as the app goes by it (ADR 0060): `large`, made as several units with a sample first;
 * `single`, one piece — only ever yours to say, and then nothing reads it as large again. `by`: the
 * reader (a model reading your words), the signal (work going round on it with nothing through), or
 * you. `why`: the words or facts it stands on; `unit`: what one unit of it is (「一场」「一章」).
 */
export type PlanScale = { value: "large" | "single"; by: "reader" | "signal" | "user"; at: string; why: string | null; unit: string | null };

/** One plan as the board reads it: the switcher row plus its spec, revision and tickets. */
export type TaskDetail = SessionTaskSummary & {
  /** Engine level 5 is on (ADR 0046): tickets have stages, parts passed and a reviewer to set. Absent below it. */
  submissions_on?: boolean;
  /** Engine level 4 is on (ADR 0045): tickets show who has the ball, and their dependencies can be set. Absent below it. */
  supervision_on?: boolean;
  /** Engine level 7 is on (ADR 0048): a ticket can be given the model its turns run on. Absent below it. */
  routing_on?: boolean;
  /**
   * Whether this is a large job (大活, ADR 0060): one laid out before anything is made, with a sample
   * you approve first. Null when nothing has read it as either. Absent from older daemons.
   */
  scale?: PlanScale | null;
  /** From level 5: the Bots that can review this plan's tickets (in its conversation, not archived); a ticket's owner is left out on its row. */
  reviewer_ids?: string[];
  brief: string | null;
  spec: PlanSpec | null;
  spec_updated_at: string | null;
  /** How many versions the spec has had; zero before the organizer first ran. */
  revision: number;
  revision_actor: "app" | "user" | null;
  /** The latest version's `cause`: `hold` when a hold of yours wrote it. Absent from a daemon older than holds. */
  revision_cause?: "hold" | null;
  routine_id: string | null;
  tickets: TicketWithArtifacts[];
  /** Active acceptance checks; absent from a daemon that predates them. */
  checks?: AcceptanceCheck[];
  /**
   * The holds in force over the plan as a whole — every Bot, as opposed to one Bot's work in it —
   * oldest first: yours on the plan, on the conversation it belongs to, or on everything. A global
   * one leaves `status` as it was, so this is how a client tells a plan nothing runs in. It is as of
   * when the plan was read: a hold that changes nothing on the plan's row — one on everything, say —
   * sends only `hold.upsert` when it is made and when it is lifted, so a client that shows this
   * reads the plan again on that event. Absent from a daemon that predates holds.
   */
  held_by?: Hold[];
  /**
   * The requirements ledger as it bears on this plan (ADR 0040 P3): its own entries, its tickets',
   * the ones it inherits from its conversation and the standing ones, in force, proposed or old
   * and unverified. Absent from a daemon older than the ledger.
   */
  requirements?: PlanRequirement[];
  /** When the plan last changed and what changed, in the app's language. Absent from an older daemon. */
  last_change?: { at: string; what: string } | null;
  /**
   * From level 8: the retrospectives its Bots made of it once it was delivered (ADR 0062), oldest
   * first; ones that ran or are running, not ones set aside. Absent below level 8 and from an older daemon.
   */
  retrospectives?: Retrospective[];
};

/**
 * What a hold (叫停) covers. `bot_plan`'s `scope_id` is `<bot id>:<plan id>`; `global`'s is null.
 * A hold on a plan or a conversation also reads as that plan being parked (ADR 0040).
 */
export type HoldScope = "global" | "bot" | "session" | "plan" | "ticket" | "bot_plan" | "turn";

/** Something a hold covers besides its own scope, fixed when it was made (a Bot's handoffs, say). */
export type HoldTarget = { scope: Exclude<HoldScope, "global">; id: string };

/**
 * What a hold changed, for the confirmation you get and for putting things back when it is lifted.
 * Only ever added to.
 */
export type HoldEffect = {
  /**
   * Plans the hold set to parked, with what lifting it puts back: in progress, done, or `aside` —
   * a plan a newer one had moved out of its conversation's current slot (parked in its status, in
   * progress in its spec), which goes back to just that.
   */
  parked_plans?: Array<{ task_id: string; prior: "active" | "done" | "aside" }>;
  /** Check-backs set aside while it holds; they come back when it is lifted. */
  suspended_check_backs?: string[];
  /** On lifting: the plans put back, and the check-backs pending again. */
  restored_plans?: string[];
  resumed_check_backs?: string[];
  /** Turns the hold ended, with what each was doing when it did: what the receipt lists, and what goes on once it is lifted. */
  stopped_turns?: HeldTurn[];
  /** Turns another hold ended that this one still covered when that one was lifted: they go on when this one is. */
  held_over?: HeldTurn[];
  /** On lifting: the stopped turns that went on, each in a new turn opened with a note. */
  resumed_turns?: string[];
  /** Turns of other Bots working in the same plans when the hold was made, which it does not cover. */
  working_beside?: Array<{ turn_id: string; bot_id: string; task_id: string | null; ticket_id: string | null }>;
  /** Turns it covers still running once it had ended what it covers; empty unless something went wrong. */
  still_running?: string[];
  /** Turns found running under it later, when you said the work had not stopped, and ended then. */
  violations?: string[];
  /**
   * Your lines it turned into read-only answers: the Bot could only answer them. The go on that
   * lifts it hands them back, the last one per Bot, conversation and job opening that Bot's turn.
   */
  answered_lines?: AnsweredLine[];
  /** On lifting: the turns opened on lines of yours it had turned into read-only answers. */
  taken_up_turns?: string[];
};

/** A line of yours a Bot could only answer read-only while a hold covered it, and the turn that answered it. */
export type AnsweredLine = { message_id: string; bot_id: string; turn_id: string };

/** A turn a hold ended: where it ran, on what, and what it had done so far. */
export type HeldTurn = {
  turn_id: string;
  bot_id: string;
  session_id: string;
  task_id: string | null;
  ticket_id: string | null;
  /** Files it wrote, newest last. */
  written: string[];
  /** Its last few tool calls, oldest first, the last one what it was doing when it was stopped. */
  recent: string[];
};

/** Your stop, written down as state: nothing it covers starts or wakes until you lift it. */
export type Hold = {
  id: string;
  scope: HoldScope;
  scope_id: string | null;
  /** `cancel` is a stop that also asks whether to drop the job. */
  action: "pause" | "cancel";
  /** Whether it reaches the work a Bot handed on, as well as the Bot's own. */
  cascade: boolean;
  /** `legacy`: a plan parked before holds existed, taken over as one. */
  source: "user_text" | "user_button" | "legacy" | "migration";
  source_message_id: string | null;
  /**
   * Set on the hold a Stop makes, and on one a group's stop menu makes: your next line about it (in
   * that job; in that group, to that Bot) lifts it. Never on a stop on everything.
   */
  lift_on_next_user_message: boolean;
  targets: HoldTarget[];
  effect: HoldEffect;
  created_at: string;
  lifted_at: string | null;
  lifted_by: "user_text" | "user_button" | null;
  lifted_message_id: string | null;
  /**
   * The title of the plan a hold on a plan, on one Bot's work in a plan, or on a ticket names, as it
   * reads now; null for any other scope. Absent from a daemon that predates it.
   */
  plan_title?: string | null;
};

/** `POST /v1/holds`: a stop you make from a button or a menu. */
export type CreateHoldRequest = {
  scope: HoldScope;
  /** Omitted or null only for `global`. */
  scope_id?: string | null;
  action?: "pause" | "cancel";
  cascade?: boolean;
  lift_on_next_user_message?: boolean;
  /** The conversation you made it from (a stop menu there): the app's receipt goes there when you are in it. */
  session_id?: string | null;
};

export type PatchTaskSpecRequest = {
  /** The whole spec as it should read after your edit. */
  spec: PlanSpec;
  /** The revision you edited from; a mismatch is refused so a concurrent change is not lost. */
  if_revision?: number;
};

/** A model on an endpoint, as a ticket's override names it. */
export type TicketModel = { provider_id: string; model: string };

/** At most this many rungs on the model ladder: a short climb, not a catalog. */
export const MODEL_LADDER_MAX = 8;

/** One rung of the model ladder (ADR 0054, level 7): a listed model, in the order you put them, weaker to stronger. */
export type ModelLadderRung = { provider_id: string; model: string };

/** `GET /v1/model-ladder` and `PUT /v1/model-ladder {items}`: the ladder, and whether this engine level has one. */
export type ModelLadderResponse = { items: ModelLadderRung[]; available: boolean };

export type PatchTicketRequest = {
  title?: string;
  spec?: string;
  status?: TicketStatus;
  worker?: string | null;
  /**
   * The tickets of the same plan this one waits for, replacing the list (ADR 0045): the supervisor
   * calls nobody back to it until they are done, and a stop over one of them stops it too.
   */
  depends_on?: string[];
  /** The Bot that reviews this ticket's submissions (ADR 0046), or null for none: not its owner. */
  reviewer_bot_id?: string | null;
  /** The model this ticket's turns run on (level 7), or null to go back to the Bot's own. */
  model_override?: TicketModel | null;
  if_revision?: number;
};

export type WorkspaceTreePage = {
  path: string;
  truncated: boolean;
  items: WorkspaceTreeEntry[];
};

/** Workspace-relative files and folders to move to the Mac's Trash; a folder goes with what is in it. */
export type WorkspaceTrashRequest = {
  paths: string[];
};

export type WorkspaceTrashResult = {
  /** In the Trash now, or already gone when asked — either way no longer in the workspace. */
  trashed: string[];
  /** Still where they were, with the Mac's reason. */
  failed: Array<{ path: string; message: string }>;
};

export type SettingsPatch = {
  workspace_path?: string;
  endpoint_base_url?: string;
  endpoint_api_key?: string;
  endpoint_models?: EndpointModelInput[];
  endpoint_default_model?: string;
  default_provider_id?: string | null;
  /** Null follows the default model again. */
  reader_model?: ReaderModel | null;
  launch_at_login?: boolean;
  locale?: Locale;
  theme?: Theme;
};

export type Provider = {
  id: string;
  name: string;
  base_url: string | null;
  key_set: boolean;
  /** Enabled completion names; a subset of what the endpoint offers. */
  models: string[];
  model_catalog: EndpointModel[];
  /** Last list the endpoint's `/models` returned, kept so the picker survives reopening. */
  available_models: string[];
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateProviderRequest = {
  name: string;
  base_url: string;
  api_key?: string;
  models?: EndpointModelInput[];
  available_models?: string[];
  default_model?: string | null;
};

export type PatchProviderRequest = {
  name?: string;
  base_url?: string;
  api_key?: string;
  models?: EndpointModelInput[];
  available_models?: string[];
  default_model?: string | null;
};

/**
 * Who runs a Bot's turns (ADR 0061). Absent or null: the app's own hop loop on an OpenAI-compatible
 * endpoint. `claude_code`: the user's own installed and signed-in Claude Code, through the Agent
 * SDK — shown as "Claude Agent", on `agent_model` and `agent_effort` (null: Claude Code's own
 * defaults). The endpoint pin stays what the app's own calls about the Bot run on.
 */
export const BOT_RUNNERS = ["claude_code"] as const;
export type BotRunner = (typeof BOT_RUNNERS)[number];

/** The effort levels Claude Code takes (`--effort`), lowest first; which ones a model offers varies. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** Model aliases Claude Code resolves itself; a full model id is accepted too. */
export const CLAUDE_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

/** A Claude Code model name or alias as a Bot may pin it: letters, digits, `.`, `-`, `_`, `[`, `]`. */
export function isClaudeModelName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/.test(value);
}

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

export function isBotRunner(value: unknown): value is BotRunner {
  return typeof value === "string" && (BOT_RUNNERS as readonly string[]).includes(value);
}

export type Bot = {
  id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar: string | null;
  model: string | null;
  provider_id: string | null;
  /**
   * Pinned thinking level. `null` lets the app pick per message. A pinned level applies whenever the
   * resolved model supports it; otherwise the app picks as if unpinned.
   */
  thinking_level: ThinkingLevel | null;
  /** Who runs its turns (ADR 0061); absent from a daemon older than that. */
  runner?: BotRunner | null;
  /** The Claude model (alias or full id) a Claude Agent turn asks for; null: Claude Code's default. */
  agent_model?: string | null;
  /** The effort a Claude Agent turn asks for; null: Claude Code's default. */
  agent_effort?: ClaudeEffort | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * What the daemon found of the user's own Claude Code (ADR 0061, `GET /v1/runtime/claude-code`).
 * Deskfolk only runs it and asks it about itself (`claude --version`, `claude auth status`); it never
 * reads its credentials.
 */
export type ClaudeCodeStatus = {
  /** The executable a Claude Agent turn would run; null when none was found. */
  path: string | null;
  /** Where the path came from: your setting, the daemon's PATH, a usual install place, or your login shell. */
  source: "setting" | "path" | "known" | "login_shell" | null;
  version: string | null;
  /** The Claude Code version the bundled Agent SDK was built with; older ones may lack what it uses. */
  sdk_version: string;
  outdated: boolean;
  /** From `claude auth status`; null when it could not be asked. */
  logged_in: boolean | null;
  /** `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party` or `none`, as Claude Code reports it. */
  auth_method: string | null;
  /** e.g. `pro`, `max`; null when the credential is not a subscription. */
  subscription_type: string | null;
  email: string | null;
  /** `ANTHROPIC_BASE_URL` is set for the daemon, so Claude Code sends its requests there. */
  base_url_set: boolean;
  /**
   * The proxy Claude Code reaches Anthropic through, any user and password in it hidden; null when it
   * goes straight. `env`: the daemon's `HTTPS_PROXY` / `ALL_PROXY`, passed on as they are. `system`:
   * none of those is set, so the system's HTTPS proxy is handed to Claude Code as `HTTPS_PROXY`.
   */
  proxy: string | null;
  proxy_source: "env" | "system" | null;
  checked_at: string;
  /** Why something could not be found or asked, in English, for the card's small print. */
  error: string | null;
};

export type ProfileRevision = {
  id: string;
  bot_id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  actor: typeof USER_MEMBER | string;
  message_id: string | null;
  created_at: string;
};

export type CreateBotRequest = {
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  model?: string | null;
  provider_id?: string | null;
  thinking_level?: ThinkingLevel | null;
  runner?: BotRunner | null;
  agent_model?: string | null;
  agent_effort?: ClaudeEffort | null;
};

export type PatchBotRequest = {
  name?: string;
  duties?: string;
  boundaries?: string;
  avatar?: string | null;
  model?: string | null;
  provider_id?: string | null;
  thinking_level?: ThinkingLevel | null;
  runner?: BotRunner | null;
  agent_model?: string | null;
  agent_effort?: ClaudeEffort | null;
};

export type CreateBotResponse = {
  bot: Bot;
  direct_session: SessionDetail;
};

export type SessionKind = "direct" | "group";

/** Evidence proposes a group lead; only a user's explicit confirmation assigns one. */
export type GroupLeadState = {
  session_id: string;
  confirmed_bot_id: string | null;
  suggestion: { bot_id: string; handoffs: number; since: string } | null;
};

export type ConfirmGroupLeadRequest = { bot_id: string | null; confirmed: true };

/** The durable handoff projected for the plan and its existing Bot↔Bot direct, not guessed from prose. */
export type DelegationView = {
  id: string;
  task_id: string;
  ticket_id: string | null;
  thread_session_id: string;
  from_bot_id: string;
  to_bot_id: string;
  ask: string;
  expects: "deliverable" | "review" | "answer";
  status: "open" | "replied" | "cancelled";
  part_keys: string[];
  requirement_ids: string[];
  created_at: string;
  request_message_id: string | null;
  result_message_id: string | null;
  reply: { body: string; created_at: string; ref: string | null } | null;
  wait: { state: "waiting" | "held"; since: string; due_at: string | null } | null;
};

export type SessionParticipant = {
  member: typeof USER_MEMBER | string;
  joined_at: string;
  left_at: string | null;
};

export type Session = {
  id: string;
  kind: SessionKind;
  name: string | null;
  last_read_at?: string | null;
  read_through_seq?: number;
  archived_at?: string | null;
  /** The session whose message opened this one. Only a Bot↔Bot direct has one. */
  origin_session_id: string | null;
  /** The message that opened this session; the entry point to it hangs under that message. */
  origin_message_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A Bot a message has woken that has no turn yet; it shows as thinking under that message.
 * `judging`: an unnamed group member deciding whether to join. `organizing`: your message is
 * still being filed, and no turn or judgement opens until it has. A row without it is `judging`.
 */
export type PendingJudgement = {
  id: string;
  session_id: string;
  message_id: string;
  bot_id: string;
  stage?: "organizing" | "judging";
  created_at: string;
};

export type SessionSummary = Session & {
  participants: SessionParticipant[];
  last_message?: Message | null;
  live_turns?: Turn[];
  pending_judgements?: PendingJudgement[];
  unread_count?: number;
  /**
   * A card here still waits on your press, read or not: a hand-over to approve or send back, or a
   * tool approval (`approval`); a question or a default-model pick (`ask`). The Dock badge counts
   * these besides unread lines, and with no turn live, the row is the only place to see where they
   * are. Null when nothing waits; absent from an older daemon.
   */
  waiting_on_you?: SessionWaitingOnYou | null;
  notification_preference?: import("./notifications.ts").SessionNotificationPreference;
};

export type SessionWaitingOnYou = "approval" | "ask";

export type TurnStatus =
  | "running"
  | "waiting_approval"
  | "waiting_ask"
  | "completed"
  | "redirected"
  | "interrupted"
  | "stopped";

export type Turn = {
  id: string;
  session_id: string;
  bot_id: string;
  status: TurnStatus;
  trigger_message_id: string;
  /** The plan this turn's intermediate files belong to. Null on turns from before work dirs. */
  task_id?: string | null;
  /** The ticket this turn works in, whose folder is its default cwd. */
  ticket_id?: string | null;
  /** The durable unit this segment executes; absent on older daemons' turns. */
  work_item_id?: string | null;
  end_reason?: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  partial_text?: string | null;
  pending_ask_id?: string | null;
  routine_id?: string | null;
  routine_due_at?: string | null;
  /** What the turn may do (ADR 0040); null on turns an older build opened. */
  mode?: TurnMode | null;
  /**
   * The tool call it is running right now, on a live turn read through the API: what a window that
   * missed its `turn.tool` start (opened later, a phone reconnecting) shows instead of 「思考中」 —
   * on 2026-10-04 a `qlmanage` that hung for ten minutes read 「思考中」 the whole time.
   */
  running_tool?: TurnRunningTool | null;
};

/** A tool call a live turn is running: `turn.tool`'s start frame, with when it started. */
export type TurnRunningTool = { id: string; name: string; target?: string; mcp_server?: string; mcp_tool?: string; started_at: string };

/**
 * `work`: an ordinary turn. `readonly`: the one kind a hold lets open, the turn a line of yours
 * opens to answer you, with nothing that has an effect. `desk`: a later phase's.
 */
export type TurnMode = "work" | "desk" | "readonly";

export type MessageKind ="user" | "bot" | "ask" | "approval" | "profile_change" | "system";

export type Attachment = {
  id: string;
  message_id: string;
  workspace_relpath: string;
  original_filename: string;
  created_at: string;
  exists?: boolean;
  is_dir?: boolean;
  size?: number | null;
  mime?: string | null;
};

export type Reaction = {
  message_id: string;
  actor: typeof USER_MEMBER | string;
  emoji: string;
  created_at: string;
};

export type FilingState = "filed" | "undetermined" | "none";

/** A message can belong to more than one plan; task_id remains the primary legacy projection. */
export type MessageFiling = {
  task_id: string;
  ticket_id: string | null;
  part_key: string | null;
  filed_by?: string;
  strength?: "locked" | "default" | "bot" | "user";
  is_primary?: boolean;
};

/** Your new name for a job; its folder keeps its name. */
export type RenamePlanRequest = { title: string };
/** `PATCH /v1/tasks/:id` with your word on the job's size (ADR 0060): `single` and nothing reads it as large again. */
export type SetPlanScaleRequest = { scale: "large" | "single" };

export type PatchMessageAttributionRequest = {
  filings: Array<{ plan_id: string; ticket_id?: string | null; part_key?: string | null }>;
};

/** 「新开一件事」: a line of yours opens a job of its own (named after it, or `title`) and is filed there. */
export type NewJobFromLineRequest = {
  new_plan: { title?: string | null };
};

export type Message = {
  id: string;
  session_id: string;
  turn_id: string | null;
  parent_id: string | null;
  kind: MessageKind;
  author: typeof USER_MEMBER | string;
  body: string;
  source_turn_id: string | null;
  /** The plan this message belongs to; the anchor its artifact entry opens. */
  task_id?: string | null;
  /** The ticket it was filed under, when the organizer or its turn said so. */
  ticket_id?: string | null;
  /** Explicitly unfiled (none), awaiting a choice, or filed to the targets below. */
  filing_state?: FilingState;
  filings?: MessageFiling[];
  /**
   * A batch of annotations on an artifact from a Bot↔Bot direct lands in your direct with that
   * Bot, with no parent to quote; this points back at the message the artifact came from.
   */
  annotation_source_message_id?: string | null;
  /** On an `ask`: the choices the Bot offered, or null for a plain question. */
  ask?: AskSpec | null;
  /** On an `ask`: your answer, recorded on the question itself instead of as a message of yours. */
  ask_answer?: AskAnswer | null;
  created_at: string;
  message_seq?: number;
  attachments: Attachment[];
  reactions: Reaction[];
  /**
   * What the app read or did about your stops on this line (ADR 0040 P2), the restart it tells of
   * (ADR 0041), or that the line is its answer to a status question; absent on every other line.
   */
  control?: MessageControl;
  /**
   * On a line of yours that reached a Bot while it worked (ADR 0040 P4a): where it stands in that
   * turn's inbox. Absent on every other line, and from a daemon that predates the inbox.
   */
  delivery?: MessageDelivery;
  /**
   * On a line of yours you changed after sending it (ADR 0063): when you last did. Null or absent
   * on a line never changed, and from a daemon that cannot edit.
   */
  edited_at?: string | null;
  /**
   * On a line of yours the app carried out itself rather than handing it to a Bot (`app`: a stop,
   * a go on or a status question it answered), or took as your answer to a Bot's question
   * (`answer`). Neither can be edited: the stop was made, the question was answered once.
   */
  taken_as?: MessageTakenAs | null;
};

/** What became of a line of yours that never reached a Bot as a line (`Message.taken_as`). */
export type MessageTakenAs = "app" | "answer";

/** `PATCH /v1/messages/:id`: the new words of a line of yours (ADR 0063). */
export type EditMessageRequest = { body: string };

/** One earlier wording of a line you changed, and when it was written. */
export type MessageVersion = { body: string; created_at: string };

/** `GET /v1/messages/:id/versions`: what the line said before, oldest first, not counting what it says now. */
export type MessageVersionsResponse = { versions: MessageVersion[] };

/**
 * Where an inbox item stands (ADR 0040 P4a). `queued`: waiting for the turn's next step. `held`: a
 * stop of yours covers it; it waits for the lift. `delivered`: the turn read it, at `hop`. Then what
 * the Bot said it did with it — `adopted`, `answered`, `declined`, `deferred` — or `unacked` when
 * the turn ended without saying. `merged` and `superseded` are the app's: taken up some other way.
 */
export type InboxState =
  | "queued"
  | "held"
  | "delivered"
  | "adopted"
  | "answered"
  | "declined"
  | "deferred"
  | "unacked"
  | "merged"
  | "superseded";

/** What a Bot says it did with a line of yours, in `end_turn`'s `inbox`. */
export type InboxDisposition = "adopted" | "answered" | "declined" | "deferred";

export const INBOX_DISPOSITIONS: readonly InboxDisposition[] = ["adopted", "answered", "declined", "deferred"];

/** A line of yours in a working Bot's inbox, as the line shows it: 已送达 → 第 N 跳读到 → 采纳 / 不采纳. */
export type MessageDelivery = {
  bot_id: string;
  state: InboxState;
  /** The step of the turn that read it; null until one did. */
  hop: number | null;
  /** The Bot's word with what it did: why it declined, say. */
  note: string | null;
};

/**
 * A button a line about your stops, or a restart notice, offers:
 * - `stop` / `continue`: make the stop, or lift what covers, `scopes`.
 * - `cancel`: stop, recorded as a stop you mean to drop the job with (`Hold.action` cancel); lifting it reopens the job.
 * - `undo`: lift the holds a receipt is about; a line of yours read as a stop then reaches the Bots as any line.
 * - `stop_all`: stop every Bot.
 * - `stop_plan`: stop the plan a receipt names too, the other Bots' work in it included (`MessageControl.plans`).
 * - `only_plan`: narrow a stop on a Bot to its work in the plan the receipt names; the rest of its work goes on.
 * - `continue_only`: let the Bots in `scopes` go on while a wider hold (on the group, on everything) stays for the rest.
 * - `continue_all`: lift that wider hold too.
 * - `resume` / `leave`: on a restart notice, go on with the work the restart cut off, or leave it as it is.
 * - `confirm_check`: on the app's line offering a check from your words, put it in force (for a
 *   replacement, in place of the check it would replace).
 * - `edit_check`: on the same line, start a line of your own giving the number instead; the
 *   messenger handles it (`MessageControl.edit_draft`), it is never sent.
 * - `remove_check`: on the app's line about checks from your words, remove those checks (for a
 *   replacement, turn it down and keep the check in force).
 * - `confirm_requirements`: on the app's line about old rules it found none of your words for,
 *   they are all yours: in force from now.
 * - `review_requirements`: on the same line, go through them one by one on the plan's board; the
 *   messenger handles it (opens the board), it is never sent.
 * - `make_standing` / `keep_project`: on the app's line suggesting that requirements you raised in
 *   two or more plans hold for every plan of that kind of work, do so, or leave them where they are.
 * - `undo_plan` / `merge_plan`: after user confirmation, stop and abandon a newly opened job;
 *   merge refiles only the card's quoted message into the selected existing job, never its turns or files.
 *   Neither action lifts holds or reverses effects already started.
 */
export const CONTROL_OFFERS = [
  "stop",
  "continue",
  "cancel",
  "undo",
  "stop_all",
  "stop_plan",
  "only_plan",
  "continue_only",
  "continue_all",
  "resume",
  "leave",
  "confirm_check",
  "edit_check",
  "remove_check",
  "confirm_requirements",
  "review_requirements",
  "make_standing",
  "keep_project",
  "undo_plan",
  "merge_plan",
  "confirm_item",
  "remove_item",
  "approve",
  "reject",
  "another_way",
  "another_plan",
  "relax",
  "accept",
  "rework",
  "dismiss",
  "confirm",
  "decline",
] as const;

export type ControlOffer = (typeof CONTROL_OFFERS)[number];

/**
 * The buttons the messenger handles itself and never sends (`edit_check` fills your composer,
 * `review_requirements` opens the board): every other one a line offers goes to
 * `POST /v1/messages/:id/control`, from the phone as from the window.
 */
export const CLIENT_ONLY_CONTROL_OFFERS: readonly ControlOffer[] = ["edit_check", "review_requirements"];

/**
 * Why the daemon started again (ADR 0041): `dev` for a development run (`bun --watch` restarts it
 * on every save), whatever ended the last one; otherwise `clean` after a deliberate stop (quit,
 * update, a restart you asked for), `crash` after any other end.
 */
export type RestartCause = "clean" | "crash" | "dev";

/** What a stop or a go on is about, in the terms a hold is made in. */
export type ControlScope = { scope: "global"; id: null } | { scope: "bot" | "session" | "plan"; id: string };

/** A button that names a plan: 「一起停下《…》」 (`stop_plan`) or 「只停《…》」 (`only_plan`). */
export type ControlPlanOffer = { offer: "stop_plan" | "only_plan"; task_id: string; title: string };

/**
 * A Bot's question from a job it ended as blocked (`end_turn({reason:"blocked", needs_from_user})`,
 * ADR 0045): a card that outlives the segment, answered with `POST /v1/messages/:id/work-answer`
 * rather than a button. `answer` is written once, with the request id that wrote it; answering
 * queues the job's work again and lifts none of your stops.
 */
export type WorkQuestionControl = {
  kind: "work_question";
  work_item_id: string;
  task_id: string;
  ticket_id: string | null;
  question: string;
  offer: [];
  /** This card has its own answer endpoint; this shared optional field is never written here. */
  acted?: ControlOffer[];
  answer?: { body: string; at: string; user_action_id: string; inbox_seq: number };
  /** When the job went on without an answer (a later question, a segment that ended, a close): from then on the card takes none. Never on an answered card. */
  superseded_at?: string;
};

export type WorkAnswerRequest = { body: string };
export type WorkAnswerResult = { message: Message; work_item_id: string; inbox_state: "queued" | "held"; answered: boolean };

/** What the supervisor's line says (ADR 0045): a ticket it stopped calling back, a job past its automatic retries, or one whose last external call has no known outcome. */
export type SupervisorNoticeCode = "stalled" | "retry_budget" | "unknown_effect";

/**
 * The supervisor's line in a conversation you are in (ADR 0045): facts about a job it will not move
 * on its own any more. It offers no buttons; @ the Bot, its 「继续」 or the board are how it goes on.
 */
export type SupervisorControl = {
  kind: "supervisor";
  code: SupervisorNoticeCode;
  task_id: string | null;
  ticket_id: string | null;
  work_item_id: string | null;
  offer: [];
  acted?: ControlOffer[];
};

/**
 * On one of your lines or the app's, what the app made of your stops or of a restart (ADR 0040 P2, ADR 0041):
 * - `possible_control`, on your line: it reads like a stop or a go on but has more in it, so nothing
 *   was done about it; the Bots got it as any line, and the buttons do what it may have meant.
 * - `receipt`, on the app's line: what a stop or a go on of yours did, from the holds' own record.
 * - `status`, on the app's line: where your stops stand when you asked (「停了吗」「你没停」) or
 *   said go on while a wider hold still covers the Bot; also its answer to a status question
 *   (「怎么样了」), which offers nothing and names no hold. With `unanswered`, said in place of a
 *   reply: your line that a stop let the Bot only answer read-only, and that answer said nothing;
 *   its go on buttons then also open the Bot's work on that line.
 * - `restart`, on the app's line after a restart (ADR 0041): a job the restart cut off. `notes` are
 *   the 「中断」 lines of its turns; 继续 (`resume`) continues each the way its own Continue would.
 * - `check`, on the app's line (ADR 0040 P3): a check from your words offered to you (`proposed`;
 *   `replacing` names the check in force it would replace, `times` how many separate lines of
 *   yours have said it when that is two or more), or checks you confirmed that found the job's
 *   final deliverable (`bound`). `edit_draft` is what its 改 puts in your composer. Since ADR 0058
 *   only a `proposed` card with `replacing` is put up; the others are older lines.
 * - `requirement`, on the app's line (ADR 0040 P3): old rules of the plan `task_id` with none of your
 *   words found for them (`legacy`), or craft requirements of one `category` you raised in two or
 *   more `domain` plans of the conversation, suggested to hold for every plan of `domain` (`standing`;
 *   the body quotes their words, and when the category's entries are in different words it names
 *   one entry alone). None is put up since ADR 0058; older lines keep their buttons.
 * - `work_question` ({@link WorkQuestionControl}) and `supervisor` ({@link SupervisorControl}), on
 *   lines the supervisor level writes (ADR 0045).
 * `acted` lists the buttons you pressed on it, in order; absent until you press one.
 */
export type MessageControl =
  | WorkQuestionControl
  | SupervisorControl
  | { kind: "possible_control"; offer: ControlOffer[]; scopes: ControlScope[]; acted?: ControlOffer[] }
  | {
      kind: "receipt";
      verb: "stop" | "continue";
      hold_ids: string[];
      offer: ControlOffer[];
      scopes: ControlScope[];
      /** The buttons that name a plan; absent when there are none. */
      plans?: ControlPlanOffer[];
      /** On a go on's receipt: the holds still over what it named, which `continue_only` / `continue_all` are about. */
      held_ids?: string[];
      acted?: ControlOffer[];
    }
  | { kind: "status"; hold_ids: string[]; offer: ControlOffer[]; scopes: ControlScope[]; unanswered?: string; acted?: ControlOffer[] }
  | { kind: "restart"; cause: RestartCause; notes: string[]; offer: ControlOffer[]; acted?: ControlOffer[] }
  | {
      kind: "check";
      event: "proposed" | "bound";
      check_ids: string[];
      offer: ControlOffer[];
      replacing?: string | null;
      times?: number;
      edit_draft?: string;
      acted?: ControlOffer[];
    }
  | {
      /**
       * A hand-over's approval waiting on you (ADR 0046): required items nothing backs — no passing
       * check, a reviewer on the producer's own model or none — or, with no required items left open,
       * an organizer's reading or an answer with no reviewer, which is never approved on its own say.
       * `confirm_check` makes the checks from your words in `check_ids` gates, `confirm_item` says the
       * items are met for this hand-over, `remove_item` stops requiring them in this plan; `approve`
       * and `reject` (empty `requirement_ids`/`check_ids`) decide the submission itself.
       */
      kind: "review_item";
      submission_id: string;
      task_id: string;
      ticket_id: string;
      requirement_ids: string[];
      check_ids: string[];
      /** Whether an unconfirmed check named in `check_ids` is passing right now — a possible misread (ADR 0042): 「确认这条检查」 is then never the primary or first button. */
      checks_passing?: boolean;
      /**
       * The app's own line on the card, shown in place of the button's label or beside what is left
       * to press: what `approve` actually did (a gate failing sends it back, with its detail, rather
       * than a bare 已放行), that it waits on a check before approving, or why the card no longer
       * asks (a newer hand-over, your board edit).
       */
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * A line of yours that reads as a complaint about work already handed over or approved (ADR
       * 0046, §6.6): which ticket, and which of its parts (empty: the whole ticket), and the line.
       * `rework` sends it back (then the card offers `undo`, with `result` saying so); `dismiss` leaves it.
       */
      kind: "rework";
      task_id: string;
      ticket_id: string;
      part_keys: string[];
      message_id: string;
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * The capability ceiling (ADR 0046, §6.6): a part (null: the whole ticket) failed the same
       * requirement three hand-overs in a row, or was handed over more than six times. `another_way`
       * and `another_plan` send it back with that direction, `relax` waives `requirement_id` for the
       * plan (offered only when there is one), `accept` takes it as it is.
       */
      kind: "ceiling";
      task_id: string;
      ticket_id: string;
      part_key: string | null;
      requirement_id: string | null;
      /** Why it no longer asks, when the ticket closed another way (approved, your board edit). */
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * A reflection's proposal (ADR 0051, engine level 8): a checklist item for the Bot or a check for
       * the ticket. `confirm` adopts it, `decline` retires it; `result` says why an adopted check was not added.
       */
      kind: "lesson";
      lesson_id: string;
      task_id: string;
      ticket_id: string;
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * A Bot's default model, inferred from what it ran on most lately (ADR 0048, engine level 7):
       * `confirm` keeps it, `decline` drops it so the Bot runs on the endpoint's default. None is put
       * up since ADR 0058; older lines keep their buttons.
       */
      kind: "model_default";
      bot_id: string;
      provider_id: string;
      model: string;
      thinking_level: ThinkingLevel;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      kind: "requirement";
      event: "legacy" | "standing";
      requirement_ids: string[];
      task_id: string;
      category?: string;
      domain?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
      /** A `legacy` card's old rules were all taken up or turned down elsewhere (the board) before any press: from then on it offers nothing. Never on a pressed card. */
      settled_at?: string;
    }
  | {
      /** Visible receipt for a newly opened job; actions stop it, never undo past external effects. */
      kind: "plan_opened";
      task_id: string;
      turn_id: string;
      quote_message_id: string;
      /** Existing jobs in the same project when the card was made; revalidated on a press. */
      merge_targets: Array<{ task_id: string; title: string }>;
      offer: ControlOffer[];
      acted?: ControlOffer[];
      /** What was retained when stopped. An attempted effect may have failed or still be settling. */
      retained_effects?: string[];
      merged_into?: string;
      user_action_id?: string;
    };

/**
 * `POST /v1/messages/:id/control`: a button on a line `control` marks. `action` is one the line
 * offers; `task_id` names the plan for `stop_plan` / `only_plan` / `merge_plan`. The line's `acted` records it, so
 * pressing one again does nothing more.
 */
/**
 * A press on one of the app's lines. `note`: with 退回 (`reject`) on a hand-over's card only, what you
 * want changed, passed on word for word to the Bot that made it (at most `CONTROL_NOTE_MAX` code
 * points); every other press refuses one.
 */
export type ControlActionRequest = { action: ControlOffer; task_id?: string; note?: string };

export const CONTROL_NOTE_MAX = 2000;

/**
 * What a control button did: the holds it made, and those it lifted. `partial` only on a restart
 * notice's 继续 that a stop of yours kept from some of its turns: how many went on and how many
 * that stop still holds. The notice is then left unanswered, so 继续 takes the rest after the lift.
 */
export type ControlActionResult = { made: Hold[]; lifted: Hold[]; partial?: { continued: number; held: number } };

/** One choice a Bot offers on a question. Labels are unique within the question. */
export type AskOption = {
  label: string;
  description?: string | null;
};

/**
 * The choices on a question. Single-select takes at most one; multi-select any number. Writing
 * your own answer is always open, beside or instead of the choices.
 */
export type AskSpec = {
  options: AskOption[];
  multi_select: boolean;
};

export type AskAnswer = {
  /** The chosen labels, in the order the question lists them. */
  selected: string[];
  /** What you wrote yourself; null when you only picked. */
  custom: string | null;
  answered_at: string;
};

/** `POST /v1/messages/:id/answer`: at least one choice or some text of your own. */
export type AnswerAskRequest = {
  selected?: string[];
  custom?: string | null;
};

export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 8;
/** Code points. */
export const ASK_LABEL_MAX = 80;
export const ASK_DESCRIPTION_MAX = 200;
export const ASK_CUSTOM_MAX = 4000;

export type SessionDetail = Session & {
  participants: SessionParticipant[];
  messages: ListPage<Message>;
  turns: Turn[];
  pending_judgements?: PendingJudgement[];
  unread_count?: number;
  notification_preference?: import("./notifications.ts").SessionNotificationPreference;
};

export type CreateGroupRequest = {
  name: string;
  members: string[];
};

/**
 * `POST /v1/sessions/:id/clear` (and `DELETE /v1/sessions/:id/messages`) and `DELETE /v1/sessions/:id`.
 * The transcript goes either way; what you said there is kept apart from it unless `erase_quotes`
 * erases it too (ADR 0040). A daemon older than kept words deletes it with the transcript, and its
 * remote whitelist refuses the field: the clients send it only when you ticked the box, so an
 * unticked clear reads the same to every daemon.
 */
export type ClearSessionRequest = {
  erase_quotes?: boolean;
};

export type PostMessageRequest = {
  body: string;
  parent_id?: string | null;
  fork?: boolean;
  ask_id?: string | null;
  /**
   * Files already in the workspace, attached as they are (no copy into `inbox/`). Multipart
   * carries the list as one JSON-encoded field.
   */
  paths?: string[];
};

export type MemberRequest = {
  bot_id: string;
};

export type ReactionRequest = {
  emoji: string;
};

export type StopRequest = {
  turn_id?: string;
};

export type ContinueRequest = {
  message_id: string;
};

export type ApprovalStatus = "pending" | "allowed_once" | "denied" | "voided";

export type Approval = {
  id: string;
  turn_id: string;
  message_id: string | null;
  status: ApprovalStatus;
  kind_key: string | null;
  summary: string | null;
  target: string | null;
  created_at: string;
  resolved_at: string | null;
  /** True when allow_once must include api_key (endpoint-add, HTTP mcp-add, or an edit with no key yet). */
  requires_api_key: boolean;
};

export type ResolveApprovalRequest = {
  action: "allow_once" | "deny" | "always_allow";
  scope?: string;
  /** Written only to the keychain for endpoint-add / endpoint-edit / HTTP MCP auth. Never echoed. */
  api_key?: string;
};

export type AllowRule = {
  id: string;
  kind_key: string;
  scope: string;
  created_at: string;
};

export type McpToolCatalogEntry = {
  name: string;
  description: string;
};

export type McpServer = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  headers: McpHeader[];
  /** True when an Authorization secret is in the keychain. The secret itself is never echoed. */
  auth_set: boolean;
  enabled: boolean;
  /** Handshake `instructions` from the server; used to pick tools for a turn. */
  instructions: string | null;
  /**
   * Roster-level usage note written by you or a Bot: what this server is for, when to use it,
   * when not to. Goes into every hop's MCP block next to the server's own instructions.
   * Editing it is not a dangerous action and survives connection changes.
   */
  usage_note: string | null;
  /** Last `tools/list` snapshot (server-native names). */
  tool_catalog: McpToolCatalogEntry[];
  created_at: string;
  updated_at: string;
};

export type RoutineSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: string[] };

export type Routine = {
  id: string;
  bot_id: string;
  title: string;
  instruction: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  last_fired_for_due_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateRoutineRequest = {
  bot_id: string;
  title: string;
  instruction: string;
  schedule: RoutineSchedule;
  enabled?: boolean;
};

export type PatchRoutineRequest = Partial<Omit<CreateRoutineRequest, "bot_id">> & {
  /** The routine's updated_at from the snapshot being edited. Optional for legacy local clients. */
  if_revision?: string;
};

export type Skill = {
  id: string;
  bot_id: string;
  name: string;
  description: string;
  body: string;
  /**
   * MCP server names the body relies on (matched case-insensitively against connected servers).
   * The skill catalog marks the ones not connected this turn so the Bot does not force the body.
   */
  uses: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Same-kind tasks after the learning hop last revised this skill, and how many of them were
   * shorter. Null when a turn wrote it, or no hop has revised it.
   */
  learning: { later: number; shorter: number } | null;
  /** The retrospective (ADR 0062) that last changed it, and its plan; absent when a turn or you did. */
  retrospective?: RetrospectiveOrigin | null;
};

export type CreateSkillRequest = {
  bot_id: string;
  name: string;
  description: string;
  body: string;
  uses?: string[];
  enabled?: boolean;
};

export type PatchSkillRequest = {
  name?: string;
  description?: string;
  body?: string;
  uses?: string[];
  enabled?: boolean;
};

/**
 * One fact a Bot wrote down about the user or the work, kept across sessions.
 *
 * A memory is the Bot's earlier conclusion, not a source of truth: when it disagrees with this
 * turn's transcript, the transcript wins. Only the Bot writes them; you can read, correct,
 * disable and delete.
 */
export type Memory = {
  id: string;
  bot_id: string;
  /** What the memory is about. Unique per Bot, case-insensitively: writing it again replaces. */
  subject: string;
  body: string;
  /** Where it was formed. Null once that session is gone. */
  source_session_id: string | null;
  /** The message that woke the turn it was formed in. Null once that history is cleared. */
  source_message_id: string | null;
  /**
   * Same-kind tasks after the learning hop wrote this memory, and how many of them were shorter.
   * Null when the Bot wrote it during a turn.
   */
  learning: { later: number; shorter: number } | null;
  /** The retrospective (ADR 0062) that wrote it as it now reads, and its plan; absent when a turn or you wrote it. */
  retrospective?: RetrospectiveOrigin | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

/** The user corrects a memory; they never create one. */
export type PatchMemoryRequest = {
  subject?: string;
  body?: string;
  enabled?: boolean;
};

/** One endpoint call the ledger records. */
export type SpendKind =
  | "turn"
  | "judgement"
  | "route_pick"
  | "route_review"
  | "route_learn"
  | "composer_suggest"
  | "organize"
  | "acceptance_check";

/**
 * What a call was for, where its kind is shared (ADR 0042): the scribe bills as `organize`, a
 * judgement of pictures (a `continuity` check looking at frames) as `acceptance_check`, and a
 * reflection, once there is one, as `organize`, and so does reading a line for what the app acts
 * on (`reader`, ADR 0055) and a Bot's retrospective of a delivered plan (`retrospect`, ADR 0062).
 * The kind stays the nearest old value, so an older build still reads the row; every other row has
 * no purpose.
 */
export type SpendPurpose = "scribe" | "vision" | "reflect" | "reader" | "retrospect";

export const SPEND_PURPOSE_KIND: Record<SpendPurpose, SpendKind> = {
  scribe: "organize",
  vision: "acceptance_check",
  reflect: "organize",
  reader: "organize",
  retrospect: "organize",
};

/** One line of the view's breakdown: a kind, or a purpose split out of the kind it bills as. */
export type SpendLine = SpendKind | SpendPurpose;

export function spendLineOf(row: { kind: SpendKind; purpose?: SpendPurpose | null }): SpendLine {
  return row.purpose ?? row.kind;
}

/**
 * How the view groups lines. Decision is the pick before a turn and the organizer's filing of
 * a message; feedback is the review, the learning hop, a reflection and a retrospective; a composer suggestion,
 * the scribe and an acceptance check's calls belong to neither and are "other".
 */
export type SpendCategory = "turn" | "judgement" | "decision" | "feedback" | "other";

export const SPEND_CATEGORY_OF: Record<SpendLine, SpendCategory> = {
  turn: "turn",
  judgement: "judgement",
  route_pick: "decision",
  route_review: "feedback",
  route_learn: "feedback",
  composer_suggest: "other",
  organize: "decision",
  acceptance_check: "other",
  scribe: "other",
  vision: "other",
  reflect: "feedback",
  reader: "other",
  retrospect: "feedback",
};

/**
 * Filters for the ledger. An absent field means "any". `bot_id` and `model` use `null` for the
 * unassigned / unrecorded group. `to` is exclusive. A `kind` entry is a line: a purpose names
 * the rows of that purpose, a kind the rows of that kind that have none (`organize` is the
 * organizer's own calls, not the scribe's).
 */
export type SpendFilter = {
  from?: string;
  to?: string;
  kind?: SpendLine[];
  bot_id?: string | null;
  session_id?: string;
  model?: string | null;
  provider_id?: string;
  turn_id?: string;
};

export type SpendSummaryQuery = SpendFilter & {
  group_by?: "model" | "session" | "bot" | "kind" | "day";
  /** IANA zone. Day buckets are cut in this zone, not SQLite's. */
  tz?: string;
};

/**
 * Sums ignore null. A field that no row reported stays null — it is not zero. An empty set is
 * all null. `missing_calls` had neither a reported nor an estimated amount; `missing_usage_calls`
 * had no usage token fields.
 */
export type SpendTotals = {
  calls: number;
  input_tokens: number | null;
  cached_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  reported_usd_ticks: number | null;
  estimated_usd_ticks: number | null;
  reported_calls: number;
  estimated_calls: number;
  missing_calls: number;
  missing_usage_calls: number;
};

/** One line's totals; `kind` is the line (a purpose where the row has one). */
export type SpendKindSummary = SpendTotals & { kind: SpendLine };

export type SpendCategorySummary = SpendTotals & {
  category: SpendCategory;
  kinds: SpendKindSummary[];
};

/**
 * One bucket of a summary. `id` is opaque for a model (provider + model), the session or bot id,
 * the kind string, or `YYYY-MM-DD` for a day. A null model is one group. A null bot is
 * unassigned, not deleted. Day groups carry category totals so a trend can stack them; reported
 * and estimated amounts stay separate.
 */
export type SpendGroup = SpendTotals & {
  id: string | null;
  name: string | null;
  deleted: boolean;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  categories: SpendCategorySummary[];
};

export type SpendSummary = {
  totals: SpendTotals;
  groups: SpendGroup[];
  categories: SpendCategorySummary[];
};

export type Spend = {
  id: string;
  session_id: string;
  /** Snapshot of the session name at insertion. */
  session_name: string | null;
  bot_id: string | null;
  /** Snapshot of the bot name at insertion. Null when the call was not a bot's. */
  bot_name: string | null;
  turn_id: string | null;
  judgement_id: string | null;
  kind: SpendKind;
  /** Absent from a daemon older than ADR 0042. */
  purpose?: SpendPurpose | null;
  chain_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  thinking_level: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd_ticks: number | null;
  estimated_cost_usd_ticks: number | null;
  missing_reason: "stream_interrupted" | "endpoint_omitted" | null;
  created_at: string;
};

/** A ledger row plus whether the session or bot it names is gone, and the message that woke it. */
export type SpendDetail = Spend & {
  trigger_message_id: string | null;
  session_deleted: boolean;
  bot_deleted: boolean;
};

export type SpendPage = {
  items: SpendDetail[];
  next: string | null;
};

/**
 * One organizer call (`apps/daemon/src/organizer.ts`): the message-filing pass or the settle pass
 * that keeps a session's plan and tickets in order. Written for every call that reached the model,
 * whether or not it ended up changing anything, so a filing that never lands is as visible as one
 * that did (ADR 0040 P0's observability: before this, the raw answer was never kept and a filing
 * that came to nothing left only a stderr line). Local-only: `GET /v1/debug/organizer-runs?task_id=`.
 */
export type OrganizerRun = {
  id: string;
  session_id: string;
  /** The session's current plan when the call was made; null when it had none yet. */
  task_id: string | null;
  mode: "message" | "settle";
  /** The message this filed, for a `message` run; null for a `settle`. */
  message_id: string | null;
  /** The ledger row this call was billed as; null when nothing was billable (it threw before answering). */
  spend_id: string | null;
  /** The model's answer, unparsed. Null when the call threw before one arrived. */
  raw_answer: string | null;
  /** Why the call itself did not produce an answer to parse; null once one did. */
  fail_kind: string | null;
  /** The parsed answer's decision — what actually applies, after candidate-set validation; null when nothing parsed. */
  decision: "continue" | "new" | "resume" | "join" | null;
  /** What the call could pick from: plan ids `resume`/`join` could name, and check ids it could edit — read before the call went out. */
  candidates_payload: { recent_plan_ids: string[]; elsewhere_plan_ids: string[]; existing_check_ids: string[] };
  /**
   * The answer's own picks, exactly as it named them, before candidate-set or format validation
   * narrowed them; null when nothing parsed. `decision` here is the string as written (which can
   * differ from the top-level `decision` once validation downgrades it, e.g. an unqualified
   * resume/join target falls back to "continue"; `downgrade_reason` says why). `resume_plan_id` is
   * set only beside a written `resume` and `join_plan_id` only beside a written `join`, so a stray
   * id beside another decision never puts a run on that plan's trail; `message_ticket` only on a
   * message run. `ticket_ids`/`check_ids` are the validated ones (format/roster checks only, not
   * subject to the race `downgrade_reason` describes).
   */
  candidates_apply: {
    decision: string;
    resume_plan_id: string | null;
    join_plan_id: string | null;
    ticket_ids: string[];
    message_ticket: string | null;
    check_ids: string[];
  } | null;
  /**
   * The candidate sets re-read once the call returned, right before validating the answer against
   * them — compare against `candidates_payload` to see whether they shifted while the call was out.
   * Null when nothing was parsed (no re-read happened).
   */
  candidates_at_parse: { recent_plan_ids: string[]; elsewhere_plan_ids: string[]; existing_check_ids: string[] } | null;
  /**
   * Why `decision` is not the `candidates_apply.decision` the answer wrote: a resume/join that named
   * no target, or one that no longer qualified once `candidates_at_parse` was read (the target
   * stopped qualifying while the call was out — the race ADR 0040 P1 fixes), a decision word that is
   * none of the four, or anything but continue from a settle. Null when the written decision is the
   * one that applies.
   */
  downgrade_reason: string | null;
  /** Whether this run's filing landed on the store. */
  applied: boolean;
  /** Why it did not, when `applied` is false; null when it did. */
  reject_reason: string | null;
  /**
   * Notes on a clean apply (`applied` true) that nonetheless held part of the answer back: a settle
   * that called the plan active while it stays parked, a settle field kept as it was because you
   * had said nothing new, tickets that kept a plan called done still active. Null when nothing was
   * held back.
   */
  held: string[] | null;
  /** The plan it actually landed on, once applied — can differ from `task_id` (`resume`, `join`, a new plan). */
  applied_task_id: string | null;
  applied_ticket_id: string | null;
  created_at: string;
};

export type Judgement = {
  id: string;
  session_id: string;
  message_id: string;
  bot_id: string;
  decision: "join" | "pass";
  reason: string | null;
  error: "timeout" | "invalid_output" | "endpoint_error" | null;
  created_at: string;
};

/** How the turn a model choice ran on ended; `null` while it is still live. */
export type RouteOutcome = "completed" | "failed" | "stopped" | "redirected" | "interrupted";

/** A user follow-up about the model itself, attributed to one decision. */
export type RouteFeedback = {
  message_id: string;
  body: string;
  created_at: string;
};

/**
 * The model and thinking level a turn ran on, who it was for, and how it went. One per turn; a
 * Bot's own records are the only ones that shape its later choices.
 */
export type RouteRecord = {
  turn_id: string;
  session_id: string;
  bot_id: string;
  trigger_message_id: string;
  provider_id: string | null;
  model: string;
  thinking_level: ThinkingLevel;
  /** The message kind the choice was made for (coding / writing / reasoning / simple / general). */
  signature: string;
  outcome: RouteOutcome | null;
  /** Completion failure kind when `outcome` is `failed`. */
  fail_kind: string | null;
  /** One line from the agent that picked this model, when an agent picked it. */
  reason: string | null;
  /** Turns the user kept pushing back on share one; the chain is reviewed as a whole. */
  chain_id: string | null;
  created_at: string;
  finished_at: string | null;
  /**
   * What the turn actually did, counted when it closed. Null means the process stopped before it
   * could count — unknown, not a clean zero.
   */
  hops: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  /** Failed calls whose name and arguments were identical to an earlier failure in the same turn. */
  repeated_failures: number | null;
  files_written: number | null;
  feedback: RouteFeedback[];
  /**
   * Why it ran on this model, from engine level 7 (ADR 0048/0049): `pin`, `default`,
   * `endpoint_default`, `pin_unlisted`, `ticket_override`, `capability_filter`, `escalation` or
   * `escalation_model`. Null when a per-turn pick chose.
   */
  reason_code?: string | null;
  /** Why the model was chosen before a step up or the picture filter moved it (ADR 0054); null when nothing moved it. */
  base_reason_code?: string | null;
};

/** What went wrong with the work, filed by the event's own type (ADR 0050, engine level 8). */
export type QualityCategory = "model" | "pipeline" | "execution" | "review_miss" | "unclear" | "orchestration";

export type QualityEvent = {
  id: string;
  /** `checks_failed`, `review_rejected`, `user_rejected`, `complaint`, `review_miss`, `ceiling`, `failure_shape:<kind>`, `tool_timeout`, … */
  kind: string;
  category: QualityCategory;
  task_id: string | null;
  ticket_id: string | null;
  part_key: string | null;
  submission_id: string | null;
  requirement_id: string | null;
  bot_id: string | null;
  model: string | null;
  turn_id: string | null;
  message_id: string | null;
  work_event_seq: number | null;
  detail: Record<string, unknown>;
  created_at: string;
};

/** One row of the offline report: a Bot on a model, on one kind of plan, over the window asked for. */
export type QualityReportRow = {
  bot_id: string;
  /** Null once the Bot is deleted. */
  bot_name: string | null;
  model: string | null;
  plan_kind: string | null;
  hand_overs: number;
  approved: number;
  review_rejected: number;
  user_rejected: number;
  checks_failed: number;
  complaints: number;
  failure_shapes: number;
  review_misses: number;
  cost_usd: number | null;
  cost_per_approved: number | null;
};

/** A rule the app learned from a failure and checks itself (ADR 0050). */
export type Lesson = {
  id: string;
  scope: "bot" | "role" | "project" | "tool" | "global";
  scope_id: string | null;
  hook: "before_tool" | "before_generate" | "before_submit" | "before_review";
  /** A shell lesson's kind of call (`tool` shell); a reflection's (`tool` reflection, ADR 0051) carries the check it proposes and, adopted, its id. */
  detector: { tool: string; signature: string; head: string; place: string; error: string; check?: AcceptanceCheckInput; check_id?: string };
  /** `warn` holds a call back once per turn; `block` refuses it; `checklist` is read in the Bot's situation; `propose_check` became a check. */
  action: "warn" | "block" | "checklist" | "propose_check";
  text: string;
  evidence: Array<{ turn_id: string | null; at: string; seconds?: number; recurrence?: boolean; quality_event_id?: string; ticket_id?: string }>;
  status: "candidate" | "active" | "retired";
  hits: number;
  prevented: number;
  recurrences: number;
  created_by: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LessonPatch = { status?: "active" | "retired"; action?: "warn" | "block"; text?: string };

/**
 * A project skill (ADR 0052, engine level 8): a copy of one Bot's skill you shared, read by every Bot
 * of the workspace. `source_changed`: the owner's skill was edited since you shared it.
 */
export type SharedSkill = {
  id: string;
  name: string;
  description: string;
  body: string;
  uses: string[];
  source_skill_id: string | null;
  source_bot_id: string | null;
  source_bot_name: string | null;
  enabled: boolean;
  source_changed: boolean;
  confirmed_at: string;
  created_at: string;
  updated_at: string;
};

/** `GET /v1/shared-skills`: the project skills, and whether sharing is on (engine level 8). */
export type SharedSkillsResponse = { items: SharedSkill[]; available: boolean };

/** Which retrospective last wrote a memory or a skill, on which plan: what its card says beside it. */
export type RetrospectiveOrigin = { id: string; task_id: string; plan_title: string | null };

/** A memory or a skill as one retrospective change found it or left it: a memory's subject, a skill's name and description, and the body. */
export type RetrospectiveSide = { subject?: string; name?: string; description?: string; body: string };

/**
 * One change a retrospective made to its own Bot's memories or skills (ADR 0062), with what it
 * replaced. `not_applied` says why in `reason`; `undone` is one you took back on the board.
 */
export type RetrospectiveChange = {
  kind: "memory" | "skill";
  op: "remember" | "forget" | "edit" | "create";
  /** The memory's subject or the skill's name. */
  label: string;
  /** The memory or skill it wrote; for a forget, the one it deleted. Null when nothing was written. */
  target_id: string | null;
  before: RetrospectiveSide | null;
  after: RetrospectiveSide | null;
  /** The Bot's own reason, in a sentence. */
  why: string;
  status: "applied" | "not_applied" | "undone";
  /**
   * Why it was not made, as a code the window words in your language: `off` (you turned it off),
   * `full`, `over_cap` (past what one retrospective may change), `unchanged`, `missing`,
   * `project_skill` (shared by you, not the Bot's to change), `name_taken`, `project_name`,
   * `too_long:<field>`, `required:<field>`, `edit_missing:<n>`, `edit_repeated:<n>:<times>`,
   * `edit_not_one_sentence:<n>`, `edit_unread:<n>` (too long to read: only added to at its end),
   * `drops:<names>` (it would lose these from the skill), `refused`.
   */
  reason?: string;
  undone_at?: string;
};

/** What a retrospective made of an earlier conclusion of its Bot's: still holding, broken again here, or no longer true. */
export type RetrospectiveVerdict = { conclusion: string; verdict: "held" | "recurred" | "obsolete" };

/**
 * A retrospective (完工复盘, ADR 0062, engine level 8): once a plan was delivered and stayed so for
 * half an hour, a Bot that made something in it looked back once, on its own model, over the job's
 * record — what tripped it up, what made you send work back, what to keep — and wrote what it
 * concluded into its own memories and skills. Nothing waits on you: each change can be taken back.
 */
export type Retrospective = {
  id: string;
  task_id: string;
  bot_id: string;
  /** The delivery it looked back on; a plan reopened and delivered again gets another. */
  delivered_at: string;
  state: "pending" | "done" | "failed";
  model: string | null;
  summary: string | null;
  pitfalls: string[];
  rework_causes: string[];
  keep: string[];
  earlier: RetrospectiveVerdict[];
  changes: RetrospectiveChange[];
  /** Why it failed (`call_failed`, `unreadable`, `interrupted`), or why it changed nothing. */
  note: string | null;
  created_at: string;
  finished_at: string | null;
};

/**
 * What later choices made of one review, counted locally from the rows that followed it.
 * `unknown` is a follow whose price or level could not be compared, and it never retires a review.
 */
export type RouteReviewEffect = "followed" | "not_followed" | "unknown";

/** What the learning hop wrote for one closed chain. `none` means it ran and kept nothing. */
export type RouteLearning = {
  chain_id: string;
  bot_id: string;
  session_id: string;
  kind: "memory" | "skill" | "none";
  /** The memory's subject or the skill's name. Empty when nothing was kept. */
  label: string;
  created_at: string;
  /** Same-kind chains after this one, and how many of them took fewer hops with no more errors. */
  outcome: { later: number; shorter: number } | null;
};

/** What the review made of one closed correction chain. */
export type RouteReview = {
  chain_id: string;
  turn_id: string;
  session_id: string;
  bot_id: string;
  signature: string;
  model: string;
  thinking_level: ThinkingLevel;
  /** `model` when the pick was the problem; `task` / `prompt` / `none` when it was not. */
  fault: "model" | "task" | "prompt" | "none";
  direction: "stronger" | "lighter" | "faster" | "cheaper" | "same";
  /** How many rounds the user spent correcting before moving on. */
  rounds: number;
  confidence: number;
  reason: string;
  created_at: string;
  /**
   * Set once the conclusion was followed twice without the later work getting cleaner. The row
   * stays for the record; the picker stops reading it.
   */
  retired_at: string | null;
  /** The next same-kind choice after this review, and whether that work was cleaner. */
  effect: { followed: RouteReviewEffect; cleaner: boolean } | null;
};

export type SearchKind = "bot" | "session" | "message" | "routine" | "file";

export type SearchHit = {
  kind: SearchKind;
  id?: string;
  path?: string;
  snippet?: string;
  session_id?: string;
  session_title?: string;
  parent_id?: string | null;
  avatar?: string | null;
};

/** One composer draft the user can send next, suggested from the current transcript. */
export type ComposerSuggestion = {
  id: string;
  /** Chip text shown above the composer. */
  label: string;
  /** Full draft inserted into the composer; may include `@Name` / `@everyone`. */
  prompt: string;
};

export type ComposerSuggestionsPage = ListPage<ComposerSuggestion>;

export type EventCursor = {
  event_instance_id: string;
  watermark_seq: number;
};

export type CredentialOperation = { id: string; kind: string; entity_id: string; request_id: string | null; can_repair: boolean };

/** A STUN or TURN server the Mac's settings name for the remote screen's direct connection. */
export type RemoteScreenIceServer = { urls: string[]; username?: string; credential?: string };

/**
 * The remote screen as the Mac's own window sees it (`GET/PUT /v1/remote/screen`, loopback only):
 * whether paired devices may view and control this Mac through macOS Screen Sharing, which ICE
 * servers a direct connection may use, whether Screen Sharing answered, and who is connected now.
 */
export type RemoteScreenStatus = {
  enabled: boolean;
  iceServers: RemoteScreenIceServer[];
  /** Null before anything looked. */
  sharing: boolean | null;
  /** Whether this Mac can take a direct connection at all (its WebRTC helper is in place). */
  direct: boolean;
  sessions: Array<{
    deviceId: string;
    deviceName: string;
    mode: "connecting" | "direct" | "relay";
    since: number;
    /** Bytes carried so far each way; a direct session's come from its helper every couple of seconds. */
    toPhone: number;
    fromPhone: number;
    /**
     * What Screen Sharing announced, read off a relayed session's plain RFB after its sign-in: the
     * framebuffer and how the first update is encoded (RFB encoding number).
     */
    framebuffer?: { width: number; height: number; firstEncoding?: number };
  }>;
  /** Pixel sizes while a smooth session has the display lowered, and what it is otherwise. */
  lowered?: { width: number; height: number; fromWidth: number; fromHeight: number };
};

export type RuntimeSnapshot = EventCursor & {
  remoteStatus?: { state: "off" | "native_unavailable" | "activation_gated" | "connecting" | "online" | "disconnected" | "trust_mismatch"; diagnostic: string | null; devices: number };
  credentialOperations?: CredentialOperation[];
  settings: Settings;
  bots: Bot[];
  sessions: SessionSummary[];
  // No `spend`: 3,700 usage rows were 1.4 MB of every snapshot and nothing on screen read them.
  // `GET /v1/spend` serves them to whatever view needs them, when it opens.
  approvals: Approval[];
  mcpServers: McpServer[];
  providers: Provider[];
  skills: Skill[];
  memories: Memory[];
  routines: Routine[];
  allowRules: AllowRule[];
  notificationSummary?: import("./notifications.ts").NotificationSummary;
  notificationPolicy?: import("./notifications.ts").NotificationPolicy;
  notificationCapabilities?: import("./notifications.ts").NotificationCapabilities;
  /**
   * The holds in force, newest first; `hold.upsert` keeps them current. Absent from a daemon that
   * predates holds or has not reached their engine level, so a client offers stops only when it is here.
   */
  holds?: Hold[];
  /**
   * Present from a daemon whose working Bot hears a line of yours in a direct at its next step
   * (ADR 0040 P4a). Absent from an older one, where that line would cut the turn off, so a client
   * keeps the direct's composer to Stop while the Bot works.
   */
  turnInbox?: true;
  /**
   * Present from a daemon that takes your lines in a conversation in the order they came (ADR 0063):
   * one sent while the last is still being read waits for it, so a direct's Send stays open then.
   */
  linesInOrder?: true;
  /** Present from a daemon that lets you change a line of yours after sending it (ADR 0063). */
  messageEdits?: true;
};

export type SessionSnapshot = EventCursor & {
  session: SessionDetail;
  judgements: Judgement[];
};

export type DurableEvent = Exclude<ClientEvent, { event: "turn.token" | "turn.tool" }>;
export type SequencedEvent = {
  type: "event";
  event_instance_id: string;
  seq: number;
  payload: DurableEvent;
};
/**
 * Live bytes from a terminal or from a Bot's running command, on the same socket as events but
 * outside their cursor: ephemeral, never sequenced, never caught up, never a resnapshot. Ten
 * megabytes of build output must not cost every client a full reload, which is exactly what
 * putting this in the event ring would do.
 *
 * The cursor is a byte offset, so a transport may coalesce or re-chunk freely.
 */
/**
 * A shell session you opened yourself. Held by the daemon, so it outlives the window. Quit and a
 * daemon that dies stop the process; the next daemon starts it again in the same place. Ending
 * the session is what forgets it. Not a Bot's tool, not approval-gated, and invisible to every Bot.
 */
export type Terminal = {
  id: string;
  /** Last segment of {@link Terminal.cwd}, for a tab label. */
  title: string;
  /**
   * Where the shell last reported being — zsh does this on its own, via the daemon's own shell
   * integration — or, until it reports, where the session was opened.
   */
  cwd: string;
  rows: number;
  cols: number;
  created_at: string;
  /** `interrupted` means the daemon went away underneath it, same word the transcript uses. A restart starts a new shell rather than reporting one. */
  status: "live" | "exited" | "interrupted";
  exit_code: number | null;
  /** Total bytes ever written to its stream; a reader resumes from an offset. */
  stream_end: number;
};

/**
 * Paths whose writes carry no request receipt, and therefore no in-flight slot on a client.
 *
 * Both ends have to agree, which is why this lives here. A receipt is keyed `(device, request)`
 * and stored in the same transaction as its effect — right for a message, absurd for a keystroke.
 * A client that treats these as ordinary mutations will refuse the second keystroke while the
 * first is still in flight, which looks exactly like a terminal dropping characters.
 *
 * `/v1/workspace/trash` moves files, not rows, so no transaction could hold it together with a
 * receipt; a repeat is harmless instead, since a path already gone is reported as trashed.
 */
export function isNonReceiptPath(path: string): boolean {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery === "/v1/models/probe"
    || withoutQuery === "/v1/workspace/trash"
    || withoutQuery === "/v1/notification-presence"
    || withoutQuery === "/v1/terminals"
    || withoutQuery.startsWith("/v1/terminals/")
    || withoutQuery.startsWith("/v1/streams/");
}

/** What a Stop button can send. Ordinary keys, `^C` included, are bytes the tty line discipline owns. */
export const TERMINAL_SIGNALS = ["SIGINT", "SIGQUIT", "SIGTSTP", "SIGTERM", "SIGKILL"] as const;
export type TerminalSignal = (typeof TERMINAL_SIGNALS)[number];

/** Retained bytes from an offset, for a reader that just connected or fell behind. */
export type TerminalScrollback = {
  offset: number;
  /** base64 */
  data: string;
  skipped: number;
  end: number;
  closed: boolean;
};

/**
 * A session's screen as the daemon holds it. Written into an empty terminal it draws what is on
 * screen now — a full-screen program included, with its modes and cursor — at `rows` × `cols`;
 * live bytes resume at `offset`. This is what a pane attaches to; {@link TerminalScrollback} is
 * the raw bytes, kept for readers that predate it.
 */
export type TerminalScreenSnapshot = {
  offset: number;
  /** base64 of the serialized screen, UTF-8 */
  data: string;
  rows: number;
  cols: number;
};

/**
 * A pane's colours, `#rrggbb`. The daemon answers a program's colour requests (OSC 10/11/12/4)
 * with those of the pane that last attached, since only a pane knows what it is drawing in.
 */
export type TerminalColors = {
  foreground: string;
  background: string;
  cursor?: string;
  /** The sixteen ANSI colours, black to bright white. */
  palette?: string[];
};

/**
 * A tool call starting and finishing, on the same socket as {@link StreamFrame} and with the same
 * standing: ephemeral, no cursor, no catch-up. It is what turns a stream of bytes into something
 * readable — which command produced them, and how it ended. The record that survives a reload is
 * the turn's, not this.
 */
export type ToolFrame = {
  type: "tool";
  turn_id: string;
  /** The tool call id; with the turn id it is also the output stream's id. */
  id: string;
  name: string;
  phase: "started" | "exited";
  /** The `shell` command line, when that is what ran. */
  command?: string;
  /**
   * What the call is about, in a few words: the path a file tool touches, the name a roster or
   * skill tool acts on, the subject a memory is filed under. Clipped, and never a body — a write's
   * content or a message's text stays in the turn's record. Absent when the arguments name nothing.
   */
  target?: string;
  /** For an MCP tool: its server's name and the tool's own name, not the model-facing `mcp_…` one. */
  mcp_server?: string;
  mcp_tool?: string;
  exit_code?: number | null;
  duration_ms?: number;
};

export type StreamFrame = {
  type: "stream";
  /** A terminal session id, or `<turn_id>:<tool_call_id>` for a command. */
  id: string;
  /** Byte offset of the first byte of `data` within the stream. */
  offset: number;
  /** base64 */
  data: string;
  /** Bytes the ring dropped before `offset`; the reader fell behind. */
  skipped?: number;
  /** The producer is done. No more frames for this id. */
  closed?: boolean;
};

export type SyncFrame = SequencedEvent
  | ({ type: "ready" } & EventCursor)
  | ({ type: "resnapshot" } & EventCursor);
export type CatchupResponse = EventCursor & { events: SequencedEvent[]; resnapshot: boolean };

export type WsAuthMessage = {
  type: "auth";
  token: string;
  /** Omit for the original, unsequenced local event stream. */
  protocol?: "sync-v1";
};

export type ClientEvent =
  | { event: "credential_operations.changed"; occurred_at: string; items: CredentialOperation[] }
  /** A built-in prompt changed (ADR 0064): reload it where it is shown. */
  | { event: "prompt.changed"; occurred_at: string; id: string; locale: Locale }
  | ({ event: "settings.changed"; occurred_at: string } & Settings)
  | ({ event: "bot.upsert"; occurred_at: string } & Bot & { deleted_at: string | null })
  | ({ event: "session.upsert"; occurred_at: string } & SessionSummary)
  | ({ event: "group_lead.changed"; occurred_at: string } & GroupLeadState)
  | ({ event: "delegation.changed"; occurred_at: string } & DelegationView)
  | { event: "session.removed"; occurred_at: string; id: string }
  | { event: "session.cleared"; occurred_at: string; id: string }
  | ({ event: "message.created" | "message.upsert"; occurred_at: string } & Message)
  | { event: "attribution.changed"; occurred_at: string; message_id: string; session_id: string; filing_state: FilingState; filings: MessageFiling[] }
  | ({ event: "turn.upsert"; occurred_at: string } & Turn)
  | { event: "turn.token"; occurred_at: string; turn_id: string; session_id: string; text: string }
  | {
      event: "turn.tool";
      occurred_at: string;
      turn_id: string;
      id: string;
      name?: string;
      arguments?: string;
      /**
       * `announced` is the model still writing the call out; `started` and `exited` bracket the
       * execution. Ephemeral like the rest of this event: the record that survives a reload is
       * the turn's, not this.
       */
      phase?: "announced" | "started" | "exited";
      /** On `started`: see {@link ToolFrame}'s fields of the same names. */
      target?: string;
      mcp_server?: string;
      mcp_tool?: string;
      exit_code?: number | null;
      duration_ms?: number;
      /**
       * On `exited`: whether the call succeeded, and its error's code when it did not
       * (`invalid_args`, `draining`, …). Both absent while it waits on an approval or an answer,
       * whose outcome only comes later.
       */
      ok?: boolean;
      error_code?: string;
    }
  | ({ event: "approval.upsert"; occurred_at: string } & Approval)
  | { event: "approval.removed"; occurred_at: string; id: string }
  | {
      event: "reaction.changed";
      occurred_at: string;
      message_id: string;
      actor: typeof USER_MEMBER | string;
      emoji: string;
      op: "add" | "remove";
    }
  | ({ event: "judgement.started"; occurred_at: string } & PendingJudgement)
  | ({ event: "judgement.created"; occurred_at: string } & Judgement)
  | {
      event: "judgement.ended";
      occurred_at: string;
      id: string;
      session_id: string;
      message_id: string;
      bot_id: string;
    }
  | ({ event: "spend.created"; occurred_at: string } & Spend)
  | { event: "spend.removed"; occurred_at: string; id: string }
  /** Billing rates changed and older rows were re-estimated. One per commit, not one per row. */
  | { event: "spend.repriced"; occurred_at: string }
  | ({ event: "routine.upsert"; occurred_at: string } & Routine)
  | { event: "routine.removed"; occurred_at: string; id: string }
  | ({ event: "skill.upsert"; occurred_at: string } & Skill)
  | { event: "skill.removed"; occurred_at: string; id: string }
  | ({ event: "memory.upsert"; occurred_at: string } & Memory)
  | { event: "memory.removed"; occurred_at: string; id: string }
  | ({ event: "mcp.upsert"; occurred_at: string } & McpServer)
  | { event: "mcp.removed"; occurred_at: string; id: string }
  | ({ event: "provider.upsert"; occurred_at: string } & Provider)
  | { event: "provider.removed"; occurred_at: string; id: string }
  | ({ event: "allow_rule.upsert"; occurred_at: string } & AllowRule)
  | { event: "allow_rule.removed"; occurred_at: string; id: string }
  | ({ event: "annotation.upsert"; occurred_at: string } & import("./annotations.ts").Annotation)
  | { event: "annotation.removed"; occurred_at: string; id: string }
  | ({ event: "notification.upsert"; occurred_at: string } & import("./notifications.ts").NotificationItem)
  | { event: "notification.removed"; occurred_at: string; id: string }
  | { event: "notification.summary"; occurred_at: string; summary: import("./notifications.ts").NotificationSummary }
  | ({ event: "notification_policy.changed"; occurred_at: string } & import("./notifications.ts").NotificationPolicy)
  // Lifecycle only — open, exit, gone. The bytes are a stream, not an event.
  | ({ event: "terminal.upsert"; occurred_at: string } & Terminal)
  | { event: "terminal.removed"; occurred_at: string; id: string }
  // A plan's spec or tickets moved; the board it is on refetches.
  | ({ event: "task.upsert"; occurred_at: string } & TaskDetail)
  | { event: "task.removed"; occurred_at: string; id: string }
  | ({ event: "ticket.upsert"; occurred_at: string } & Ticket)
  | { event: "ticket.removed"; occurred_at: string; id: string; task_id: string }
  // A hold was made, lifted, or recorded more of what it did. Holds are never deleted.
  | ({ event: "hold.upsert"; occurred_at: string } & Hold);

/**
 * Longest crop `base64` a remote annotation request may carry. A remote request is one logical
 * message of at most 1 MiB (`MAX_LOGICAL_MESSAGE` in `@real-bot/remote`), so the crop gets this
 * much and the envelope and the other fields keep the rest: about 750 KB once decoded, below the
 * 1 MB a local save takes. The hosted messenger sends each RPC as one unfragmented frame and
 * shrinks (or drops) a crop to fit that, far under this ceiling.
 */
export const ANNOTATION_REMOTE_CROP_BASE64_MAX = 1_000_000;

export * from "./annotations.ts";
export * from "./app-data-dir.ts";
export * from "./boring-avatars.ts";
export * from "./cited-path.ts";
export * from "./mentions.ts";
export * from "./notifications.ts";
export * from "./prompts.ts";
export * from "./text-diff.ts";

/**
 * One command a turn ran, for the card under its reply once the turn has ended
 * (`GET /v1/turns/:id/commands`, oldest first, `shell` only, the turn's first 80 calls).
 */
export type TurnCommand = {
  /** The tool call's id; the record's own on rows from before it was kept. */
  id: string;
  /** The command line, its whitespace folded and clipped to 300 code points. */
  command: string;
  exit_code: number | null;
  ok: boolean;
  duration_ms: number | null;
  /** The last 4000 code points of what it printed, stdout then stderr; null when it printed nothing. */
  output: string | null;
  created_at: string;
};

export type TurnCommandsResponse = { items: TurnCommand[] };
