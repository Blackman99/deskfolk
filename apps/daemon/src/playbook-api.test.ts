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

test("an engine's own System section over the local API: what it stands in for, checked as a prompt's edit is", async () => {
  const h = await startLocalApi();
  // A fixture store starts below work items, where the only way to work is the one that level runs.
  h.store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '8')");
  const asked = await call<{ text: string; own: string | null }>(h, "GET", "/v1/playbooks/plain/system?locale=zh");
  expect(asked.data.own).toBeNull();
  expect(asked.data.text).toContain("壳默认在工作区根");
  expect((await call<{ text: string }>(h, "GET", "/v1/playbooks/general/system?locale=zh")).data.text).toContain("壳默认在本轮的任务目录里");
  expect((await call(h, "GET", "/v1/playbooks/plain/system")).status).toBe(422);

  const saved = await call<Playbook>(h, "PUT", "/v1/playbooks/plain", { diff: { v: 1, steps: {}, system: { zh: "我写的\r\n第二行" } } });
  expect(saved).toMatchObject({ status: 200, data: { diff: { system: { zh: "我写的\n第二行" } } } });
  expect((await call<{ own: string | null }>(h, "GET", "/v1/playbooks/plain/system?locale=zh")).data.own).toBe("我写的\n第二行");

  // Too long for what it stands in for, or with a control character: refused as a prompt's edit is.
  const long = await call<{ error: { code: string } }>(h, "PUT", "/v1/playbooks/plain", { diff: { v: 1, steps: {}, system: { zh: "长".repeat(49_000) } } });
  expect(long).toMatchObject({ status: 422, data: { error: { code: "prompt_too_long" } } });
  const control = await call<{ error: { code: string } }>(h, "PUT", "/v1/playbooks/plain", { diff: { v: 1, steps: {}, system: { zh: "x\u0001y" } } });
  expect(control).toMatchObject({ status: 422, data: { error: { code: "prompt_control_chars" } } });
  expect((await call(h, "PUT", "/v1/playbooks/plain", { diff: { v: 1, steps: {}, tools_off: ["files"] } })).status).toBe(422);

  const history = await call<{ items: PlaybookRevision[] }>(h, "GET", "/v1/playbooks/plain/revisions");
  expect(history.data.items.map((row) => row.op)).toEqual(["edit"]);
});

test("what moving to an engine with no jobs would leave standing over the local API", async () => {
  const h = await startLocalApi();
  const all = await call<{ sessions: number; open_jobs: number }>(h, "GET", "/v1/playbooks/impact");
  expect(all).toMatchObject({ status: 200, data: { open_jobs: 0 } });
});

test("engines over the local API: list, change with a revision guard, reset a step, make and remove one, choose a conversation's", async () => {
  const h = await startLocalApi();
  const list = await call<PlaybookList>(h, "GET", "/v1/playbooks");
  expect(list.data.items.map((item) => item.id)).toEqual(["general", "video", "coding", "plain"]);

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
