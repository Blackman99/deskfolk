import { expect, test } from "bun:test";
import { ANNOTATION_REMOTE_CROP_BASE64_MAX } from "@real-bot/protocol";
import { canonicalBytes, MAX_LOGICAL_MESSAGE, type RemoteRequest } from "@real-bot/remote";
import { HttpError } from "../errors";
import { validateBusiness } from "./routes";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const anchor = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, natural_width: 1000, natural_height: 500 };
const crop = (length: number) => ({ mime: "image/jpeg", base64: "A".repeat(length) });
const create = (length: number): RemoteRequest => ({
  v: 1, id, method: "POST", path: "/v1/annotations",
  body: { target_message_id: id, relpath: "shot.png", anchor_kind: "image_region", anchor, content_sha256: "a".repeat(64), body: "b", crop: crop(length) },
});
const edit = (length: number): RemoteRequest => ({
  v: 1, id, method: "PATCH", path: `/v1/annotations/${id}`, body: { anchor, crop: crop(length), if_revision: "2026-09-24T08:30:00.000Z" },
});

test("a remote crop is admitted only as long as a request carrying it can arrive in one logical message", () => {
  expect(ANNOTATION_REMOTE_CROP_BASE64_MAX).toBeLessThan(MAX_LOGICAL_MESSAGE);
  for (const request of [create, edit]) {
    // The largest crop the whitelist admits still fits, with the request around it, in 1 MiB.
    expect(canonicalBytes(request(ANNOTATION_REMOTE_CROP_BASE64_MAX)).length).toBeLessThanOrEqual(MAX_LOGICAL_MESSAGE);
    expect(() => validateBusiness(request(ANNOTATION_REMOTE_CROP_BASE64_MAX))).not.toThrow();
    // Past it — and the 1.4M characters once allowed, which no device can deliver — is refused before any effect.
    for (const length of [ANNOTATION_REMOTE_CROP_BASE64_MAX + 4, MAX_LOGICAL_MESSAGE, 1_400_000]) {
      let refused: unknown = null;
      try {
        validateBusiness(request(length));
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(HttpError);
      expect((refused as HttpError).status).toBe(422);
      expect((refused as HttpError).code).toBe("invalid_args");
    }
  }
});

test("plans and tickets: reads are whitelisted, a spec edit carries the whole spec, a ticket edit only its fields", () => {
  const ok = (request: RemoteRequest) => expect(() => validateBusiness(request)).not.toThrow();
  const bad = (request: RemoteRequest) => expect(() => validateBusiness(request)).toThrow();
  const spec = { kind: "周报", goal: "写一份周报", acceptance: ["交到 report.md"], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" };
  for (const path of [`/v1/tasks/${id}`, `/v1/tasks/${id}/tickets`, `/v1/tasks/${id}/spec-revisions`, `/v1/tasks/${id}/trace`]) {
    ok({ v: 1, id, method: "GET", path });
  }
  bad({ v: 1, id, method: "GET", path: `/v1/tasks/${id}/tickets`, query: { unknown: "1" } });

  const specEdit = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "PATCH", path: `/v1/tasks/${id}/spec`, body });
  ok(specEdit({ spec, if_revision: 3 }));
  ok(specEdit({ spec: { goal: "只有目标" } }));
  bad(specEdit({ spec: { kind: "周报" } }));
  bad(specEdit({ spec: { ...spec, status: "later" } }));
  bad(specEdit({ spec: { ...spec, owner: "me" } }));
  bad(specEdit({ spec: { ...spec, progress: { done: [] } } }));
  bad(specEdit({ spec, if_revision: "3" }));
  bad(specEdit({ spec, note: "x" }));
  bad(specEdit({ spec: "写一份周报" }));
  bad(specEdit({ if_revision: 3 }));

  const ticketEdit = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "PATCH", path: `/v1/tickets/${id}`, body });
  ok(ticketEdit({ status: "done", if_revision: 1 }));
  ok(ticketEdit({ title: "初稿", spec: "第一版", worker: null }));
  ok(ticketEdit({ worker: id }));
  bad(ticketEdit({ status: "later" }));
  bad(ticketEdit({ assignee: id }));
  bad(ticketEdit({ worker: "bob" }));
  // The tickets it waits for (ADR 0045): ids only, as a list.
  ok(ticketEdit({ depends_on: [id] }));
  ok(ticketEdit({ depends_on: [] }));
  bad(ticketEdit({ depends_on: id }));
  bad(ticketEdit({ depends_on: ["shot 3"] }));
  bad(ticketEdit({ if_revision: 1 }));

  ok({ v: 1, id, method: "GET", path: "/v1/spend", query: { kind: "organize" } });
  bad({ v: 1, id, method: "GET", path: "/v1/spend", query: { kind: "organise" } });
  // A purpose split out of its kind is a line of its own (ADR 0042); a category's whole list fits.
  ok({ v: 1, id, method: "GET", path: "/v1/spend/summary", query: { kind: "composer_suggest,acceptance_check,scribe,vision" } });
  ok({ v: 1, id, method: "GET", path: "/v1/spend", query: { kind: "turn,judgement,route_pick,route_review,route_learn,composer_suggest,organize,acceptance_check,scribe,vision,reflect,reader" } });
  bad({ v: 1, id, method: "GET", path: "/v1/spend", query: { kind: "scribe,scribe,scribe,scribe,scribe,scribe,scribe,scribe,scribe,scribe,scribe,scribe,scribe" } });
});

