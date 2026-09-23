import { REMOTE_FILE_LIMIT, type RemoteRequest } from "@real-bot/remote";
import { HttpError } from "../errors";

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;
const string: Check = v => typeof v === "string";
const bool: Check = v => typeof v === "boolean";
const id: Check = v => typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const list = (check: Check): Check => v => Array.isArray(v) && v.length <= 1000 && v.every(check);
const one = (...values: unknown[]): Check => v => values.includes(v);
const object = (fields: Fields, required: string[] = []): Check => v => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.entries(v).every(([k, value]) => Object.hasOwn(fields, k) && fields[k](value)) && required.every(k => Object.hasOwn(v, k));
const models = list(v => string(v) || object({ name: string, price: nullable(v => typeof v === "number" && Number.isFinite(v)), thinking_levels: list(string), strengths: list(string) }, ["name"])(v));
const schedule: Check = v => object({ kind: one("daily"), time: string }, ["kind", "time"])(v) ||
  object({ kind: one("weekly"), time: string, weekdays: list(string) }, ["kind", "time", "weekdays"])(v);
const bot = { name: string, duties: string, boundaries: string, avatar: nullable(string), model: nullable(string), provider_id: nullable(id), thinking_level: nullable(string) };
const provider = { name: string, base_url: string, api_key: string, models, available_models: list(string), default_model: nullable(string) };
const mcp = { name: string, transport: one("stdio", "http"), command: string, args: list(string), url: string,
  headers: list(object({ name: string, value: string }, ["name", "value"])), auth: string, enabled: bool, usage_note: nullable(string) };
const skill = { name: string, description: string, body: string, uses: list(string), enabled: bool };
const routine = { title: string, instruction: string, schedule, enabled: bool };
const revision = { if_revision: string };
type Route = { method: RemoteRequest["method"]; path: RegExp; body?: Fields; required?: string[]; query?: Fields; queryRequired?: string[]; patch?: boolean };
const entity = "[0-9A-HJKMNP-TV-Z]{26}";
const path = (pattern: string) => new RegExp(`^/v1/${pattern.replaceAll(":id", entity)}$`);
const routes: Route[] = [];
function add(method: Route["method"], pattern: string, body?: Fields, required?: string[], patch = false): void {
  routes.push({ method, path: path(pattern), body, required, patch });
}
function get(pattern: string, query?: Fields, queryRequired?: string[]): void { routes.push({ method: "GET", path: path(pattern), query, queryRequired }); }
get("(snapshot|settings|providers|bots|sessions|allow-rules|mcp-servers|skills|memories|routines|credential-operations)");
get("(providers|bots|sessions|attachments|requests)/:id");
get("sessions/:id/(snapshot|judgements|routes|composer-suggestions)");
get("sessions/:id/messages", { cursor: v => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[0-9A-HJKMNP-TV-Z]{26}$/.test(v), limit: v => typeof v === "string" && /^[1-9][0-9]{0,2}$/.test(v) && Number(v) <= 200 });
get("bots/:id/profile-revisions"); get("attachments/:id/content");
get("tasks/:id/artifacts");
get("annotations", { relpath: v => typeof v === "string" && v.length <= 4096, session_id: id, target_session_id: id, message_id: id, target_message_id: id, status: one("draft", "open", "resolved") });
get("annotations/:id"); get("annotations/:id/crop");
get("tasks/:id/trace");
get("sessions/:id/tasks");
get("workspace/tree", { path: string }); get("workspace/file", { path: string }, ["path"]);
get("host/tree", { path: string });
get("events/catchup", { event_instance_id: v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v), after_seq: v => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && Number.isSafeInteger(Number(v)) }, ["event_instance_id", "after_seq"]);
get("approvals", { status: one("pending") });
get("spend", { session_id: id, bot_id: id, turn_id: id }); get("search", { q: string }, ["q"]);
get("notifications", { filter: one("actionable", "unread", "all"), limit: v => typeof v === "string" && /^[1-9][0-9]{0,2}$/.test(v) && Number(v) <= 100, cursor: v => typeof v === "string" && v.length <= 256 });
get("notifications/:id");
get("notification-policy");
get("notification-device");
add("POST", "models/probe", { endpoint_base_url: string, endpoint_api_key: string, provider_id: id });
add("POST", "bots", bot, ["name", "duties", "boundaries"]);
add("POST", "providers", provider, ["name", "base_url"]);
add("POST", "mcp-servers", mcp, ["name"]);
add("POST", "skills", { ...skill, bot_id: id }, ["bot_id", "name", "description", "body"]);
add("POST", "routines", { ...routine, bot_id: id }, ["bot_id", "title", "instruction", "schedule"]);
add("POST", "sessions", { name: string, members: list(id) }, ["name", "members"]);
add("POST", "allow-rules", { kind_key: string, scope: string }, ["kind_key", "scope"]);
add("POST", "turns/stop", { turn_id: id }, ["turn_id"]); add("POST", "turns/continue", { message_id: id }, ["message_id"]);
add("POST", "sessions/:id/messages", { body: string, parent_id: nullable(id), ask_id: nullable(id), fork: bool, files: list(object({ filename: string, size: v => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= REMOTE_FILE_LIMIT, sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) }, ["filename", "size", "sha256"])) }, ["body"]);
add("POST", "sessions/:id/members", { bot_id: id }, ["bot_id"]);
const num: Check = v => typeof v === "number" && Number.isFinite(v);
// The union of every anchor kind's fields; the daemon checks the shape per kind, this only shuts out strangers.
const anchor: Check = object({ start_line: num, start_col: num, end_line: num, end_col: num, quote: string, prefix: string, suffix: string, view: one("rendered"),
  x: num, y: num, w: num, h: num, natural_width: num, natural_height: num, page: num, selector: string, tag: string, text: string, outer_html: string,
  rect: object({ x: num, y: num, w: num, h: num }, ["x", "y", "w", "h"]), start_ms: num, end_ms: num, duration_ms: num });
