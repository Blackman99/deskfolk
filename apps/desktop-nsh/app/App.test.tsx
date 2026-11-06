/**
 * The app headless against a stubbed runtime: the list, opening a conversation, sending a line.
 * `nsh test` runs it; nothing reaches a real runtime.
 */
import { expect, open, test } from "nsh/test";

const ORIGIN = "http://127.0.0.1:17990";
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 6, 7, minutes)).toISOString();

const writer = { id: "bot-writer", name: "Writer", duties: "", boundaries: "", avatar: null, model: null };
const participants = (...members: string[]) => members.map((member) => ({ member, joined_at: at(0), left_at: null }));
const line = (id: string, author: string, body: string, minute: number) => ({
  id,
  session_id: "s-direct",
  kind: author === "user" ? "user" : "bot",
  author,
  body,
  created_at: at(minute),
  parent_id: null,
  attachments: [],
  reactions: [],
  edited_at: null,
  withdrawn_at: null,
});

const direct = {
  id: "s-direct",
  kind: "direct",
  name: null,
  updated_at: at(5),
  archived_at: null,
  origin_session_id: null,
  origin_message_id: null,
  participants: participants("user", writer.id),
  last_message: line("m2", writer.id, "好的，这是摘要", 5),
  unread_count: 2,
};
const group = { ...direct, id: "s-group", kind: "group", name: "周报小组", updated_at: at(3), last_message: null, unread_count: 0 };

function runtime(sent: string[]) {
  return {
    [`GET ${ORIGIN}/v1/snapshot`]: {
      body: {
        event_instance_id: "i1",
        watermark_seq: 10,
        settings: {},
        bots: [writer],
        sessions: [group, direct],
        approvals: [],
        mcpServers: [],
        providers: [],
        skills: [],
        memories: [],
        routines: [],
      },
    },
    [`GET ${ORIGIN}/v1/sessions/s-direct/snapshot*`]: {
      body: {
        event_instance_id: "i1",
        watermark_seq: 10,
        judgements: [],
        session: {
          ...direct,
          turns: [],
          messages: {
            items: [
              line("m2", writer.id, "好的，这是摘要：\n\n- 第一点\n- 第二点\n\n```ts\nconst x = 1;\n```", 5),
              line("m1", "user", "帮我写个摘要", 4),
            ],
            next: null,
          },
        },
      },
    },
    [`POST ${ORIGIN}/v1/sessions/s-direct/messages`]: (request: { body?: string | null }) => {
      sent.push(request.body ?? "");
      return { status: 201, body: line("m3", "user", "谢谢", 6) };
    },
  };
}

function start(sent: string[] = []) {
  return open("App.tsx", {
    platform: "macos",
    width: 1100,
    height: 760,
    locale: "zh-CN",
    network: runtime(sent),
    host: { params: { origin: ORIGIN, token: "test-token", windowId: 1, material: "glass" } },
  });
}

test("lists the conversations, newest first, with what is unread", async () => {
  const app = await start();
  await app.waitFor("text:Writer");
  await app.waitFor("text:周报小组");
  const texts = app.texts();
  expect(texts.indexOf("Writer")).toBeLessThan(texts.indexOf("周报小组"));
  expect(texts).toContain("2");
});

test("opening a conversation shows its lines with Markdown", async () => {
  const app = await start();
  await app.press("id:session-s-direct");
  await app.waitFor("text:帮我写个摘要");
  await app.waitFor("text:第一点");
  expect(app.texts().join("\n")).toContain("const x = 1;");
});

test("Send posts the line to the open conversation and clears the composer", async () => {
  const sent: string[] = [];
  const app = await start(sent);
  await app.press("id:session-s-direct");
  await app.waitFor("text:帮我写个摘要");
  await app.type("id:composer", "谢谢");
  await app.press("text:发送");
  await app.waitUntil(() => sent.length === 1);
  expect(JSON.parse(sent[0]!)).toEqual({ body: "谢谢" });
  await app.waitUntil(() => app.value("id:composer") === "");
});

test("Return in the composer sends too", async () => {
  const sent: string[] = [];
  const app = await start(sent);
  await app.press("id:session-s-direct");
  await app.waitFor("text:帮我写个摘要");
  await app.type("id:composer", "好的");
  await app.submit("id:composer");
  await app.waitUntil(() => sent.length === 1);
  expect(JSON.parse(sent[0]!)).toEqual({ body: "好的" });
});