test("acceptance checks: create needs item and kind, a patch needs more than just if_revision, run and delete take a bare or revisioned body", () => {
  const ok = (request: RemoteRequest) => expect(() => validateBusiness(request)).not.toThrow();
  const bad = (request: RemoteRequest) => expect(() => validateBusiness(request)).toThrow();

  const create = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "POST", path: `/v1/tasks/${id}/checks`, body });
  ok(create({ item: "交到 report.md", kind: "exists", path: "report.md" }));
  ok(create({ item: "跑测试", kind: "command", command: "bun test", cwd: "work/x", expect_exit: 0, expect_stdout: "ok", timeout_sec: 60 }));
  ok(create({ item: "x", kind: "matches", path: "a.md", pattern: "^ok$", negate: true }));
  bad(create({ kind: "exists", path: "report.md" }));
  bad(create({ item: "交到 report.md" }));
  bad(create({ item: "x", kind: "verify" }));
  bad(create({ item: "x", kind: "exists", path: "report.md", extra: 1 }));
  bad(create({ item: "x", kind: "command", command: "bun test", timeout_sec: 1.5 }));
  bad(create({ item: "x", kind: "exists", ticket_id: "bob" }));

  const patch = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "PATCH", path: `/v1/checks/${id}`, body });
  ok(patch({ item: "换个说法", if_revision: "2026-09-24T08:30:00.000Z" }));
  ok(patch({ negate: true }));
  ok(patch({ ticket_id: null }));
  bad(patch({ if_revision: "2026-09-24T08:30:00.000Z" }));
  bad(patch({ kind: "verify" }));
  bad(patch({ if_revision: 3 }));

  const del = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "DELETE", path: `/v1/checks/${id}`, body });
  ok(del({}));
  ok(del({ if_revision: "2026-09-24T08:30:00.000Z" }));
  bad(del({ if_revision: 3 }));

  const run = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "POST", path: `/v1/tasks/${id}/checks/run`, body });
  ok(run({}));
  ok(run({ check_id: id }));
  bad(run({ check_id: "bob" }));
});

test("an answer to a question: choices by label and text of your own, nothing else", () => {
  const answer = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "POST", path: `/v1/messages/${id}/answer`, body });
  expect(() => validateBusiness(answer({ selected: ["A", "B"], custom: "and why" }))).not.toThrow();
  expect(() => validateBusiness(answer({ custom: null, selected: [] }))).not.toThrow();
  expect(() => validateBusiness(answer({ selected: "A" }))).toThrow();
  expect(() => validateBusiness(answer({ selected: [1] }))).toThrow();
  expect(() => validateBusiness(answer({ custom: "x", body: "x" }))).toThrow();
});

test("a posted message may point at workspace paths, as a list of non-empty strings", () => {
  const post = (body: Record<string, unknown>): RemoteRequest => ({ v: 1, id, method: "POST", path: `/v1/sessions/${id}/messages`, body });
  expect(() => validateBusiness(post({ body: "", paths: ["docs/brief.md", "shots"] }))).not.toThrow();
  expect(() => validateBusiness(post({ body: "", paths: [] }))).not.toThrow();
  expect(() => validateBusiness(post({ body: "", paths: "docs/brief.md" }))).toThrow();
  expect(() => validateBusiness(post({ body: "", paths: [""] }))).toThrow();
  expect(() => validateBusiness(post({ body: "", paths: ["x".repeat(4097)] }))).toThrow();
});

test("a phone can read capabilities: bare GET is whitelisted, a query is not", () => {
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/capabilities" })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/capabilities", query: { engine_level: "1" } })).toThrow();
});

test("a phone cannot raise the engine level past an older installed app, nor take that back: it is the Mac's own", () => {
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/capabilities/raise", body: { accept_older_app: true } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "DELETE", path: "/v1/capabilities/raise" })).toThrow();
});

