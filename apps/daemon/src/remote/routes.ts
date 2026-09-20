import type { RemoteRequest } from "@real-bot/remote";
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
  Object.entries(v).every(([k, value]) => !!fields[k]?.(value)) && required.every(k => Object.hasOwn(v, k));
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
get("workspace/tree", { path: string }); get("workspace/file", { path: string }, ["path"]);
get("events/catchup", { event_instance_id: v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v), after_seq: v => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && Number.isSafeInteger(Number(v)) }, ["event_instance_id", "after_seq"]);
get("approvals", { status: one("pending") });
get("spend", { session_id: id, bot_id: id, turn_id: id }); get("search", { q: string }, ["q"]);
add("POST", "models/probe", { endpoint_base_url: string, endpoint_api_key: string, provider_id: id });
add("POST", "bots", bot, ["name", "duties", "boundaries"]);
add("POST", "providers", provider, ["name", "base_url"]);
add("POST", "mcp-servers", mcp, ["name"]);
add("POST", "skills", { ...skill, bot_id: id }, ["bot_id", "name", "description", "body"]);
add("POST", "routines", { ...routine, bot_id: id }, ["bot_id", "title", "instruction", "schedule"]);
add("POST", "sessions", { name: string, members: list(id) }, ["name", "members"]);
add("POST", "allow-rules", { kind_key: string, scope: string }, ["kind_key", "scope"]);
add("POST", "turns/stop", { turn_id: id }, ["turn_id"]); add("POST", "turns/continue", { message_id: id }, ["message_id"]);
add("POST", "sessions/:id/messages", { body: string, parent_id: nullable(id), ask_id: nullable(id), fork: bool }, ["body"]);
add("POST", "sessions/:id/members", { bot_id: id }, ["bot_id"]);
add("POST", "sessions/:id/read", {});
add("POST", "sessions/:id/(archive|restore|clear)", revision); add("POST", "bots/:id/(archive|restore)", revision);
add("POST", "approvals/:id/resolve", { action: one("allow_once", "deny", "always_allow"), scope: string, api_key: string }, ["action"]);
add("POST", "credential-operations/:id/resolve", { action: one("repair", "cancel"), value: string }, ["action"]);
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

export function businessAllowed(request: RemoteRequest): boolean { return routes.some(r => r.method === request.method && r.path.test(request.path)); }
export function validateBusiness(request: RemoteRequest): void {
  const route = routes.find(r => r.method === request.method && r.path.test(request.path));
  if (!route) throw new HttpError(404, "not_found", "unknown remote route");
  if (!object(route.body ?? {}, route.required)(request.body ?? {}) || !object(route.query ?? {}, route.queryRequired)(request.query ?? {}) ||
    (route.patch && !Object.keys(request.body ?? {}).some(k => k !== "if_revision")) ||
    (request.ifMatch !== undefined && !(request.method === "PUT" && request.path === "/v1/workspace/file"))) {
    throw new HttpError(422, "invalid_args", "invalid remote properties");
  }
  if (/^\/v1\/credential-operations\//.test(request.path) && request.body?.action === "repair" && !request.body.value) throw new HttpError(422, "invalid_args", "credential value required");
}
