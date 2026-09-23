import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Vision models scale a picture down to about this long edge on their side anyway. */
export const VISION_LONG_EDGE = 1568;
/** Anything smaller goes as it is: a conversion would not buy enough to be worth a process. */
export const VISION_SHRINK_OVER_BYTES = 512 * 1024;

export type VisionImage = { mime: string; bytes: Buffer };

// The OS clears its temp dir of files nobody has read in days, which is the whole cleanup policy.
const CACHE_DIR = join(tmpdir(), "real-bot-vision");

/**
 * The bytes a picture rides on a request as. A 1920×1080 PNG keyframe is 1.5–3.7 MB and reaches
 * the model as the same pixels a 300–500 KB JPEG at 1568 would; on a slow endpoint those bytes
 * are most of the wait before the first token. Opaque pictures become JPEG, transparent ones stay
 * PNG so a mockup's cut-outs survive, and nothing is ever scaled up. Uses `sips`, so off macOS,
 * or on any failure, the original file goes unchanged. Results are cached by path, size and
 * mtime, so a picture is converted once however many turns re-read it.
 */
export function visionImage(abs: string, mime: string, stat: { size: number; mtimeMs: number }): VisionImage {
  const original = (): VisionImage => ({ mime, bytes: readFileSync(abs) });
  if (process.platform !== "darwin" || mime === "image/gif" || stat.size <= VISION_SHRINK_OVER_BYTES) {
    return original();
  }
  const key = createHash("sha256")
    .update(`${abs}\0${stat.size}\0${stat.mtimeMs}\0${VISION_LONG_EDGE}`)
    .digest("hex");
  for (const [ext, cachedMime] of CACHED_FORMATS) {
    const cached = join(CACHE_DIR, `${key}.${ext}`);
    if (existsSync(cached)) {
      try {
        return { mime: cachedMime, bytes: readFileSync(cached) };
      } catch {
        break;
      }
    }
  }
  const probe = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", abs], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.status !== 0) return original();
  const width = Number(/pixelWidth: (\d+)/.exec(probe.stdout)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(probe.stdout)?.[1]);
  if (!width || !height) return original();
  const opaque = !/hasAlpha: yes/.test(probe.stdout);
  const args: string[] = [];
  if (Math.max(width, height) > VISION_LONG_EDGE) args.push("-Z", String(VISION_LONG_EDGE));
  if (opaque) args.push("-s", "format", "jpeg", "-s", "formatOptions", "80");
  else if (mime !== "image/png") args.push("-s", "format", "png");
  if (args.length === 0) return original();

  const ext = opaque ? "jpg" : "png";
  const outMime = opaque ? "image/jpeg" : "image/png";
  const scratch = join(CACHE_DIR, `${key}.${process.pid}.tmp.${ext}`);
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const run = spawnSync("sips", [...args, abs, "--out", scratch], { timeout: 20_000 });
    if (run.status !== 0) return original();
    const bytes = readFileSync(scratch);
    if (bytes.byteLength === 0 || bytes.byteLength >= stat.size) return original();
    renameSync(scratch, join(CACHE_DIR, `${key}.${ext}`));
    return { mime: outMime, bytes };
  } catch {
    return original();
  } finally {
    rmSync(scratch, { force: true });
  }
}

const CACHED_FORMATS = [
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
] as const;