test("a phone can list, make and lift holds, with nothing past their fields", () => {
  const ok = (request: Omit<RemoteRequest, "v" | "id">) => validateBusiness({ v: 1, id, ...request });
  expect(() => ok({ method: "GET", path: "/v1/holds" })).not.toThrow();
  expect(() => ok({ method: "GET", path: "/v1/holds", query: { status: "all" } })).not.toThrow();
  expect(() => ok({ method: "GET", path: "/v1/holds", query: { status: "lifted" } })).toThrow();
  expect(() => ok({ method: "GET", path: `/v1/holds/${id}` })).not.toThrow();
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "global", scope_id: null } })).not.toThrow();
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "bot_plan", scope_id: `${id}:${id}`, lift_on_next_user_message: true } })).not.toThrow();
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "plan", scope_id: id, action: "cancel", cascade: false } })).not.toThrow();
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope_id: id } })).toThrow();
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "everyone", scope_id: id } })).toThrow();
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "bot", scope_id: "not-an-id" } })).toThrow();
  // Where a stop came from is the app's to record, never the caller's to claim.
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "bot", scope_id: id, source: "legacy" } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/holds/${id}/lift`, body: {} })).not.toThrow();
  expect(() => ok({ method: "POST", path: `/v1/holds/${id}/lift`, body: { by: "organizer" } })).toThrow();
  // The phone's stop menu names the conversation it was in, for the receipt.
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "global", session_id: id } })).not.toThrow();
  expect(() => ok({ method: "POST", path: "/v1/holds", body: { scope: "global", session_id: "here" } })).toThrow();
});

test("a phone can press a button on a line about your stops, one it names, nothing else", () => {
  const ok = (request: Omit<RemoteRequest, "v" | "id">) => validateBusiness({ v: 1, id, ...request });
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "undo" } })).not.toThrow();
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "only_plan", task_id: id } })).not.toThrow();
  // A restart notice's 继续 and 不续 (ADR 0041).
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "resume" } })).not.toThrow();
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "leave" } })).not.toThrow();
  // The app's line about checks from your words (ADR 0040 P3).
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "remove_check" } })).not.toThrow();
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "confirm_check" } })).not.toThrow();
  // 改 is the messenger's own: it fills your composer and is never sent.
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "edit_check" } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/checks/${id}/confirm`, body: {} })).not.toThrow();
  expect(() => ok({ method: "POST", path: `/v1/checks/${id}/confirm`, body: { measure: { dimension: "duration", min: 1, max: 2 } } })).toThrow();
  // The app's lines about the requirements ledger (ADR 0040 P3); 逐条看 opens the board and is never sent.
  for (const action of ["confirm_requirements", "make_standing", "keep_project"]) {
    expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action } })).not.toThrow();
  }
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "review_requirements" } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: {} })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "lift_everything" } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "stop_plan", task_id: "EP01" } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/messages/${id}/control`, body: { action: "stop", source: "user_text" } })).toThrow();
});

test("a phone can confirm new-plan undo or quoted-message merge without forging action provenance", () => {
  const ok = (body: Record<string, unknown>) => validateBusiness({ v: 1, id, method: "POST", path: `/v1/messages/${id}/control`, body });
  expect(() => ok({ action: "undo_plan" })).not.toThrow();
  expect(() => ok({ action: "merge_plan", task_id: id })).not.toThrow();
  expect(() => ok({ action: "merge_plan", task_id: "EP01" })).toThrow();
  expect(() => ok({ action: "undo_plan", user_action_id: id })).toThrow();
});

test("a phone can act on an entry of the requirements ledger from the board, naming the plan", () => {
  const ok = (request: Omit<RemoteRequest, "v" | "id">) => validateBusiness({ v: 1, id, ...request });
  for (const action of ["confirm", "reject", "waive", "not_here", "here_again", "whole_project"]) {
    expect(() => ok({ method: "POST", path: `/v1/requirements/${id}/action`, body: { action, task_id: id } })).not.toThrow();
  }
  expect(() => ok({ method: "POST", path: `/v1/requirements/${id}/action`, body: { action: "confirm" } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/requirements/${id}/action`, body: { action: "purge", task_id: id } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/requirements/${id}/action`, body: { action: "waive", task_id: id, quote: "x" } })).toThrow();
});

test("a phone clearing or deleting a conversation may erase what you said there too, and say nothing else", () => {
  const ok = (request: Omit<RemoteRequest, "v" | "id">) => validateBusiness({ v: 1, id, ...request });
  for (const [method, path] of [["POST", `/v1/sessions/${id}/clear`], ["DELETE", `/v1/sessions/${id}`], ["DELETE", `/v1/sessions/${id}/messages`]] as const) {
    expect(() => ok({ method, path, body: { if_revision: "r" } })).not.toThrow();
    expect(() => ok({ method, path, body: { if_revision: "r", erase_quotes: true } })).not.toThrow();
    expect(() => ok({ method, path, body: { erase_quotes: "yes" } })).toThrow();
    expect(() => ok({ method, path, body: { erase_messages: true } })).toThrow();
  }
  // Only conversations: a Bot or an endpoint takes no such field.
  expect(() => ok({ method: "DELETE", path: `/v1/bots/${id}`, body: { if_revision: "r", erase_quotes: true } })).toThrow();
  expect(() => ok({ method: "POST", path: `/v1/sessions/${id}/archive`, body: { if_revision: "r", erase_quotes: true } })).toThrow();
});

test("the organizer's own debug trail is never on the remote whitelist, task_id or not", () => {
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/debug/organizer-runs" })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/debug/organizer-runs", query: { task_id: id } })).toThrow();
});

test("a model entry may carry its output cap, measured speed and reasoning verdict, or null to clear one", () => {
  const save = (models: unknown[]): RemoteRequest => ({ v: 1, id, method: "POST", path: "/v1/providers", body: { name: "p", base_url: "https://x", models } });
  expect(() => validateBusiness(save([{ name: "grok", max_output: 32_768, stream_tps_p10: 42.5, reasoning_effective: false }]))).not.toThrow();
  expect(() => validateBusiness(save([{ name: "grok", max_output: null, stream_tps_p10: null, reasoning_effective: null }]))).not.toThrow();
  expect(() => validateBusiness(save([{ name: "gemini", input_image: true }, { name: "grok", input_image: null }]))).not.toThrow();
  for (const bad of [{ max_output: 0 }, { max_output: 1.5 }, { max_output: "32k" }, { stream_tps_p10: -1 }, { reasoning_effective: "yes" }, { input_image: "yes" }]) {
    expect(() => validateBusiness(save([{ name: "grok", ...bad }]))).toThrow();
  }
});

test("quality events, the report and lessons are readable remotely; a lesson can be retired and a turn marked", () => {
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/quality/events", query: { category: "model", limit: "50" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/quality/events", query: { category: "blame" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/quality/report", query: { days: "7" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/lessons" })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: `/v1/lessons/${id}`, body: { status: "retired" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: `/v1/lessons/${id}`, body: { status: "candidate" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: `/v1/turns/${id}/mark-model` })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "DELETE", path: `/v1/turns/${id}/mark-model` })).not.toThrow();
});

test("project skills are listed, shared, turned off and unshared remotely; nothing else rides along", () => {
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/shared-skills" })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: `/v1/skills/${id}/share` })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: `/v1/shared-skills/${id}`, body: { enabled: false } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: `/v1/shared-skills/${id}`, body: { enabled: false, body: "x" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: `/v1/shared-skills/${id}`, body: {} })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "DELETE", path: `/v1/shared-skills/${id}` })).not.toThrow();
});

test("a ticket's model is set or cleared remotely, and nothing else rides in it", () => {
  const patch = (body: unknown) => ({ v: 1 as const, id, method: "PATCH" as const, path: `/v1/tickets/${id}`, body: body as Record<string, unknown> });
  expect(() => validateBusiness(patch({ model_override: { provider_id: id, model: "gemini" } }))).not.toThrow();
  expect(() => validateBusiness(patch({ model_override: null }))).not.toThrow();
  expect(() => validateBusiness(patch({ model_override: { provider_id: id } }))).toThrow();
  expect(() => validateBusiness(patch({ model_override: { provider_id: id, model: "m", thinking: "high" } }))).toThrow();
});

test("the model ladder is read and set remotely as a list of rungs, nothing more", () => {
  const put = (body: unknown) => ({ v: 1 as const, id, method: "PUT" as const, path: "/v1/model-ladder", body: body as Record<string, unknown> });
  expect(() => validateBusiness({ v: 1 as const, id, method: "GET" as const, path: "/v1/model-ladder" })).not.toThrow();
  expect(() => validateBusiness(put({ items: [{ provider_id: id, model: "gemini" }] }))).not.toThrow();
  expect(() => validateBusiness(put({ items: [] }))).not.toThrow();
  expect(() => validateBusiness(put({}))).toThrow();
  expect(() => validateBusiness(put({ items: [{ provider_id: id }] }))).toThrow();
  expect(() => validateBusiness(put({ items: [{ provider_id: id, model: "m", thinking: "high" }] }))).toThrow();
});
