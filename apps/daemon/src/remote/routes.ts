import { ANNOTATION_REMOTE_CROP_BASE64_MAX, CLIENT_ONLY_CONTROL_OFFERS, CONTROL_NOTE_MAX, CONTROL_OFFERS, FILE_DROP_SESSION_ID, SPEECH_AUDIO_BASE64_MAX, SPEECH_FORMATS, SPEECH_PRESET_IDS } from "@real-bot/protocol";
import type { RemoteRequest } from "@real-bot/remote";
import { HttpError } from "../errors";
import { isUlid } from "../ids";

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;
const string: Check = v => typeof v === "string";
const bool: Check = v => typeof v === "boolean";
const id: Check = v => typeof v === "string" && isUlid(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const list = (check: Check): Check => v => Array.isArray(v) && v.length <= 1000 && v.every(check);
const one = (...values: unknown[]): Check => v => values.includes(v);
const object = (fields: Fields, required: string[] = []): Check => v => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.entries(v).every(([k, value]) => Object.hasOwn(fields, k) && fields[k](value)) && required.every(k => Object.hasOwn(v, k));
const rate: Check = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
const pricing = object({ input: rate, output: rate, cached_input: rate }, ["input", "output"]);
const positive: Check = v => typeof v === "number" && Number.isFinite(v) && v > 0;
const models = list(v => string(v) || object({ name: string, price: nullable(v => typeof v === "number" && Number.isFinite(v)), pricing, thinking_levels: list(string), strengths: list(string),
  max_output: nullable(v => positive(v) && Number.isInteger(v)), stream_tps_p10: nullable(positive), context_window: nullable(v => positive(v) && Number.isInteger(v)), reasoning_effective: nullable(bool), input_image: nullable(bool) }, ["name"])(v));
const schedule: Check = v => object({ kind: one("daily"), time: string }, ["kind", "time"])(v) ||
  object({ kind: one("weekly"), time: string, weekdays: list(string) }, ["kind", "time", "weekdays"])(v);
const bot = { name: string, duties: string, boundaries: string, avatar: nullable(string), model: nullable(string), provider_id: nullable(id), thinking_level: nullable(string), runner: nullable(one("claude_code")), agent_model: nullable(string),
  agent_effort: nullable(one("low", "medium", "high", "xhigh", "max")), agent_config_dir: nullable(string) };
const apiFormat = one("openai", "anthropic");
const provider = { name: string, base_url: string, api_format: apiFormat, api_key: string, models, available_models: list(string), default_model: nullable(string) };
const mcp = { name: string, transport: one("stdio", "http"), command: string, args: list(string), url: string,
  headers: list(object({ name: string, value: string }, ["name", "value"])), auth: string, enabled: bool, usage_note: nullable(string) };
const skill = { name: string, description: string, body: string, uses: list(string), enabled: bool };
const routine = { title: string, instruction: string, schedule, enabled: bool };
const revision = { if_revision: string };
type Route = { method: RemoteRequest["method"]; path: RegExp; body?: Fields; required?: string[]; query?: Fields; queryRequired?: string[]; patch?: boolean };
const entity = `(?:[0-9A-HJKMNP-TV-Z]{26}|${FILE_DROP_SESSION_ID})`;
const path = (pattern: string) => new RegExp(`^/v1/${pattern.replaceAll(":id", entity)}$`);
const routes: Route[] = [];
function add(method: Route["method"], pattern: string, body?: Fields, required?: string[], patch = false): void {
  routes.push({ method, path: path(pattern), body, required, patch });
}
function get(pattern: string, query?: Fields, queryRequired?: string[]): void { routes.push({ method: "GET", path: path(pattern), query, queryRequired }); }
get("(snapshot|settings|providers|bots|sessions|allow-rules|mcp-servers|skills|memories|routines|credential-operations|capabilities)");
get("(providers|bots|sessions|attachments|requests|tasks)/:id");
get("sessions/:id/(judgements|routes|composer-suggestions)");
// ADR 0050: quality events, the report and lessons; marking a turn's trouble as the model's.
get("quality/events", { bot_id: string, ticket_id: string, category: one("model", "pipeline", "execution", "review_miss", "unclear", "orchestration"), limit: v => typeof v === "string" && /^[1-9][0-9]{0,2}$/.test(v) });
get("quality/report", { days: v => typeof v === "string" && /^[1-9][0-9]?$/.test(v) });
get("lessons", { status: one("candidate", "active", "retired") });
get("shared-skills");
// ADR 0061: your Claude plan's usage, as your Claude Code reads it.
get("claude-usage", { refresh: one("1") });
const pageLimit: Check = v => typeof v === "string" && /^[1-9][0-9]{0,2}$/.test(v) && Number(v) <= 200;
get("sessions/:id/snapshot", { limit: pageLimit });
get("sessions/:id/messages", { cursor: v => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[0-9A-HJKMNP-TV-Z]{26}$/.test(v), limit: pageLimit });
get("bots/:id/profile-revisions"); get("attachments/:id/content", { size: one("thumb", "preview"), range: string });
get("tasks/:id/artifacts");
get("annotations", { relpath: v => typeof v === "string" && v.length <= 4096, session_id: id, target_session_id: id, message_id: id, target_message_id: id, status: one("draft", "open", "resolved") });
get("annotations/:id"); get("annotations/:id/crop");
get("tasks/:id/(trace|tickets|spec-revisions)");
// The command card under a finished turn's reply.
get("turns/:id/commands");
get("sessions/:id/tasks");
get("(tasks|sessions)/:id/delegations");
get("tasks/:id/submissions");
get("sessions/:id/lead");
get("messages/:id/attribution");
// Built-in prompts (ADR 0064): read, edit, reset, keep yours against a newer default, take a change back.
const prompt = "prompts/[a-z][a-z0-9_.]{0,63}/(zh|en)";
get("prompts"); get(prompt);
get("prompt-revisions", { approval_id: id }, ["approval_id"]);
add("PUT", prompt, { text: string, if_revision: nullable(string), edit_session: string }, ["text", "if_revision"]);
add("POST", `${prompt}/(reset|keep-mine)`, { if_revision: nullable(string) }, ["if_revision"]);
add("POST", "prompt-revisions/:id/(undo|restore)", {});
// Changing a line of yours after it went out, and what it said before (ADR 0063).
add("PATCH", "messages/:id", { body: string }, ["body"]);
// ADR 0069: take back a line no Bot has read yet, or have the working Bot read it now.
add("POST", "messages/:id/(withdraw|insert)", {});
get("messages/:id/versions");
add("PUT", "sessions/:id/lead", { bot_id: nullable(id), confirmed: one(true) }, ["bot_id", "confirmed"]);
const partKey: Check = v => typeof v === "string" && v.length > 0 && v.length <= 200;
const attribution = { plan_id: id, ticket_id: nullable(id), part_key: nullable(partKey) };
add("PATCH", "messages/:id/attribution", { ...attribution, filings: v => Array.isArray(v) && v.length <= 100 && v.every(object(attribution, ["plan_id"])),
  new_plan: object({ title: nullable(v => typeof v === "string" && v.length <= 200) }) });
const planStatus: Check = one("active", "done", "parked");
const ticketStatus: Check = one("todo", "doing", "review", "done", "parked");
const specLines: Check = list((v) => typeof v === "string" && v.length <= 400);
const planSpec: Check = object(
  {
    kind: nullable(string),
    goal: string,
    acceptance: specLines,
    rules: specLines,
    process: specLines,
    progress: object({ done: specLines, open: specLines, blocked: specLines }, ["done", "open", "blocked"]),
    status: planStatus,
  },
  ["goal"],
);
const specRevision: Check = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
add("PATCH", "tasks/:id/spec", { spec: planSpec, if_revision: specRevision }, ["spec"], true);
// Your new name for a job, or what size it is (ADR 0060): one of the two; the daemon refuses both at once.
add("PATCH", "tasks/:id", { title: v => typeof v === "string" && v.trim().length > 0 && v.length <= 400, scale: one("large", "single") }, []);
// Holds (叫停): your stop from the phone, and your lift of one. A bot_plan hold names its Bot and plan as `<id>:<id>`.
get("holds", { status: one("active", "all") });
get("holds/:id");
const holdScopeId: Check = v => typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}(?::[0-9A-HJKMNP-TV-Z]{26})?$/.test(v);
add("POST", "holds", { scope: one("global", "bot", "session", "plan", "ticket", "bot_plan", "turn"), scope_id: nullable(holdScopeId),
  action: one("pause", "cancel"), cascade: bool, lift_on_next_user_message: bool, session_id: nullable(id) }, ["scope"]);
