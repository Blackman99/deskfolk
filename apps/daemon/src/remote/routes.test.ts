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
  bad(ticketEdit({ if_revision: 1 }));

  ok({ v: 1, id, method: "GET", path: "/v1/spend", query: { kind: "organize" } });
  bad({ v: 1, id, method: "GET", path: "/v1/spend", query: { kind: "organise" } });
});
