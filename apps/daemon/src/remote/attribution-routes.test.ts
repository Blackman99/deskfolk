import { expect, test } from "bun:test";
import type { RemoteRequest } from "@real-bot/remote";
import { validateBusiness } from "./routes";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const edit = (body: unknown): RemoteRequest => ({ v: 1, id, method: "PATCH", path: `/v1/messages/${id}/attribution`, body: body as RemoteRequest["body"] });

test("the phone can correct every message filing, but cannot smuggle unknown fields or invalid targets", () => {
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: `/v1/messages/${id}/attribution` })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: `/v1/messages/${id}/attribution`, query: { wake: "yes" } })).toThrow();
  for (const body of [
    { filings: [{ plan_id: id, ticket_id: null, part_key: null }] },
    { filings: [{ plan_id: id, ticket_id: id, part_key: "shot_07" }, { plan_id: id }] },
    { filings: [] },
    { plan_id: id, ticket_id: id, part_key: "shot_07" },
  ]) expect(() => validateBusiness(edit(body))).not.toThrow();
  for (const body of [
    {}, null, [], { filings: "all" }, { filings: [{ plan_id: "nope" }] },
    { filings: [{ plan_id: id, strength: "locked" }] },
    { filings: [{ plan_id: id, ticket_id: 1 }] },
    { filings: [{ plan_id: id, part_key: "x".repeat(201) }] },
    { filings: [], user_action_id: id }, { plan_id: id, filings: [] },
  ]) expect(() => validateBusiness(edit(body))).toThrow();
});

test("the phone's lead API needs explicit confirmation, and never writes from suggestion reads", () => {
  const route = (method: "GET" | "PUT", body?: RemoteRequest["body"]): RemoteRequest => ({ v: 1, id, method, path: `/v1/sessions/${id}/lead`, ...(body === undefined ? {} : { body }) });
  expect(() => validateBusiness(route("GET"))).not.toThrow();
  expect(() => validateBusiness(route("PUT", { bot_id: id, confirmed: true }))).not.toThrow();
  expect(() => validateBusiness(route("PUT", { bot_id: null, confirmed: true }))).not.toThrow();
  for (const body of [{ bot_id: id }, { bot_id: id, confirmed: false }, { bot_id: "user", confirmed: true }, { bot_id: id, confirmed: true, source: "model" }]) {
    expect(() => validateBusiness(route("PUT", body))).toThrow();
  }
});

test("the phone can change a line of yours and read what it said before, with nothing but the words", () => {
  const change = (body: unknown): RemoteRequest => ({ v: 1, id, method: "PATCH", path: `/v1/messages/${id}`, body: body as RemoteRequest["body"] });
  expect(() => validateBusiness(change({ body: "片长 45 秒" }))).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: `/v1/messages/${id}/versions` })).not.toThrow();
  for (const body of [{}, null, [], { body: 45 }, { body: "x", parent_id: id }, { body: "x", task_id: id }]) {
    expect(() => validateBusiness(change(body))).toThrow();
  }
  // Only lines are changed this way: not a message's whole record, nor anything else.
  expect(() => validateBusiness({ v: 1, id, method: "DELETE", path: `/v1/messages/${id}` })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: `/v1/messages/${id}/versions`, query: { all: "1" } })).toThrow();
});

test("the phone can take back a line no Bot has read, or have it read now, and send nothing more with either", () => {
  for (const action of ["withdraw", "insert"]) {
    const post = (body?: unknown): RemoteRequest => ({ v: 1, id, method: "POST", path: `/v1/messages/${id}/${action}`, ...(body === undefined ? {} : { body: body as RemoteRequest["body"] }) });
    expect(() => validateBusiness(post({}))).not.toThrow();
    expect(() => validateBusiness(post({ reason: "x" }))).toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "GET", path: `/v1/messages/${id}/${action}` })).toThrow();
  }
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: `/v1/messages/${id}/delete`, body: {} })).toThrow();
});