add("POST", "holds/:id/lift", {});
// A button on one of the app's lines: a receipt's undo, a hand-over's 放行 and 退回, a ceiling's
// choices, a lesson's, a Bot's default model… (「全部停下」 from the phone's menu is a hold above).
// Every button a line can offer but the two the messenger keeps to itself. The list was written
// out here once and fell behind: from the phone, every card added after it was refused.
const sentControlOffers = CONTROL_OFFERS.filter((offer) => !CLIENT_ONLY_CONTROL_OFFERS.includes(offer));
add("POST", "messages/:id/control", { action: one(...sentControlOffers), task_id: id, note: v => typeof v === "string" && [...v].length <= CONTROL_NOTE_MAX }, ["action"]);
add("PATCH", "tickets/:id", { title: string, spec: string, status: ticketStatus, worker: nullable(id), depends_on: list(id), reviewer_bot_id: nullable(id),
  model_override: nullable(object({ provider_id: id, model: string }, ["provider_id", "model"])), sample: one(true), if_revision: specRevision }, [], true);
const checkKind: Check = one("exists", "contains", "matches", "command");
const checkInput = {
  item: string,
  ticket_id: nullable(id),
  kind: checkKind,
  path: nullable(string),
  pattern: nullable(string),
  negate: bool,
  command: nullable(string),
  cwd: nullable(string),
  expect_exit: nullable((v: unknown) => typeof v === "number" && Number.isInteger(v)),
  expect_stdout: nullable(string),
  timeout_sec: nullable((v: unknown) => typeof v === "number" && Number.isInteger(v)),
};
add("POST", "tasks/:id/checks", checkInput, ["item", "kind"]);
add("PATCH", "checks/:id", { ...checkInput, ...revision }, [], true);
add("DELETE", "checks/:id", revision);
// A check from your words, put in force (ADR 0040 P3).
add("POST", "checks/:id/confirm", {});
// An entry of the requirements ledger, from the plan's board (ADR 0040 P3).
add("POST", "requirements/:id/action", { action: one("confirm", "reject", "waive", "not_here", "here_again", "whole_project", "keep"), task_id: id }, ["action", "task_id"]);
add("POST", "tasks/:id/checks/run", { check_id: nullable(id) });
get("workspace/tree", { path: string }); get("workspace/file", { path: string, size: one("thumb", "preview"), range: string }, ["path"]);
get("host/tree", { path: string });
get("events/catchup", { event_instance_id: v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v), after_seq: v => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && Number.isSafeInteger(Number(v)) }, ["event_instance_id", "after_seq"]);
get("approvals", { status: one("pending") });
// The kinds, and the purposes split out of them (ADR 0042): a `kind` filter names lines.
const SPEND_LINES = ["turn", "judgement", "route_pick", "route_review", "route_learn", "composer_suggest", "organize", "acceptance_check", "scribe", "vision", "reflect", "reader"];
const spendKind: Check = one(...SPEND_LINES);
// Remote query values are strings. Repeated local `kind` params arrive here as one comma-separated value.
const spendKinds: Check = (value) => typeof value === "string" && value.split(",").every((kind) => kind.length > 0 && spendKind(kind)) && value.split(",").length <= SPEND_LINES.length;
const isoTime: Check = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return false;
  const millis = (match[7] ?? "").padEnd(3, "0");
  return new Date(instant).toISOString() === `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${millis}Z`;
};
const iana: Check = (value) => {
  if (typeof value !== "string" || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: value }); return true; } catch { return false; }
};
const spendCursor: Check = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
const spendQuery = {
  from: isoTime,
  to: isoTime,
  kind: spendKinds,
  bot_id: (value: unknown) => value === "" || id(value),
  session_id: id,
  model: string,
  provider_id: id,
  turn_id: id,
};
get("spend/summary", { ...spendQuery, group_by: one("model", "session", "bot", "kind", "day"), tz: iana });
get("spend", { ...spendQuery, limit: pageLimit, cursor: spendCursor });
get("search", { q: string }, ["q"]);
get("notifications", { filter: one("actionable", "unread", "all"), limit: v => typeof v === "string" && /^[1-9][0-9]{0,2}$/.test(v) && Number(v) <= 100, cursor: v => typeof v === "string" && v.length <= 256 });
get("notifications/:id");
get("notification-policy");
get("notification-device");
add("POST", "models/probe", { endpoint_base_url: string, endpoint_api_key: string, api_format: apiFormat, provider_id: id });
add("POST", "bots", bot, ["name", "duties", "boundaries"]);
add("POST", "providers", provider, ["name", "base_url"]);
add("POST", "providers/:id/speed-test", { model: string }, ["model"]);
add("POST", "mcp-servers", mcp, ["name"]);
add("POST", "skills", { ...skill, bot_id: id }, ["bot_id", "name", "description", "body"]);
add("POST", "routines", { ...routine, bot_id: id }, ["bot_id", "title", "instruction", "schedule"]);
add("POST", "sessions", { name: string, members: list(id) }, ["name", "members"]);
add("POST", "allow-rules", { kind_key: string, scope: string }, ["kind_key", "scope"]);
add("POST", "turns/:id/mark-model"); add("DELETE", "turns/:id/mark-model");
add("PATCH", "lessons/:id", { status: one("active", "retired"), action: one("warn", "block"), text: string }, [], true);
get("model-ladder"); add("PUT", "model-ladder", { items: list(v => object({ provider_id: id, model: string }, ["provider_id", "model"])(v) ||
  object({ runner: one("claude_code"), model: string, effort: nullable(one("low", "medium", "high", "xhigh", "max")), config_dir: nullable(string) }, ["runner", "model"])(v)) }, ["items"]);
