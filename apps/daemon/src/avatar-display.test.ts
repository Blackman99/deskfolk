import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayAvatar, isDisplayAvatar, warmDisplayAvatar, withoutDisplayMark } from "./avatar-display";
import { EventStream } from "./session-events";
import { noisePng } from "./test-images";

const onMac = process.platform === "darwin";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-avatar-test-"));
  dirs.push(dir);
  return dir;
};
const portrait = () => `data:image/png;base64,${noisePng(256, 256).toString("base64")}`;

test("a small or vector portrait goes as it is", async () => {
  const svg = "data:image/svg+xml;base64,PHN2Zy8+";
  expect(displayAvatar(null)).toBeNull();
  expect(displayAvatar(svg)).toBe(svg);
  expect(await warmDisplayAvatar(svg)).toBe(svg);
});

test.skipIf(!onMac)("a stored portrait goes out as a small copy marked as one", async () => {
  const original = portrait();
  const shown = await warmDisplayAvatar(original, { cacheDir: scratch() });
  expect(shown).not.toBe(original);
  expect(shown!.length).toBeLessThan(original.length / 4);
  expect(shown).toMatch(/^data:image\/jpeg;rb-display=[0-9a-f]{16};base64,/);
  expect(isDisplayAvatar(shown!)).toBe(true);
  expect(isDisplayAvatar(original)).toBe(false);
  expect(withoutDisplayMark(shown!)).toMatch(/^data:image\/jpeg;base64,/);
  // From then on the synchronous path the snapshot uses has it too.
  expect(displayAvatar(original)).toBe(shown);
});

test.skipIf(!onMac)("every sequenced bot.upsert carries the small copy", async () => {
  const original = portrait();
  const shown = await warmDisplayAvatar(original, { cacheDir: scratch() });
  const events = new EventStream();
  const sent: unknown[] = [];
  events.subscribe((frame) => sent.push(frame));
  events.publish({
    event: "bot.upsert", occurred_at: "now", id: "bot-1", name: "B", duties: "", boundaries: "", avatar: original,
    model: null, provider_id: null, thinking_level: null, archived_at: null, created_at: "now", updated_at: "now", deleted_at: null,
  } as never);
  expect((sent[0] as { payload: { avatar: string } }).payload.avatar).toBe(shown!);
  const caught = events.catchup({ event_instance_id: events.cursor().event_instance_id, watermark_seq: 0 });
  expect((caught.events[0]!.payload as { avatar: string }).avatar).toBe(shown!);
});
