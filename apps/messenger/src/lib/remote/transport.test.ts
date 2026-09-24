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

const uploadId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

/** A file of `size` bytes, the POST that declares it, and the Mac's answer opening its stream. */
function upload(size: number) {
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  const file = { filename: "clip.mp4", size, sha256: sha256Hex(bytes), bytes };
  const declared = { filename: file.filename, size, sha256: file.sha256 };
  const request = {
    v: 1, id: uploadId, method: "POST", path: "/v1/sessions/filedrop/messages", body: { body: "", files: [declared] },
  } as const;
  const opened = { v: 1, id: uploadId, status: 202, body: { state: "upload_open" }, upload: { files: [{ ...declared, streamId: 1 }] } };
  return { file, request, opened };
}

/** A transport on a clock the test owns: an upload's waits move it rather than taking real time. */
function pacedTransport(relay: ReturnType<typeof fakeHost>, clock: { now: number }, onSleep?: () => void) {
  return new RemoteTransport(enrollment, deviceKeys, {
    socketFactory: () => relay.socket as unknown as WebSocket,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      onSleep?.();
      await Bun.sleep(0);
    },
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 20_000 && !check(); i++) await Bun.sleep(0);
}

/**
 * The regression behind a phone that reconnected the moment it sent a file: the whole file went
 * into the socket at once, the relay's meter ran past its 256 KiB burst, and the relay closed the
 * route mid-upload. The Mac takes 1.5 of the relay's 2.5 MB/s; the device keeps inside the rest.
 */
test("an upload leaves no faster than the device's share of the relay's meter", async () => {
  const clock = { now: 1_000_000 };
  const size = 2 * 1024 * 1024;
  const { file, request, opened } = upload(size);
  const relay = fakeHost({ clock: () => clock.now, answer: (asked) => (asked.id === uploadId ? opened : null) });
  const transport = pacedTransport(relay, clock);
  await transport.connect();
  const start = clock.now;
  const progress: Array<{ loaded: number; total: number | null }> = [];
  const answer = transport.rpc(request, [file], (seen) => progress.push({ ...seen }));
  await until(() => relay.chunks.at(-1)?.eof === true);

  expect(relay.chunks.reduce((n, chunk) => n + chunk.size, 0)).toBe(size);
  // What the composer draws its ring from: from nothing to all of it, never backwards.
  expect(progress[0]).toEqual({ loaded: 0, total: size });
  expect(progress.at(-1)).toEqual({ loaded: size, total: size });
  expect(progress.every((row, i) => i === 0 || row.loaded > progress[i - 1]!.loaded)).toBe(true);
  // The relay's meter, as the device sees it: a full burst to start with, refilled at what the
  // Mac leaves over. Each chunk costs its bytes plus the frame around them.
  let tokens = 256 * 1024;
  let last = start;
  for (const chunk of relay.chunks) {
    tokens = Math.min(256 * 1024, tokens + (chunk.at - last) * 1000);
    last = chunk.at;
    tokens -= chunk.size + 54;
    expect(tokens).toBeGreaterThanOrEqual(0);
  }
  // And not slower than it needs to be.
  expect(clock.now - start).toBeLessThan(size / 850);

  relay.respond({ v: 1, id: uploadId, status: 201, body: { id: "msg" } });
  expect(await answer).toMatchObject({ status: 201, body: { id: "msg" } });
});

/** A paced 30 MB upload outlasts the stall window with nothing coming back from the Mac. */
test("an upload still being paced out is not silence", async () => {
  const clock = { now: 1_000_000 };
  const { file, request, opened } = upload(30 * 1024 * 1024);
  const relay = fakeHost({ answer: (asked) => (asked.id === uploadId ? opened : null) });
  let dropped = false;
  let checked = clock.now;
  const transport = pacedTransport(relay, clock, () => {
    // The page's own interval, on the test's clock. The buffer drains between chunks, so it
    // reads 0 at every look, as it does on a radio faster than the pace.
    if (clock.now - checked < 5000) return;
    checked = clock.now;
    (transport as unknown as { checkStall(): void }).checkStall();
  });
  await transport.connect();
  transport.ondrop = () => { dropped = true; };
  void transport.rpc(request, [file]).catch(() => undefined);
  await until(() => dropped || relay.chunks.at(-1)?.eof === true);
  expect(clock.now - 1_000_000).toBeGreaterThan(30_000);
  expect(dropped).toBe(false);
  expect(relay.chunks.at(-1)?.eof).toBe(true);
});

