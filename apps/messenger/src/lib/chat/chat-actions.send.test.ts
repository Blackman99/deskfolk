import { expect, test } from "bun:test";
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

test("a send the Mac refuses is a refusal, not a lost link: it says why, and nothing reconnects", async () => {
  const s = sending(async () => { throw new ApiError(429, "stream_limit", "file stream limit", "01ARZ3NDEKTSV4RRFFQ69G5FB0"); });
  expect(await s.actions.send({ attachments: pictures })).toBe(false);
  expect(s.drops()).toBe(0);
  expect(s.view.sendRefused).toBe("too_many_files");
  expect(s.view.sending).toBe(false);
});

test.each([[404, "not_found"], [409, "conflict"], [413, "file_limit"], [422, "invalid_args"]])("a %i from the Mac is refused too", async (status, code) => {
  const s = sending(async () => { throw new ApiError(status, code, "no"); });
  expect(await s.actions.send({ attachments: pictures })).toBe(false);
  expect(s.drops()).toBe(0);
  expect(s.view.sendRefused).toBe("refused");
});

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
