import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_DROP_SESSION_ID } from "@real-bot/protocol";
import { noisePng } from "./test-images";
import { warmDisplayAvatar } from "./avatar-display";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const start = (opts: Parameters<typeof startLocalApi>[0] = {}) => startLocalApi(opts);

describe("empty roster and settings", () => {
  test("workspace paths ride on a message as they are: no copy, nothing in inbox", async () => {
    const h = await start();
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-ref-ws-")));
    mkdirSync(join(ws, "docs"));
    mkdirSync(join(ws, "shots"));
    writeFileSync(join(ws, "docs", "brief.md"), "# brief");
    writeFileSync(join(ws, "shots", "a.png"), noisePng(4, 4));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const { direct_session: session } = h.store.createBot({ name: "Reader", duties: "read", boundaries: "stay" });
    const post = (body: BodyInit, json = true) => fetch(`${h.origin}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: auth(h, json ? { "Content-Type": "application/json" } : {}),
      body,
    });
    type Posted = { attachments: Array<{ workspace_relpath: string; original_filename: string; exists: boolean; is_dir: boolean }> };

    const posted = await post(JSON.stringify({ body: "看看这两个", paths: ["docs/brief.md", "./shots/a.png", "docs/brief.md", "shots"] }));
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as Posted;
    expect(message.attachments.map((row) => [row.workspace_relpath, row.original_filename, row.exists, row.is_dir])).toEqual([
      ["docs/brief.md", "brief.md", true, false],
      ["shots/a.png", "a.png", true, false],
      ["shots", "shots", true, true],
    ]);
    expect(existsSync(join(ws, "inbox"))).toBe(false);

    // Beside uploaded files, multipart carries the list as one JSON field.
    const form = new FormData();
    form.append("body", "");
    form.append("files", new File([new Uint8Array([1, 2])], "note.txt", { type: "text/plain" }));
    form.append("paths", JSON.stringify(["docs/brief.md"]));
    const mixed = await post(form, false);
    expect(mixed.status).toBe(201);
    const both = (await mixed.json()) as Posted;
    expect(both.attachments.map((row) => row.workspace_relpath)).toEqual([expect.stringMatching(/^inbox\//), "docs/brief.md"]);

    const before = h.store.listMessages(session.id).items.length;
    for (const paths of [["../outside.txt"], ["/etc/hosts"], ["."], [""], "docs/brief.md", [3]]) {
      expect((await post(JSON.stringify({ body: "x", paths }))).status).toBe(422);
    }
    expect(h.store.listMessages(session.id).items.length).toBe(before);
    const dropped = await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "", paths: ["docs/brief.md"] }),
    });
    expect(dropped.status).toBe(422);
  });

  test("workspace paths need a workspace to point into", async () => {
    const h = await start();
    const { direct_session: session } = h.store.createBot({ name: "Reader", duties: "read", boundaries: "stay" });
    const posted = await fetch(`${h.origin}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "x", paths: ["docs/brief.md"] }),
    });
    expect(posted.status).toBe(422);
    expect(h.store.listMessages(session.id).items).toEqual([]);
  });

  test("posting multipart/form-data with attachments saves to inbox and serves content", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-att-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });

    const botRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "AttBot", duties: "d", boundaries: "b" }),
    });
    const { direct_session } = (await botRes.json()) as { direct_session: { id: string } };

    const form = new FormData();
    form.append("body", "here is an image");
    const testFile = new File([new Uint8Array([1, 2, 3, 4])], "test-image.png", { type: "image/png" });
    form.append("files", testFile);

    const postRes = await fetch(`${h.origin}/v1/sessions/${direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: form,
    });
    expect(postRes.status).toBe(201);
    const msg = (await postRes.json()) as {
      id: string;
      body: string;
      attachments: Array<{ id: string; original_filename: string; workspace_relpath: string }>;
    };
    expect(msg.body).toBe("here is an image");
    expect(msg.attachments.length).toBe(1);
    expect(msg.attachments[0]!.original_filename).toBe("test-image.png");
    expect(msg.attachments[0]!.workspace_relpath).toStartWith("inbox/");

    // Test GET /v1/attachments/:id
    const attRes = await fetch(`${h.origin}/v1/attachments/${msg.attachments[0]!.id}`, {
      headers: auth(h),
    });
    expect(attRes.status).toBe(200);
    const attMeta = (await attRes.json()) as { id: string; original_filename: string };
    expect(attMeta.original_filename).toBe("test-image.png");

    // Test GET /v1/attachments/:id/content
    const contentRes = await fetch(`${h.origin}/v1/attachments/${msg.attachments[0]!.id}/content`, {
      headers: auth(h),
    });
    expect(contentRes.status).toBe(200);
    const buf = await contentRes.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));

    rmSync(ws, { recursive: true, force: true });
  });

  test("bot-cited workspace files serve content and search hits", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-cite-ws-"));
    mkdirSync(join(ws, "out"));
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "out", "mock.png"), new Uint8Array([9, 8, 7]));
    writeFileSync(join(ws, "report.md"), "# report\n");
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const botRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "CiteBot", duties: "d", boundaries: "b" }),
    });
    const { bot, direct_session } = (await botRes.json()) as {
      bot: { id: string };
      direct_session: { id: string };
    };
    const message = h.store.insertMessage({
      sessionId: direct_session.id,
      kind: "bot",
      author: bot.id,
      body: "稿在 [mock](out/mock.png)",
      paths: ["out/mock.png", "src"],
    });
    expect(message.attachments[0]?.workspace_relpath).toBe("out/mock.png");
    expect(message.attachments[0]?.exists).toBe(true);
    expect(message.attachments[1]?.is_dir).toBe(true);

    const contentRes = await fetch(`${h.origin}/v1/attachments/${message.attachments[0]!.id}/content`, {
      headers: auth(h),
    });
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await contentRes.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));

    const dirAtt = message.attachments[1]!;
    const dirRes = await fetch(`${h.origin}/v1/attachments/${dirAtt.id}/content`, { headers: auth(h) });
    expect(dirRes.status).toBe(422);

    const missing = h.store.insertMessage({
      sessionId: direct_session.id,
      kind: "bot",
      author: bot.id,
      body: "gone",
      paths: ["out/gone.png"],
    });
    const missingRes = await fetch(`${h.origin}/v1/attachments/${missing.attachments[0]!.id}/content`, {
      headers: auth(h),
    });
    expect(missingRes.status).toBe(404);

    const searchRes = await fetch(`${h.origin}/v1/search?q=${encodeURIComponent("report.md")}`, {
      headers: auth(h),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { items: Array<{ kind: string; path?: string }> };
    expect(searchBody.items.some((hit) => hit.kind === "file" && hit.path === "report.md")).toBe(true);

    rmSync(ws, { recursive: true, force: true });
  });
});

describe("picture variants", () => {
  const etagOf = (bytes: Uint8Array) =>
    `"${(require("node:crypto") as typeof import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}"`;

  test.skipIf(process.platform !== "darwin")("size asks for a scaled copy and says what the original weighs", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-variant-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const picture = noisePng(1200, 800);
    writeFileSync(join(ws, "frame.png"), picture);
    writeFileSync(join(ws, "notes.md"), "# notes\n");
    const file = (query: string) => fetch(`${h.origin}/v1/workspace/file?${query}`, { headers: auth(h) });

    const thumb = await file("path=frame.png&size=thumb");
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Content-Type")).toBe("image/jpeg");
    expect(thumb.headers.get("X-Original-Size")).toBe(String(picture.byteLength));
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(picture.byteLength / 10);
    // The ETag is the bytes sent, which is what a remote client checks them against.
    expect(thumb.headers.get("ETag")).toBe(etagOf(bytes));

    const original = await file("path=frame.png");
    expect(original.headers.get("X-Original-Size")).toBeNull();
    expect((await original.arrayBuffer()).byteLength).toBe(picture.byteLength);
    // Not a picture: the original, and nothing says otherwise.
    const note = await file("path=notes.md&size=preview");
    expect(note.headers.get("X-Original-Size")).toBeNull();
    expect(await note.text()).toBe("# notes\n");
    expect((await file("path=frame.png&size=full")).status).toBe(422);

    const botRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "PicBot", duties: "d", boundaries: "b" }),
    });
    const { direct_session } = (await botRes.json()) as { direct_session: { id: string } };
    const form = new FormData();
    form.append("body", "a keyframe");
    form.append("files", new File([picture], "frame.png", { type: "image/png" }));
    const posted = (await (await fetch(`${h.origin}/v1/sessions/${direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: form,
    })).json()) as { attachments: Array<{ id: string }> };
    const content = (size: string) => fetch(`${h.origin}/v1/attachments/${posted.attachments[0]!.id}/content?size=${size}`, { headers: auth(h) });
    const chip = await content("thumb");
    expect(chip.status).toBe(200);
    expect(chip.headers.get("Content-Type")).toBe("image/jpeg");
    expect(chip.headers.get("X-Original-Size")).toBe(String(picture.byteLength));
    // 1200 px is already within an enlargement's 1600: the original goes, unmarked.
    const enlarged = await content("preview");
    expect(enlarged.headers.get("Content-Type")).toBe("image/png");
    expect(enlarged.headers.get("X-Original-Size")).toBeNull();
    expect((await enlarged.arrayBuffer()).byteLength).toBe(picture.byteLength);
    expect((await fetch(`${h.origin}/v1/attachments/${posted.attachments[0]!.id}/content?size=full`, { headers: auth(h) })).status).toBe(422);
    rmSync(ws, { recursive: true, force: true });
  });
});