add("POST", "skills/:id/share"); add("PATCH", "shared-skills/:id", { enabled: bool }, ["enabled"], true); add("DELETE", "shared-skills/:id");
// ADR 0062: taking back one change a retrospective made, from the plan's board.
add("POST", "retrospectives/:id/changes/[0-9]{1,2}/undo");
add("POST", "turns/stop", { turn_id: id }, ["turn_id"]); add("POST", "turns/continue", { message_id: id }, ["message_id"]);
add("POST", "sessions/:id/messages", { body: string, parent_id: nullable(id), ask_id: nullable(id), fork: bool, files: list(object({ filename: string, size: v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0, sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) }, ["filename", "size", "sha256"])), paths: list(v => typeof v === "string" && v.length > 0 && v.length <= 4096) }, ["body"]);
add("POST", "sessions/:id/members", { bot_id: id }, ["bot_id"]);
const num: Check = v => typeof v === "number" && Number.isFinite(v);
// The union of every anchor kind's fields; the daemon checks the shape per kind, this only shuts out strangers.
const anchor: Check = object({ start_line: num, start_col: num, end_line: num, end_col: num, quote: string, prefix: string, suffix: string, view: one("rendered"), span_length: num, span_hash: string,
  x: num, y: num, w: num, h: num, natural_width: num, natural_height: num, page: num, selector: string, tag: string, text: string, outer_html: string,
  rect: object({ x: num, y: num, w: num, h: num }, ["x", "y", "w", "h"]), start_ms: num, end_ms: num, duration_ms: num });
