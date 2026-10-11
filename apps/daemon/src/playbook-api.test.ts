import { expect, test } from "bun:test";
import type { Playbook, PlaybookList, PlaybookRevision, SessionDetail } from "@real-bot/protocol";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

async function call<T>(h: Awaited<ReturnType<typeof startLocalApi>>, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${h.origin}${path}`, {
    method,
    headers: auth(h, { "Content-Type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

test("engines over the local API: list, change with a revision guard, reset a step, make and remove one, choose a conversation's", async () => {
  const h = await startLocalApi();
  const list = await call<PlaybookList>(h, "GET", "/v1/playbooks");
  expect(list.data.items.map((item) => item.id)).toEqual(["general", "video", "coding"]);

  const video = await call<Playbook>(h, "PUT", "/v1/playbooks/video", { diff: { v: 1, steps: { settle: { params: { quiet_s: 90 } } } }, if_revision: null });
  expect(video).toMatchObject({ status: 200, data: { revision: 1, resolved: { settle: { params: { quiet_s: 90 } } } } });
  const stale = await call<{ error: { code: string } }>(h, "PUT", "/v1/playbooks/video", { diff: { v: 1, steps: {} }, if_revision: null });
  expect(stale).toMatchObject({ status: 409, data: { error: { code: "conflict" } } });
  const wrong = await call<{ error: { message: string } }>(h, "PUT", "/v1/playbooks/video", { diff: { v: 1, steps: { reader: { on: false } } } });
  expect(wrong.status).toBe(422);
  const reset = await call<Playbook>(h, "POST", "/v1/playbooks/video/reset", { step: "settle", if_revision: video.data.revision_id });
  expect(reset.data).toMatchObject({ revision: 2, diff: { steps: {} } });
  const history = await call<{ items: PlaybookRevision[] }>(h, "GET", "/v1/playbooks/video/revisions");
  expect(history.data.items.map((row) => row.op)).toEqual(["reset", "edit"]);

  const mine = await call<Playbook>(h, "POST", "/v1/playbooks", { from: "coding", name: "前端" });
  expect(mine).toMatchObject({ status: 201, data: { base_id: "coding", name: "前端" } });
  const bot = await call<{ direct_session: SessionDetail }>(h, "POST", "/v1/bots", { name: "Dev", duties: "code", boundaries: "none", playbook_id: mine.data.id });
  expect(bot.data.direct_session.playbook_id).toBe(mine.data.id);
  const chosen = await call<SessionDetail>(h, "PUT", `/v1/sessions/${bot.data.direct_session.id}/playbook`, { playbook_id: "video" });
  expect(chosen).toMatchObject({ status: 200, data: { playbook_id: "video" } });
  expect((await call(h, "DELETE", `/v1/playbooks/${mine.data.id}`)).status).toBe(200);
  expect((await call(h, "GET", `/v1/playbooks/${mine.data.id}`)).status).toBe(404);

  const settings = await call<{ default_playbook: string }>(h, "PATCH", "/v1/settings", { default_playbook: "video" });
  expect(settings.data.default_playbook).toBe("video");
});