test("an upload waits for the browser to hand on what it already holds", async () => {
  const clock = { now: 1_000_000 };
  const { file, request, opened } = upload(256 * 1024);
  const relay = fakeHost({ answer: (asked) => (asked.id === uploadId ? opened : null) });
  const transport = pacedTransport(relay, clock);
  await transport.connect();
  relay.socket.bufferedAmount = 300 * 1024;
  void transport.rpc(request, [file]).catch(() => undefined);
  await until(() => clock.now > 1_000_000 + 1000);
  expect(relay.chunks).toHaveLength(0);
  relay.socket.bufferedAmount = 0;
  await until(() => relay.chunks.at(-1)?.eof === true);
  expect(relay.chunks.at(-1)?.eof).toBe(true);
});

test("a link that drops mid-upload stops sending and leaves the result unknown", async () => {
  const clock = { now: 1_000_000 };
  const { file, request, opened } = upload(1024 * 1024);
  const relay = fakeHost({ answer: (asked) => (asked.id === uploadId ? opened : null) });
  const transport = pacedTransport(relay, clock);
  await transport.connect();
  const answer = transport.rpc(request, [file]);
  await until(() => relay.chunks.length >= 3);
  relay.socket.drop();
  const sent = relay.chunks.length;
  await expect(answer).rejects.toMatchObject({ code: "request_unknown", requestId: uploadId });
  for (let i = 0; i < 50; i++) await Bun.sleep(0);
  expect(relay.chunks.length).toBe(sent);
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

const picture = (id: string) => ({ v: 1 as const, id, method: "GET" as const, path: `/v1/attachments/${id}/content` });
const inline = (id: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { v: 1 as const, id, status: 200, body: null, file: { streamId: 0, size: bytes.length, bytes: base64url(bytes) } };
};
const streamed = (id: string, streamId: number, size: number) =>
  ({ v: 1 as const, id, status: 200, body: null, headers: { contentType: "image/png" }, file: { streamId, size } });
const bg1 = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const bg2 = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const note = "01ARZ3NDEKTSV4RRFFQ69G5FB3";

/**
 * The regression. A chat's pictures are whole originals and every one of them was asked for
 * ahead of the note someone then tapped, on a link that answers one request at a time: the
 * preview sat at 0 B while tens of megabytes of screenshots went first.
 */
test("a file someone opens goes ahead of the chat's pictures", async () => {
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket);
  await transport.connect();
  const first = transport.rpc(picture(bg1), undefined, undefined, { background: true });
  const second = transport.rpc(picture(bg2), undefined, undefined, { background: true });
  const opened = transport.rpc(picture(note), undefined, undefined, { preempt: true });
  expect(relay.requests.map((row) => row.id)).toEqual([bg1]);

  // The picture already asked for rides inside its answer: nothing to stop, it just lands.
  relay.respond(inline(bg1, "one"));
  expect(relay.cancels).toEqual([]);
  expect(relay.requests.map((row) => row.id)).toEqual([bg1, note]);
  relay.respond(inline(note, "note"));
  expect(await ((await opened).body as Blob).text()).toBe("note");
  expect(relay.requests.map((row) => row.id)).toEqual([bg1, note, bg2]);
  relay.respond(inline(bg2, "two"));
  expect(await ((await first).body as Blob).text()).toBe("one");
  expect(await ((await second).body as Blob).text()).toBe("two");
});

/** A 4 MB contact sheet halfway down is still seconds of someone looking at a spinner. */
test("a background download in the way stops and goes back to the head of its line", async () => {
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket);
  await transport.connect();
  let dropped = false;
  transport.ondrop = () => { dropped = true; };
  const sheet = transport.rpc(picture(bg1), undefined, undefined, { background: true });
  const other = transport.rpc(picture(bg2), undefined, undefined, { background: true });
  relay.respond(streamed(bg1, 7, 6));
  relay.chunk(7, 0, new Uint8Array([1, 2]), false);

  const opened = transport.rpc(picture(note), undefined, undefined, { preempt: true });
  expect(relay.cancels).toEqual([7]);
  // A chunk the host sent before it heard the cancel still lines up rather than ending the link.
  relay.chunk(7, 2, new Uint8Array([3, 4]), false);
  expect(relay.requests.map((row) => row.id)).toEqual([bg1]);
  relay.streamEnded(7);
  expect(relay.requests.map((row) => row.id)).toEqual([bg1, note]);
  relay.respond(inline(note, "note"));
  expect(await ((await opened).body as Blob).text()).toBe("note");

  // Asked for again, whole and with the same id, before the picture behind it.
  expect(relay.requests.map((row) => row.id)).toEqual([bg1, note, bg1]);
  relay.respond(streamed(bg1, 8, 3));
  relay.chunk(8, 0, new Uint8Array([9, 9, 9]), true);
  expect(new Uint8Array(await ((await sheet).body as Blob).arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  relay.respond(inline(bg2, "two"));
  expect(await ((await other).body as Blob).text()).toBe("two");
  expect(dropped).toBe(false);
});

/** Only a file somebody opened stops a picture: an ordinary request waits its turn in front of them. */
test("an ordinary request jumps the pictures without stopping one", async () => {
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket);
  await transport.connect();
  void transport.rpc(picture(bg1), undefined, undefined, { background: true });
  void transport.rpc(picture(bg2), undefined, undefined, { background: true });
  relay.respond(streamed(bg1, 7, 4));
  const read = transport.rpc({ v: 1, id: note, method: "POST", path: "/v1/sessions/s/read", body: {} });
  expect(relay.cancels).toEqual([]);
  relay.chunk(7, 0, new Uint8Array(4), true);
  expect(relay.requests.map((row) => row.id)).toEqual([bg1, note]);
  relay.respond({ v: 1, id: note, status: 204, body: null });
  expect((await read).status).toBe(204);
  expect(relay.requests.map((row) => row.id)).toEqual([bg1, note, bg2]);
});

/** A chat left behind stops asking for its pictures; a preview closed stops its file. */
test("a read nobody is waiting for leaves the line, or stops on the wire", async () => {
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket);
  await transport.connect();
  const leaving = new AbortController();
  const first = transport.rpc(picture(bg1), undefined, undefined, { background: true, signal: leaving.signal });
  const second = transport.rpc(picture(bg2), undefined, undefined, { background: true, signal: leaving.signal });
  leaving.abort();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  // Not named yet: small enough to ride in its answer, it simply lands.
  relay.respond(inline(bg1, "one"));
  expect(await ((await first).body as Blob).text()).toBe("one");
  expect(relay.requests.map((row) => row.id)).toEqual([bg1]);

  const closing = new AbortController();
  const opened = transport.rpc(picture(note), undefined, undefined, { preempt: true, signal: closing.signal });
  closing.abort();
  expect(relay.cancels).toEqual([]);
  // A stream named after the abort is stopped the moment it is named.
  relay.respond(streamed(note, 9, 100));
  expect(relay.cancels).toEqual([9]);
  relay.streamEnded(9);
  await expect(opened).rejects.toMatchObject({ name: "AbortError" });

  const already = new AbortController();
  already.abort();
  await expect(transport.rpc(picture(bg2), undefined, undefined, { signal: already.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(relay.requests.map((row) => row.id)).toEqual([bg1, note]);
});

/** A drop used to forget the line without a word, and each picture in it span forever. */
test("a link that ends answers everything still in line", async () => {
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket);
  await transport.connect();
  const inFlight = transport.rpc(picture(bg1), undefined, undefined, { background: true });
  const queuedPicture = transport.rpc(picture(bg2), undefined, undefined, { background: true });
  const queuedNote = transport.rpc(picture(note));
  relay.socket.drop();
  await expect(inFlight).rejects.toMatchObject({ code: "request_unknown", requestId: bg1 });
  await expect(queuedPicture).rejects.toMatchObject({ code: "request_unknown", requestId: bg2 });
  await expect(queuedNote).rejects.toMatchObject({ code: "request_unknown", requestId: note });
});

/** Once a device asks, the Mac deflates its JSON answers; they read exactly as before. */
test("an answer the Mac deflated is read like any other", async () => {
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket);
  await transport.connect();
  const answer = transport.rpc({ v: 1, id: requestId, method: "GET", path: "/v1/bots" });
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `bot-${i}`, name: "the same name" }));
  relay.respondPacked({ v: 1, id: requestId, status: 200, body: { items } });
  expect(((await answer).body as { items: unknown[] }).items).toEqual(items);
});

test("streamed partial media responses preserve 206, MIME and Content-Range", async () => {
  const relay = fakeHost({ answer: () => null });
  const transport = transportFor(relay.socket);
  await transport.connect();
  try {
    const pending = transport.rpc(picture(note));
    const bytes = new TextEncoder().encode("part");
    relay.respond({ v: 1, id: note, status: 206, body: null,
      headers: { contentType: "video/mp4", contentRange: "bytes 10-13/100", etag: `"${sha256Hex(bytes)}"` },
      file: { streamId: 7, size: 4 } });
    relay.chunk(7, 0, bytes, true);
    const response = await pending;
    expect(response.status).toBe(206);
    expect(response.headers?.contentRange).toBe("bytes 10-13/100");
    expect((response.body as Blob).type).toBe("video/mp4");
    expect(await (response.body as Blob).text()).toBe("part");
  } finally { transport.close(); }
});