const crop = nullable(object({ mime: one("image/png", "image/jpeg"), base64: v => typeof v === "string" && /^[A-Za-z0-9+/=]+$/.test(v) && v.length <= 1_400_000 }, ["mime", "base64"]));
add("POST", "annotations", { target_message_id: id, relpath: string, anchor_kind: one("text_range", "image_region", "pdf_region", "html_element", "media_time"), anchor, content_sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v), body: string, crop }, ["target_message_id", "relpath", "anchor_kind", "anchor", "content_sha256", "body"]);
add("POST", "annotations/send", { session_id: id, body: string, annotation_ids: list(id) }, ["session_id", "annotation_ids"]);
add("PATCH", "annotations/:id", { body: string, anchor, crop, content_sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v), status: one("open", "resolved"), ...revision }, [], true);
add("DELETE", "annotations/:id", revision);
add("POST", "sessions/:id/read", { through_message_id: id });
add("POST", "sessions/:id/(archive|restore|clear)", revision); add("POST", "bots/:id/(archive|restore)", revision);
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
  default_provider_id: nullable(id), launch_at_login: bool, locale: one("en", "zh"), theme: one("system", "light", "dark"),
  if_revision: v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 }, [], true);
for (const [name, fields] of Object.entries({ bots: bot, providers: provider, "mcp-servers": mcp, skills: skill, routines: routine,
  memories: { subject: string, body: string, enabled: bool }, sessions: { name: string } } as Record<string, Fields>)) add("PATCH", `${name}/:id`, { ...fields, ...revision }, [], true);
add("DELETE", "(bots|sessions|providers|mcp-servers|skills|memories|routines|allow-rules)/:id", revision);
add("DELETE", "sessions/:id/messages", revision);
add("DELETE", "sessions/:id/members", { ...revision, bot_id: id }, ["bot_id"]);
for (const method of ["PUT", "DELETE"] as const) add(method, "messages/:id/reactions", { emoji: string }, ["emoji"]);
add("PUT", "workspace/file", { path: string, content: string }, ["path", "content"]);

// Terminals. A paired device has the same reach as the window here — that is the decision, and
// the gate is remote itself (default off, native activation), not a second one bolted on.
// `host/tree` already let a device read outside the workspace, so this is not a new frontier.
const axis: Check = v => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000;
const offset: Check = v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const base64: Check = v => typeof v === "string" && v.length <= 87_384 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
get("terminals");
get("terminals/:id");
get("terminals/:id/scrollback", { from: v => typeof v === "string" && /^(0|[1-9][0-9]{0,15})$/.test(v) });
add("POST", "terminals", { cwd: string, rows: axis, cols: axis }, ["cwd"]);
add("POST", "terminals/:id/input", { data: base64 }, ["data"]);
add("POST", "terminals/:id/resize", { rows: axis, cols: axis }, ["rows", "cols"]);
add("POST", "terminals/:id/signal", { signal: one("SIGINT", "SIGQUIT", "SIGTSTP", "SIGTERM", "SIGKILL") }, ["signal"]);
add("POST", "terminals/:id/watch", { from: offset });
add("POST", "terminals/:id/unwatch", {});
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
    if (/^\/v1\/credential-operations\//.test(request.path) && request.body?.action === "repair" && !request.body.value) throw new HttpError(422, "invalid_args", "credential value required");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "invalid_args", "invalid remote properties");
  }
}
