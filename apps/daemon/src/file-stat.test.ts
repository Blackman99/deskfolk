import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { fileEtag } from "./file-integrity";
import { fileStat, forgetFileStats, SETTLING_BYTES, SETTLING_MS } from "./file-stat";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const dirs: string[] = [];
function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-stat-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  forgetFileStats();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function statusOf(run: () => unknown): number | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.status : -1;
  }
}

test("fileStat names the file GET's hash, its size and when it changed", () => {
  const dir = tmp();
  const file = join(dir, "notes.md");
  writeFileSync(file, "# one\n");
  const first = fileStat(file);
  expect(first.etag).toBe(fileEtag(Buffer.from("# one\n")));
  expect(first.size).toBe(6);
  expect(Number.isNaN(Date.parse(first.modified_at))).toBe(false);
  // Asked again with nothing changed: the same answer.
  expect(fileStat(file)).toEqual(first);
  // The same length, a second later: a new hash.
  writeFileSync(file, "# two\n");
  utimesSync(file, new Date(), new Date(Date.now() + 1000));
  expect(fileStat(file).etag).toBe(fileEtag(Buffer.from("# two\n")));
});

test("fileStat reads a large file a piece at a time to the same hash", () => {
  const dir = tmp();
  const file = join(dir, "clip.bin");
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 17, 3);
  bytes[bytes.length - 1] = 9;
  writeFileSync(file, bytes);
  // Asked once it has been quiet a moment: a large file just written is still settling.
  expect(fileStat(file, Date.now() + SETTLING_MS + 1).etag).toBe(fileEtag(bytes));
});

test("a large file still being written is not hashed until it has been quiet a moment", () => {
  const dir = tmp();
  const file = join(dir, "export.mov");
  const bytes = Buffer.alloc(SETTLING_BYTES + 1, 5);
  writeFileSync(file, bytes);
  const written = Date.now();
  utimesSync(file, new Date(written), new Date(written));
  const statusAt = (now: number) => {
    try {
      fileStat(file, now);
      return 200;
    } catch (error) {
      return error instanceof HttpError ? `${error.status}:${error.code}` : -1;
    }
  };
  expect(statusAt(written + 100)).toBe("409:file_changing");
  // Quiet long enough: hashed once, and kept from then on.
  expect(fileStat(file, written + SETTLING_MS + 1).etag).toBe(fileEtag(bytes));
  expect(fileStat(file, written + 100).etag).toBe(fileEtag(bytes));
  // A small file is hashed at once, however fresh.
  const note = join(dir, "log.txt");
  writeFileSync(note, "one\n");
  expect(fileStat(note).etag).toBe(fileEtag(Buffer.from("one\n")));
});

test("fileStat: a missing file is 404, a folder 422", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"));
  expect(statusOf(() => fileStat(join(dir, "gone.md")))).toBe(404);
  expect(statusOf(() => fileStat(join(dir, "src")))).toBe(422);
});

test("the stat routes answer for a workspace file, one elsewhere and an attachment, as the file GETs read them", async () => {
  const h = await startLocalApi();
  const ws = tmp();
  const elsewhere = tmp();
  mkdirSync(join(ws, "docs"));
  writeFileSync(join(ws, "docs", "brief.md"), "# brief\n");
  writeFileSync(join(elsewhere, "far.md"), "far\n");
  await fetch(`${h.origin}/v1/settings`, {
    method: "PATCH",
    headers: auth(h, { "Content-Type": "application/json" }),
    body: JSON.stringify({ workspace_path: ws }),
  });
  const stat = async (route: string) => {
    const res = await fetch(`${h.origin}${route}`, { headers: auth(h) });
    return { status: res.status, body: (await res.json()) as { etag?: string; size?: number } };
  };
  const etagOf = async (route: string) => (await fetch(`${h.origin}${route}`, { headers: auth(h) })).headers.get("ETag");

  const brief = await stat("/v1/workspace/stat?path=docs%2Fbrief.md");
  expect(brief.status).toBe(200);
  expect(brief.body.etag).toBe((await etagOf("/v1/workspace/file?path=docs%2Fbrief.md"))!);
  expect(brief.body.size).toBe(8);
  const far = await stat(`/v1/workspace/stat?path=${encodeURIComponent(join(elsewhere, "far.md"))}`);
  expect(far.body.etag).toBe(fileEtag(Buffer.from("far\n")));
  expect((await stat("/v1/workspace/stat?path=docs%2Fgone.md")).status).toBe(404);
  expect((await stat("/v1/workspace/stat?path=docs")).status).toBe(422);
  expect((await stat("/v1/workspace/stat?path=..%2Fx")).status).toBe(422);

  const { direct_session: session } = h.store.createBot({ name: "Reader", duties: "read", boundaries: "stay" });
  const posted = await fetch(`${h.origin}/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: auth(h, { "Content-Type": "application/json" }),
    body: JSON.stringify({ body: "看看", paths: ["docs/brief.md", "docs"] }),
  });
  const message = (await posted.json()) as { attachments: Array<{ id: string; is_dir: boolean }> };
  const file = message.attachments.find((row) => !row.is_dir)!;
  const folder = message.attachments.find((row) => row.is_dir)!;
  // An attachment is the workspace file where it lies: it changes with it.
  expect((await stat(`/v1/attachments/${file.id}/stat`)).body.etag).toBe(brief.body.etag!);
  writeFileSync(join(ws, "docs", "brief.md"), "# brief, again\n");
  const after = await stat(`/v1/attachments/${file.id}/stat`);
  expect(after.body.etag).toBe((await etagOf(`/v1/attachments/${file.id}/content`))!);
  expect(after.body.etag).not.toBe(brief.body.etag!);
  expect((await stat(`/v1/attachments/${folder.id}/stat`)).status).toBe(422);
});
