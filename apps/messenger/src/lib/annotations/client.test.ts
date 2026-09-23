import { expect, test } from "bun:test";
import { annotationsPath, createAnnotation, listAnnotations, patchAnnotation, sendAnnotations, type AnnotationHttp } from "./client.ts";

function recorder() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const http: AnnotationHttp = {
    async get<T>(path: string) {
      calls.push({ method: "GET", path });
      return { items: [{ id: "a1" }] } as T;
    },
    async post<T>(path: string, body?: unknown) {
      calls.push({ method: "POST", path, body });
      return { id: "a1", ...(body as object) } as T;
    },
    async patch<T>(path: string, body: unknown) {
      calls.push({ method: "PATCH", path, body });
      return { id: "a1", ...(body as object) } as T;
    },
  };
  return { calls, http };
}

test("the list path carries only the filters that are set, as query keys the daemon knows", () => {
  expect(annotationsPath()).toBe("/v1/annotations");
  expect(annotationsPath({ relpath: "work/2026-09-23-cover/cover.png", status: "draft" })).toBe(
    "/v1/annotations?relpath=work%2F2026-09-23-cover%2Fcover.png&status=draft",
  );
  expect(annotationsPath({ session_id: "s1", target_session_id: "s2", message_id: "m1", target_message_id: "m2" })).toBe(
    "/v1/annotations?session_id=s1&target_session_id=s2&message_id=m1&target_message_id=m2",
  );
});

test("each call hits its own route and unwraps the list", async () => {
  const { calls, http } = recorder();
  expect(await listAnnotations(http, { relpath: "report.md" })).toEqual([{ id: "a1" }]);
  await createAnnotation(http, {
    target_message_id: "m1",
    relpath: "report.md",
    anchor_kind: "text_range",
    anchor: { start_line: 1, start_col: 1, end_line: 1, end_col: 2, quote: "#", prefix: "", suffix: "" },
    content_sha256: "0".repeat(64),
    body: "标题",
  });
  await patchAnnotation(http, "a/1", { body: "改", if_revision: "r" });
  await sendAnnotations(http, { session_id: "s1", body: "看看", annotation_ids: ["a1"] });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /v1/annotations?relpath=report.md",
    "POST /v1/annotations",
    "PATCH /v1/annotations/a%2F1",
    "POST /v1/annotations/send",
  ]);
  expect(calls[2]!.body).toEqual({ body: "改", if_revision: "r" });
  expect(calls[3]!.body).toEqual({ session_id: "s1", body: "看看", annotation_ids: ["a1"] });
});
