import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceImage } from "./image-variant";

/**
 * Bot portraits are stored as data URIs of whatever was uploaded — 16–32 KB each on a real
 * roster — and every snapshot and `bot.upsert` carried them whole. What goes out is a 128 px copy
 * instead, marked `;rb-display=<hash>` so it can never be mistaken for a new upload: a profile
 * save sends the portrait it was shown back with every edit, and that copy must not replace the
 * original. The mark is a media-type parameter, which browsers ignore when they decode the image.
 */
const MARK = "rb-display";
const MARKED = new RegExp(`^data:[^,;]+(?:;[^,;]*)*;${MARK}=[0-9a-f]{16}(?:;|,)`);
const RASTER = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
/** Below this a portrait already costs less than a conversion is worth. */
const SMALL_ENOUGH_CHARS = 8 * 1024;
const DIR = join(tmpdir(), "real-bot-avatar-display");

/** Keyed by the stored portrait's hash; a portrait with no smaller copy maps to itself. */
const shown = new Map<string, string>();
const warming = new Map<string, Promise<string>>();

function hashOf(avatar: string): string {
  return createHash("sha256").update(avatar).digest("hex");
}

/** A copy this module handed out, rather than a portrait someone uploaded. */
export function isDisplayAvatar(avatar: string): boolean {
  return MARKED.test(avatar);
}

/** The picture itself, without the mark: a new Bot may be given a copy another one shows. */
export function withoutDisplayMark(avatar: string): string {
  return avatar.replace(new RegExp(`;${MARK}=[0-9a-f]{16}`), "");
}

/**
 * What to send for a stored portrait. Synchronous for the snapshot barrier: a portrait not yet
 * converted goes out as it is while its copy is made, and the next snapshot or event carries it.
 */
export function displayAvatar(avatar: string | null): string | null {
  if (!avatar || avatar.length <= SMALL_ENOUGH_CHARS || !RASTER.test(avatar)) return avatar;
  const hit = shown.get(hashOf(avatar));
  if (hit) return hit;
  void warmDisplayAvatar(avatar);
  return avatar;
}

/** Makes the copy now; resolves to what {@link displayAvatar} will send from then on. */
export function warmDisplayAvatar(avatar: string | null, options: { cacheDir?: string } = {}): Promise<string | null> {
  if (!avatar || avatar.length <= SMALL_ENOUGH_CHARS) return Promise.resolve(avatar);
  const match = RASTER.exec(avatar);
  if (!match) return Promise.resolve(avatar);
  const hash = hashOf(avatar);
  const hit = shown.get(hash);
  if (hit) return Promise.resolve(hit);
  const pending = warming.get(hash);
  if (pending) return pending;
  const job = (async () => {
    let result = avatar;
    try {
      const dir = options.cacheDir ?? DIR;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const ext = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg";
      const source = join(dir, `${hash}.source.${ext}`);
      await writeFile(source, Buffer.from(match[2]!, "base64"), { mode: 0o600 });
      const reduced = await reduceImage(source, match[1]!, "avatar", { cacheDir: dir });
      if (reduced) result = `data:${reduced.mime};${MARK}=${hash.slice(0, 16)};base64,${reduced.bytes.toString("base64")}`;
    } catch {
      // The portrait goes out as it was stored.
    }
    if (shown.size >= 512) shown.clear();
    shown.set(hash, result);
    return result;
  })().finally(() => warming.delete(hash));
  warming.set(hash, job);
  return job;
}