// The whole request is one logical message (≤ MAX_LOGICAL_MESSAGE), so a crop cannot be promised the 1 MB a local save takes.
const crop = nullable(object({ mime: one("image/png", "image/jpeg"), base64: v => typeof v === "string" && v.length <= ANNOTATION_REMOTE_CROP_BASE64_MAX && /^[A-Za-z0-9+/=]+$/.test(v) }, ["mime", "base64"]));
add("POST", "annotations", { target_message_id: id, relpath: string, anchor_kind: one("text_range", "image_region", "pdf_region", "html_element", "media_time"), anchor, content_sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v), body: string, crop }, ["target_message_id", "relpath", "anchor_kind", "anchor", "content_sha256", "body"]);
add("POST", "annotations/send", { session_id: id, body: string, annotation_ids: list(id) }, ["session_id", "annotation_ids"]);
add("PATCH", "annotations/:id", { body: string, anchor, crop, content_sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v), status: one("open", "resolved"), ...revision }, [], true);
add("DELETE", "annotations/:id", revision);
add("POST", "sessions/:id/read", { through_message_id: id });
add("POST", "sessions/:id/(archive|restore)", revision); add("POST", "bots/:id/(archive|restore)", revision);
add("POST", "sessions/:id/clear", { ...revision, erase_quotes: bool });
add("POST", "approvals/:id/resolve", { action: one("allow_once", "deny", "always_allow"), scope: string, api_key: string }, ["action"]);
add("POST", "credential-operations/:id/resolve", { action: one("repair", "cancel"), value: string }, ["action"]);
add("POST", "notifications/read", { ids: list(id), through_ordinal: v => typeof v === "number" && Number.isInteger(v) && v >= 0, filter: one("all") });
add("POST", "notifications/retention-notice/read", {});
add("POST", "notifications/:id/acknowledge", { if_revision: v => typeof v === "number" && Number.isInteger(v) && v >= 0 }, ["if_revision"]);
add("PUT", "sessions/:id/notification-preference", { muted: bool, if_revision: v => typeof v === "number" && Number.isInteger(v) && v >= 0 }, ["muted", "if_revision"]);
add("POST", "notification-presence", { instance_id: string, visible: bool, focused: bool, session_id: nullable(id), at_latest: bool }, ["instance_id", "visible", "focused", "at_latest"]);
add("PATCH", "notification-policy", { categories: object({ approval: bool, ask: bool, failure: bool, interrupted: bool, reply: bool, routine_result: bool }), quiet_hours: object({ enabled: bool, start: string, end: string, time_zone: string }), if_revision: v => typeof v === "number" && Number.isInteger(v) && v >= 0 }, ["if_revision"], true);
add("PATCH", "notification-device", { badge: bool, sound: one("system"), preview: one("generic"), if_revision: v => typeof v === "number" && Number.isInteger(v) && v >= 0 }, ["if_revision"], true);
add("PATCH", "settings", { endpoint_base_url: string, endpoint_api_key: string, endpoint_models: models, endpoint_default_model: string,
  default_provider_id: nullable(id), reader_model: nullable(v => object({ provider_id: id, model: string }, ["provider_id", "model"])(v) ||
    object({ runner: one("claude_code"), model: string, config_dir: nullable(string) }, ["runner", "model"])(v)),
  // The model that organizes (ADR 0075): an endpoint's only; a Claude model reads lines, it does not organize.
  organizer_model: nullable(object({ provider_id: id, model: string }, ["provider_id", "model"])),
  launch_at_login: bool, locale: one("en", "zh"), theme: one("system", "light", "dark"),
  if_revision: v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 }, [], true);
