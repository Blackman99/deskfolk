import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";

/**
 * A smaller copy of a picture, asked for with `?size=` on the file and attachment GETs. A chat's
 * pictures are whole originals — a storyboard keyframe is 2–4 MB of PNG — and a phone pulling
 * them through the relay to fill a 36 px chip waited seconds per picture for pixels it threw away.
 */
export type ImageVariant = "thumb" | "preview";
/** `avatar` is internal: Bot portraits as snapshots and events carry them. Never a `?size=`. */
export type ScaledVariant = ImageVariant | "avatar";

/**
 * Long edge in pixels. A chip is 36 px on a screen up to 3×; an enlargement fills a phone's width
 * with room to zoom; a portrait is 28–42 px in lists on a 3× phone (56 px in the editor). Measured
 * on a 1920×1080 keyframe of 3.7 MB: 15 KB and 550 KB; seven 256 px portraits: 117 KB → 48 KB.
 */
export const IMAGE_VARIANT_EDGE: Record<ScaledVariant, number> = { thumb: 256, preview: 1600, avatar: 128 };
const JPEG_QUALITY: Record<ScaledVariant, number> = { thumb: 70, preview: 80, avatar: 72 };

/** A GIF keeps its frames in an enlargement; a chip only ever showed the first one. */
const SCALABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif"]);
const FORMATS = [
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
] as const;

// The OS clears its temp dir of files nobody has read in days, which is the whole cleanup policy.
const CACHE_DIR = join(tmpdir(), "real-bot-image-variants");
const SIPS_TIMEOUT_MS = 20_000;
/** Opening a picture-heavy chat asks for dozens at once; the Mac has other work to do. */
const MAX_JOBS = 2;

export type ReducedImage = { bytes: Buffer<ArrayBuffer>; mime: string };
type Options = { cacheDir?: string; platform?: string; sips?: string };

export function parseImageVariant(value: string | null): ImageVariant | null {
  if (value === null) return null;
  if (value === "thumb" || value === "preview") return value;
  throw new HttpError(422, "invalid_args", "size must be thumb or preview");
}

const inflight = new Map<string, Promise<ReducedImage | null>>();
/** Pictures already within the size, so asking again costs no probe. Keys change with the file. */
const asIs = new Set<string>();
let running = 0;
const waiting: Array<() => void> = [];

/**
 * The picture at `abs` scaled to fit the variant, or null when the original is what should go:
 * not a raster `sips` reads, already within the size, not macOS, or any failure along the way.
 * Opaque pictures become JPEG and transparent ones stay PNG; nothing is scaled up. Results are
 * cached by path, size and mtime, so a picture is converted once however often it is shown.
 */
export async function reduceImage(
  abs: string,
  mime: string,
  variant: ScaledVariant,
  options: Options = {},
): Promise<ReducedImage | null> {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  if (!SCALABLE.has(mime) || (mime === "image/gif" && variant !== "thumb")) return null;
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = await stat(abs));
  } catch {
    return null;
  }
  const edge = IMAGE_VARIANT_EDGE[variant];
  const key = createHash("sha256").update(`v1\0${abs}\0${size}\0${mtimeMs}\0${variant}\0${edge}`).digest("hex");
  if (asIs.has(key)) return null;
  const dir = options.cacheDir ?? CACHE_DIR;
  for (const [ext, cachedMime] of FORMATS) {
    try {
      return { mime: cachedMime, bytes: await readFile(join(dir, `${key}.${ext}`)) };
    } catch {
      // Not converted yet, or cleaned up since.
    }
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = inSlot(() => convert(abs, size, variant, key, dir, options.sips ?? "sips"))
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_JOBS) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function keepAsIs(key: string): null {
  if (asIs.size >= 4096) asIs.clear();
  asIs.add(key);
  return null;
}

async function convert(
  abs: string,
  size: number,
  variant: ScaledVariant,
  key: string,
  dir: string,
  sips: string,
): Promise<ReducedImage | null> {
  const probe = await run(sips, ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", abs]);
  if (probe === null) return null;
  const width = Number(/pixelWidth: (\d+)/.exec(probe)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(probe)?.[1]);
  if (!width || !height) return null;
  const edge = IMAGE_VARIANT_EDGE[variant];
  if (Math.max(width, height) <= edge) return keepAsIs(key);
  const opaque = !/hasAlpha: yes/.test(probe);
  const ext = opaque ? "jpg" : "png";
  const args = ["-Z", String(edge), "-s", "format", opaque ? "jpeg" : "png"];
  if (opaque) args.push("-s", "formatOptions", String(JPEG_QUALITY[variant]));
  const scratch = join(dir, `${key}.${randomBytes(6).toString("hex")}.tmp.${ext}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await run(sips, [...args, abs, "--out", scratch])) === null) return null;
    const bytes = await readFile(scratch);
    if (bytes.byteLength === 0) return null;
    // Fewer bytes and more pixels: the original is better on both counts.
    if (bytes.byteLength >= size) return keepAsIs(key);
    await rename(scratch, join(dir, `${key}.${ext}`));
    return { mime: opaque ? "image/jpeg" : "image/png", bytes };
  } catch {
    return null;
  } finally {
    await rm(scratch, { force: true });
  }
}

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), SIPS_TIMEOUT_MS);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 ? out : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
