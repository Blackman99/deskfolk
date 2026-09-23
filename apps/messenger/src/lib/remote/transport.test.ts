import { expect, test } from "bun:test";
import { base64url, sha256Hex } from "@real-bot/remote";
import { RemoteTransport } from "./transport.ts";
import { deviceKeys, enrollment, fakeHost, type FakeSocket } from "./test-host.ts";

const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

function transportFor(socket: FakeSocket, now?: () => number): RemoteTransport {
  return new RemoteTransport(enrollment, deviceKeys, {
    socketFactory: () => socket as unknown as WebSocket,
    ...(now ? { now } : {}),
  });
}

/**
 * The regression. A relay, a Mac or a phone's radio ends the link and the browser says so — and
 * nothing here listened, so the page went on believing it was connected until something was
 * typed. Reconnecting was the user's job, by hand, through an interaction.
 */
test("a link that ends on its own is reported, and the page letting go is not", async () => {
  const relay = fakeHost();
  const transport = transportFor(relay.socket);
  await transport.connect();
  let drops = 0;
  transport.ondrop = () => { drops += 1; };
  relay.socket.drop();
  expect(drops).toBe(1);
  // The link is gone once, however many times the socket says so.
  relay.socket.drop();
  expect(drops).toBe(1);

  const own = fakeHost();
  const mine = transportFor(own.socket);
  await mine.connect();
  let ownDrops = 0;
  mine.ondrop = () => { ownDrops += 1; };
  mine.close();
  await Promise.resolve();
  await Promise.resolve();
  expect(own.socket.closedByPage).toBe(true);
  expect(ownDrops).toBe(0);
});

/**
 * The link a phone is left holding after it changes network: open as far as the browser knows,
 * carrying nothing. Only silence against an outstanding answer says otherwise.
 */
test("an answer that never comes with nothing on the wire ends the link", async () => {
  let clock = 1_000_000;
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket, () => clock);
  await transport.connect();
  let dropped = false;
  transport.ondrop = () => { dropped = true; };
  const stall = transport as unknown as { checkStall(): void };

  // Nothing outstanding is not evidence of anything: a quiet link is normal.
  clock += 600_000;
  stall.checkStall();
  expect(dropped).toBe(false);

  const answer = transport.rpc({ v: 1, id: requestId, method: "GET", path: "/v1/snapshot" });
  clock += 29_000;
  stall.checkStall();
  expect(dropped).toBe(false);
  // Anything at all from the host is proof the link carries bytes.
  relay.event({ type: "event", event_instance_id: "a".repeat(32), seq: 1, payload: { event: "bot.upsert" } });
  clock += 29_000;
  stall.checkStall();
  expect(dropped).toBe(false);

  clock += 31_000;
  stall.checkStall();
  expect(dropped).toBe(true);
  await expect(answer).rejects.toMatchObject({ code: "request_unknown", requestId });
});

/** An upload takes minutes on a phone's uplink, and the host says nothing until it lands. */
test("bytes still leaving the send buffer are not silence", async () => {
  let clock = 1_000_000;
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket, () => clock);
  await transport.connect();
  let dropped = false;
  transport.ondrop = () => { dropped = true; };
  const stall = transport as unknown as { checkStall(): void };
  void transport.rpc({ v: 1, id: requestId, method: "GET", path: "/v1/snapshot" }).catch(() => undefined);
  for (let sent = 0; sent < 5; sent++) {
    relay.socket.bufferedAmount = 1_000_000 - sent * 100_000;
    clock += 31_000;
    stall.checkStall();
  }
  expect(dropped).toBe(false);
  // The buffer stops moving: nothing is leaving either.
  clock += 31_000;
  stall.checkStall();
  clock += 31_000;
  stall.checkStall();
  expect(dropped).toBe(true);
});

/**
 * The relay gives one device one route and refuses a second while the first is there. A handshake
 * that gives up holding its socket open would refuse every retry after it — the page would look
 * like it was trying and never get back in.
 */
test("a handshake that never becomes a link lets go of the socket", async () => {
  const relay = fakeHost({ mode: "control" });
  const transport = transportFor(relay.socket);
  await expect(transport.connect()).rejects.toThrow();
  expect(relay.socket.closedByPage).toBe(true);
});

/** A note is one frame. It comes back inside the response, and the preview does not wait for another. */
test("a file carried on the response is the blob", async () => {
  const bytes = new TextEncoder().encode("hello");
  const relay = fakeHost({
    answer: (request) => ({
      v: 1, id: request.id, status: 200, body: null,
      headers: { contentType: "text/plain", etag: `"${sha256Hex(bytes)}"` },
      file: { streamId: 0, size: bytes.length, bytes: base64url(bytes) },
    }),
  });
  const transport = transportFor(relay.socket);
  await transport.connect();
  const seen: Array<{ loaded: number; total: number | null }> = [];
  const response = await transport.rpc(
    { v: 1, id: requestId, method: "GET", path: "/v1/workspace/file", query: { path: "a.txt" } },
    undefined,
    (progress) => seen.push(progress),
  );
  expect(await (response.body as Blob).text()).toBe("hello");
  expect(seen).toEqual([{ loaded: 5, total: 5 }]);
  // The link stays up: the next request is answered, rather than the page reconnecting.
  const again = await transport.rpc({ v: 1, id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ", method: "GET", path: "/v1/workspace/file" });
  expect(await (again.body as Blob).text()).toBe("hello");
});

/** Bytes that are not the file they claim to be never become a preview, and a lie about the length drops the link. */
test("inline file bytes are checked before they become a blob", async () => {
  const bytes = new TextEncoder().encode("hello");
  const wrongHash = fakeHost({
    answer: (request) => ({
      v: 1, id: request.id, status: 200, body: null,
      headers: { etag: `"${"ab".repeat(32)}"` },
      file: { streamId: 0, size: bytes.length, bytes: base64url(bytes) },
    }),
  });
  const hashed = transportFor(wrongHash.socket);
  await hashed.connect();
  await expect(hashed.rpc({ v: 1, id: requestId, method: "GET", path: "/v1/workspace/file" }))
    .rejects.toMatchObject({ status: 422, code: "invalid_args" });

  const wrongLength = fakeHost({
    answer: (request) => ({
      v: 1, id: request.id, status: 200, body: null,
      file: { streamId: 0, size: 4, bytes: base64url(bytes) },
    }),
  });
  const sized = transportFor(wrongLength.socket);
  await sized.connect();
  let dropped = false;
  sized.ondrop = () => { dropped = true; };
  await expect(sized.rpc({ v: 1, id: requestId, method: "GET", path: "/v1/workspace/file" }))
    .rejects.toMatchObject({ code: "request_unknown" });
  expect(dropped).toBe(true);
});

/** The handshake's reader queues whatever nobody is waiting for, and nobody ever is again. */
test("the handshake reader lets go once the session is live", async () => {
  const relay = fakeHost();
  const transport = transportFor(relay.socket);
  await transport.connect();
  expect(relay.socket.listenerCount("message")).toBe(0);
  transport.close();
});