// The speech endpoint (ADR 0073): set up like the settings, under their revision; a transcription
// carries its recording as base64, bounded under the link's one-megabyte message.
add("PATCH", "speech", { enabled: bool, preset: one(...SPEECH_PRESET_IDS), format: one(...SPEECH_FORMATS), base_url: string, model: string,
  language: nullable(string), key_provider_id: nullable(id), api_key: string, if_revision: v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 }, [], true);
add("POST", "speech/transcribe", { audio: v => typeof v === "string" && v.length > 0 && v.length <= SPEECH_AUDIO_BASE64_MAX, mime: string }, ["audio", "mime"]);
for (const [name, fields] of Object.entries({ bots: bot, providers: provider, "mcp-servers": mcp, skills: skill, routines: routine,
  memories: { subject: string, body: string, enabled: bool }, sessions: { name: string } } as Record<string, Fields>)) add("PATCH", `${name}/:id`, { ...fields, ...revision }, [], true);
add("DELETE", "sessions/:id", { ...revision, erase_quotes: bool });
add("DELETE", "(bots|providers|mcp-servers|skills|memories|routines|allow-rules)/:id", revision);
add("DELETE", "sessions/:id/messages", { ...revision, erase_quotes: bool });
add("DELETE", "sessions/:id/members", { ...revision, bot_id: id }, ["bot_id"]);
for (const method of ["PUT", "DELETE"] as const) add(method, "messages/:id/reactions", { emoji: string }, ["emoji"]);
add("POST", "messages/:id/answer", { selected: list(string), custom: nullable(string) });
add("POST", "messages/:id/work-answer", { body: v => typeof v === "string" && Boolean(v.trim()) }, ["body"]);
add("PUT", "workspace/file", { path: string, content: string }, ["path", "content"]);
// Into the Mac's Trash, where Finder can put it back — never an unlink.
add("POST", "workspace/trash", { paths: list(string) }, ["paths"]);

