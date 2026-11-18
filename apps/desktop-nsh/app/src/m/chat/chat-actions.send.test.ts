import "../../platform/install";
import { expect, test } from "nsh/test";
import { ApiError, type MessengerApi } from "../api.ts";
import { SessionView } from "../session-view.svelte.ts";
import { ChatActions, type ChatActionsHost } from "./chat-actions.svelte.ts";

/** A send whose `postMessage` ends the way `answer` says, and how often it marked the link down. */
function sending(answer: () => Promise<unknown>, keepsUnknown = false) {
  const view = new SessionView("s1");
  view.draft = "三张图";
  let drops = 0;
  const api = { postMessage: answer } as unknown as MessengerApi;
  const host = {
    api, connection: "connected", selectedId: "s1", notificationCapabilities: {},
    viewFor: () => view,
    claimFocus: () => {},
    keepUnknownRequest: () => keepsUnknown,
    markDisconnected: () => { drops += 1; },
  } as unknown as ChatActionsHost;
  const actions = new ChatActions(host);
  return { view, actions, drops: () => drops };
}

const pictures = [new File(["a"], "a.jpg"), new File(["b"], "b.jpg"), new File(["c"], "c.jpg")];

test("paths a project session sends in the line go after the draft, one a line", async () => {
  const bodies: string[] = [];
  const s = sending(async () => ({ id: "m1" }));
  (s.actions as unknown as { host: { api: { postMessage: (id: string, body: string) => Promise<unknown> } } }).host.api.postMessage = async (_id, body) => {
    bodies.push(body);
    return { id: "m1" };
  };
  expect(await s.actions.send({ lines: ["/code/app/src/main.ts", "/code/app/README.md"] })).toBe(true);
  expect(bodies).toEqual(["三张图\n\n/code/app/src/main.ts\n/code/app/README.md"]);
  // With no words of its own, the paths are the line.
  s.view.draft = "";
  expect(await s.actions.send({ lines: ["/code/app/src/main.ts"] })).toBe(true);
  expect(bodies[1]).toBe("/code/app/src/main.ts");
});

test("a send the Mac refuses is a refusal, not a lost link: it says why, and nothing reconnects", async () => {
  const s = sending(async () => { throw new ApiError(429, "stream_limit", "file stream limit", "01ARZ3NDEKTSV4RRFFQ69G5FB0"); });
  expect(await s.actions.send({ attachments: pictures })).toBe(false);
  expect(s.drops()).toBe(0);
  expect(s.view.sendRefused).toBe("too_many_files");
  expect(s.view.sending).toBe(false);
});

for (const [status, code] of [[404, "not_found"], [409, "conflict"], [413, "file_limit"], [422, "invalid_args"]] as const) {
  test(`a ${status} from the Mac is refused too`, async () => {
    const s = sending(async () => { throw new ApiError(status, code, "no"); });
    expect(await s.actions.send({ attachments: pictures })).toBe(false);
    expect(s.drops()).toBe(0);
    expect(s.view.sendRefused).toBe("refused");
  });
}

test("the record of an upload a dropped link cut short does not cost a press: it goes again, once", async () => {
  let asked = 0;
  const s = sending(async () => {
    asked += 1;
    if (asked === 1) throw new ApiError(409, "cancelled", "upload cancelled", "01ARZ3NDEKTSV4RRFFQ69G5FB0");
    return { id: "m1" };
  });
  expect(await s.actions.send({ attachments: pictures })).toBe(true);
  expect(asked).toBe(2);
  expect(s.drops()).toBe(0);
  expect(s.view.sendRefused).toBeNull();

  let again = 0;
  const twice = sending(async () => {
    again += 1;
    throw new ApiError(409, "cancelled", "upload cancelled");
  });
  expect(await twice.actions.send({ attachments: pictures })).toBe(false);
  expect(again).toBe(2);
  expect(twice.view.sendRefused).toBe("refused");
});

test("a link that really went is still a lost link", async () => {
  const s = sending(async () => { throw new ApiError(503, "request_unknown", "result unknown", "01ARZ3NDEKTSV4RRFFQ69G5FB0"); });
  expect(await s.actions.send({ attachments: pictures })).toBe(false);
  expect(s.drops()).toBe(1);
  expect(s.view.sendRefused).toBeNull();
  const plain = sending(async () => { throw new Error("socket closed"); });
  await plain.actions.send();
  expect(plain.drops()).toBe(1);
});

test("a 401 reconnects: that is how a window gets the token a restarted daemon issued", async () => {
  const s = sending(async () => { throw new ApiError(401, "unauthorized", "no"); });
  await s.actions.send();
  expect(s.drops()).toBe(1);
  expect(s.view.sendRefused).toBeNull();
});

test("a request whose result is still unknown keeps its way back through the reconnect", async () => {
  const s = sending(async () => { throw new ApiError(409, "request_pending", "resolve it first", "01ARZ3NDEKTSV4RRFFQ69G5FB0"); }, true);
  await s.actions.send();
  expect(s.drops()).toBe(1);
  expect(s.view.sendRefused).toBeNull();
});

test("the next send starts with the refusal cleared, and goes when the Mac takes it", async () => {
  let refuse = true;
  const s = sending(async () => {
    if (refuse) throw new ApiError(429, "stream_limit", "file stream limit");
    return { id: "m1" };
  });
  await s.actions.send({ attachments: pictures });
  expect(s.view.sendRefused).toBe("too_many_files");
  refuse = false;
  expect(await s.actions.send({ attachments: pictures.slice(0, 2) })).toBe(true);
  expect(s.view.sendRefused).toBeNull();
});

/** A question's answer, with the run (or none) the snapshot holds. */
function answering(runs: Record<string, unknown>) {
  const view = new SessionView("proj-1");
  const answered: unknown[][] = [];
  const api = { answerAsk: async (...args: unknown[]) => { answered.push(args); return null; } } as unknown as MessengerApi;
  const host = {
    api, connection: "connected", selectedId: "proj-1", notificationCapabilities: { pending_ask_v1: true },
    snapshot: { turns: [], agentRuns: runs },
    viewFor: () => view,
  } as unknown as ChatActionsHost;
  return { actions: new ChatActions(host), answered };
}

test("a project session's question is pending while its run waits on it, and stale otherwise", async () => {
  const waiting = answering({ "proj-1": { id: "run-1", session_id: "proj-1", status: "waiting_approval", asks: ["ask-1"] } });
  expect((await waiting.actions.sendAsk("ask-1", { selected: ["A"] }, "proj-1")).status).toBe("accepted");
  expect(waiting.answered).toHaveLength(1);
  const over = answering({ "proj-1": { id: "run-1", session_id: "proj-1", status: "completed", asks: ["ask-1"] } });
  expect(await over.actions.sendAsk("ask-1", { selected: ["A"] }, "proj-1")).toEqual({ status: "not_submitted", reason: "stale_ask" });
  expect(over.answered).toHaveLength(0);
});