/**
 * A profile save sends back the portrait it was shown with every other edit. That is the small
 * copy clients are sent; saving it would have replaced the original with a thumbnail.
 */
test.skipIf(process.platform !== "darwin")("a profile save that sends back the shown portrait keeps the original", async () => {
  const h = await start();
  const original = `data:image/png;base64,${noisePng(256, 256).toString("base64")}`;
  const { bot } = h.store.createBot({ name: "Painter", duties: "d", boundaries: "b", avatar: original });
  await warmDisplayAvatar(original);
  const snapshot = await (await fetch(`${h.origin}/v1/snapshot`, { headers: auth(h) })).json() as { bots: Array<{ id: string; avatar: string }> };
  const shown = snapshot.bots.find((row) => row.id === bot.id)!.avatar;
  expect(shown).toMatch(/;rb-display=/);
  expect(shown.length).toBeLessThan(original.length / 4);

  const patch = (body: Record<string, unknown>) => fetch(`${h.origin}/v1/bots/${bot.id}`, {
    method: "PATCH",
    headers: auth(h, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const saved = await patch({ duties: "paints", avatar: shown });
  expect(saved.status).toBe(200);
  expect(h.store.getBot(bot.id).avatar).toBe(original);
  expect(h.store.getBot(bot.id).duties).toBe("paints");
  // A picture chosen in the editor is a new portrait and is stored.
  const chosen = "data:image/svg+xml;base64,PHN2Zy8+";
  expect((await patch({ avatar: chosen })).status).toBe(200);
  expect(h.store.getBot(bot.id).avatar).toBe(chosen);
});

test("media file GETs serve ranges through workspace and attachment paths", async () => {
  const h = await start();
  const dir = mkdtempSync(join(tmpdir(), "rb-media-api-"));
  try {
    await h.store.patchSettings({ workspace_path: dir });
    writeFileSync(join(dir, "clip.mp4"), "0123456789");
    const ask = (query: string, range?: string) => fetch(`${h.origin}/v1/workspace/file?path=clip.mp4${query}`, { headers: auth(h, range ? { Range: range } : {}) });
    for (const response of [await ask("", "bytes=2-5"), await ask("&range=bytes%3D2-5")]) {
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(await response.text()).toBe("2345");
    }
    expect((await ask("&size=preview&range=bytes%3D0-1")).status).toBe(422);
    expect((await ask("", "bytes=100-")).status).toBe(416);
    expect((await fetch(`${h.origin}/v1/workspace/file?path=..%2Foutside.mp4&range=bytes%3D0-1`, { headers: auth(h) })).status).toBe(422);
    expect((await fetch(`${h.origin}/v1/workspace/file?path=.&range=bytes%3D0-1`, { headers: auth(h) })).status).toBe(422);
    const form = new FormData();
    form.append("files", new File(["abcdefghij"], "audio.mp3", { type: "audio/mpeg" }));
    const uploaded = await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}/messages`, { method: "POST", headers: auth(h), body: form });
    expect(uploaded.status).toBe(201);
    const message = await uploaded.json() as { attachments: Array<{ id: string }> };
    const audio = await fetch(`${h.origin}/v1/attachments/${message.attachments[0]!.id}/content?range=bytes%3D-3`, { headers: auth(h) });
    expect(audio.status).toBe(206);
    expect(await audio.text()).toBe("hij");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