// Terminals. A paired device has the same reach as the window here — that is the decision, and
// the gate is remote itself (default off, native activation), not a second one bolted on.
// `host/tree` already let a device read outside the workspace, so this is not a new frontier.
const axis: Check = v => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000;
const offset: Check = v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const base64: Check = v => typeof v === "string" && v.length <= 87_384 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
get("terminals");
get("terminals/:id");
get("terminals/:id/scrollback", { from: v => typeof v === "string" && /^(0|[1-9][0-9]{0,15})$/.test(v) });
get("terminals/:id/screen");
add("POST", "terminals", { cwd: string, rows: axis, cols: axis }, ["cwd"]);
add("POST", "terminals/:id/input", { data: base64 }, ["data"]);
add("POST", "terminals/:id/resize", { rows: axis, cols: axis }, ["rows", "cols"]);
add("POST", "terminals/:id/signal", { signal: one("SIGINT", "SIGQUIT", "SIGTSTP", "SIGTERM", "SIGKILL") }, ["signal"]);
add("POST", "terminals/:id/watch", { from: offset });
add("POST", "terminals/:id/unwatch", {});
add("POST", "terminals/:id/clear", {});
const colour: Check = v => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
add("POST", "terminals/:id/colors", { foreground: colour, background: colour, cursor: colour, palette: v => Array.isArray(v) && v.length <= 16 && v.every(colour) }, ["foreground", "background"]);
add("DELETE", "terminals/:id");
const streamId: Check = v => typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}:[A-Za-z0-9_-]{1,128}$/.test(v);
add("POST", "streams/watch", { id: streamId, from: offset }, ["id"]);
add("POST", "streams/unwatch", { id: streamId }, ["id"]);

export function validateBusiness(request: RemoteRequest): void {
  try {
    const route = routes.find(r => r.method === request.method && r.path.test(request.path));
    if (!route) throw new HttpError(404, "not_found", "unknown remote route");
    if (!object(route.body ?? {}, route.required)(request.body ?? {}) || !object(route.query ?? {}, route.queryRequired)(request.query ?? {}) ||
      (route.patch && !Object.keys(request.body ?? {}).some(k => k !== "if_revision")) ||
      (request.ifMatch !== undefined && !(request.method === "PUT" && request.path === "/v1/workspace/file"))) {
      throw new HttpError(422, "invalid_args", "invalid remote properties");
    }
    if (request.method === "PATCH" && /^\/v1\/messages\/[^/]+\/attribution$/.test(request.path)) {
      const body = request.body ?? {};
      const multi = Object.hasOwn(body, "filings");
      const fresh = Object.hasOwn(body, "new_plan");
      if (((multi || fresh) && Object.keys(body).length !== 1) || (!multi && !fresh && !Object.hasOwn(body, "plan_id"))) {
        throw new HttpError(422, "invalid_args", "choose filings, one plan_id or new_plan");
      }
    }
    // A job's PATCH is its new name or its size, one at a time (ADR 0060).
    if (request.method === "PATCH" && /^\/v1\/tasks\/[^/]+$/.test(request.path) && Object.keys(request.body ?? {}).length !== 1) {
      throw new HttpError(422, "invalid_args", "a job's PATCH is {title} or {scale}");
    }
    if (/^\/v1\/credential-operations\//.test(request.path) && request.body?.action === "repair" && !request.body.value) throw new HttpError(422, "invalid_args", "credential value required");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "invalid_args", "invalid remote properties");
  }
}
