import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePowerShell } from "./platform";

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
 * are most of the wait before the first token — and a 4K screenshot can be past what a provider
 * takes for one picture at all. Opaque pictures become JPEG, transparent ones stay PNG so a
 * mockup's cut-outs survive, and nothing is ever scaled up. Uses `sips` on macOS and GDI+ through
 * PowerShell on Windows; elsewhere, or on any failure, the original file goes unchanged. Results
 * are cached by path, size and mtime, so a picture is converted once however many turns re-read it.
 */
export function visionImage(abs: string, mime: string, stat: { size: number; mtimeMs: number }): VisionImage {
  const original = (): VisionImage => ({ mime, bytes: readFileSync(abs) });
  const shrink = process.platform === "darwin" ? shrinkWithSips : process.platform === "win32" ? shrinkWithGdiPlus : null;
  if (!shrink || mime === "image/gif" || stat.size <= VISION_SHRINK_OVER_BYTES) {
    return original();
  }
  const key = createHash("sha256")
    .update(`${abs}\0${stat.size}\0${stat.mtimeMs}\0${VISION_LONG_EDGE}`)
    .digest("hex");
  // "Nothing to gain" is remembered too, or a picture that stays as it is would start the tool
  // again every turn — a PowerShell start on Windows, about a second each time.
  const asIs = join(CACHE_DIR, `${key}.as-is`);
  const keepAsIs = (): VisionImage => {
    try {
      writeFileSync(asIs, "");
    } catch {
      // Only a cache.
    }
    return original();
  };
  if (existsSync(asIs)) return original();
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
  const scratchBase = join(CACHE_DIR, `${key}.${process.pid}.tmp`);
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const shrunk = shrink(abs, mime, scratchBase);
    if (!shrunk) return original();
    if (shrunk === "as-is") return keepAsIs();
    const [ext, outMime] = shrunk;
    const scratch = `${scratchBase}.${ext}`;
    const bytes = readFileSync(scratch);
    if (bytes.byteLength === 0) return original();
    if (bytes.byteLength >= stat.size) return keepAsIs();
    renameSync(scratch, join(CACHE_DIR, `${key}.${ext}`));
    return { mime: outMime, bytes };
  } catch {
    return original();
  } finally {
    for (const [ext] of CACHED_FORMATS) rmSync(`${scratchBase}.${ext}`, { force: true });
  }
}

const CACHED_FORMATS = [
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
] as const;

type CachedFormat = (typeof CACHED_FORMATS)[number];

/**
 * Writes the shrunk picture to `${scratchBase}.<ext>` and says which format it chose. `"as-is"`
 * when there is nothing to gain for this file (remembered), null when the tool failed (tried again
 * next time); either way the original goes.
 */
type Shrinker = (abs: string, mime: string, scratchBase: string) => CachedFormat | "as-is" | null;

const shrinkWithSips: Shrinker = (abs, mime, scratchBase) => {
  const probe = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", abs], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.status !== 0) return null;
  const width = Number(/pixelWidth: (\d+)/.exec(probe.stdout)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(probe.stdout)?.[1]);
  if (!width || !height) return null;
  const opaque = !/hasAlpha: yes/.test(probe.stdout);
  const args: string[] = [];
  if (Math.max(width, height) > VISION_LONG_EDGE) args.push("-Z", String(VISION_LONG_EDGE));
  if (opaque) args.push("-s", "format", "jpeg", "-s", "formatOptions", "80");
  else if (mime !== "image/png") args.push("-s", "format", "png");
  if (args.length === 0) return "as-is";
  const format = opaque ? CACHED_FORMATS[0] : CACHED_FORMATS[1];
  const run = spawnSync("sips", [...args, abs, "--out", `${scratchBase}.${format[0]}`], { timeout: 20_000 });
  return run.status === 0 ? format : null;
};

/**
 * The same decisions as the `sips` path, made by GDI+ (`System.Drawing`, in both Windows
 * PowerShell and PowerShell 7). GDI+ writes no EXIF, so a photo's orientation tag is applied to
 * the pixels first, or a portrait shot would reach the model on its side. The paths go in through
 * the environment, never into the script text. It prints the format it wrote, or `unchanged`.
 */
const GDI_PLUS_SHRINK_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$edge = [int]$env:REAL_BOT_IMAGE_EDGE
$image = [System.Drawing.Image]::FromFile($env:REAL_BOT_IMAGE_IN)
try {
  $turned = $false
  if ($image.PropertyIdList -contains 0x0112) {
    $flip = switch ([int]$image.GetPropertyItem(0x0112).Value[0]) {
      2 { 'RotateNoneFlipX' } 3 { 'Rotate180FlipNone' } 4 { 'Rotate180FlipX' } 5 { 'Rotate90FlipX' }
      6 { 'Rotate90FlipNone' } 7 { 'Rotate270FlipX' } 8 { 'Rotate270FlipNone' } default { $null }
    }
    if ($flip) { $image.RotateFlip([System.Drawing.RotateFlipType]$flip); $turned = $true }
  }
  $opaque = -not [System.Drawing.Image]::IsAlphaPixelFormat($image.PixelFormat)
  $long = [Math]::Max($image.Width, $image.Height)
  if ($long -le $edge -and -not $opaque -and -not $turned -and $env:REAL_BOT_IMAGE_MIME -eq 'image/png') { 'unchanged'; return }
  $scale = [Math]::Min(1.0, $edge / [double]$long)
  $width = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
  $height = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
  $pixels = if ($opaque) { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb } else { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb }
  $bitmap = New-Object System.Drawing.Bitmap $width, $height, $pixels
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    # Tiling the source past its edge keeps bicubic from fading the border to transparent.
    $wrap = New-Object System.Drawing.Imaging.ImageAttributes
    $wrap.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $graphics.DrawImage($image, (New-Object System.Drawing.Rectangle 0, 0, $width, $height), 0, 0, $image.Width, $image.Height, [System.Drawing.GraphicsUnit]::Pixel, $wrap)
    $graphics.Dispose()
    if ($opaque) {
      $jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $quality = New-Object System.Drawing.Imaging.EncoderParameters 1
      $quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]80)
      $bitmap.Save($env:REAL_BOT_IMAGE_OUT + '.jpg', $jpeg, $quality)
      'jpg'
    } else {
      $bitmap.Save($env:REAL_BOT_IMAGE_OUT + '.png', [System.Drawing.Imaging.ImageFormat]::Png)
      'png'
    }
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $image.Dispose()
}
`;

/** PNG, JPEG, BMP or TIFF by their first bytes: what GDI+ decodes. WebP and HEIC it does not. */
function gdiPlusDecodes(abs: string): boolean {
  const head = Buffer.alloc(4);
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    readSync(fd, head, 0, 4, 0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const hex = head.toString("hex");
  return hex === "89504e47" || hex.startsWith("ffd8ff") || hex.startsWith("424d") || hex === "49492a00" || hex === "4d4d002a";
}

const shrinkWithGdiPlus: Shrinker = (abs, mime, scratchBase) => {
  if (!gdiPlusDecodes(abs)) return "as-is";
  const run = spawnSync(resolvePowerShell(), ["-NoProfile", "-NonInteractive", "-Command", GDI_PLUS_SHRINK_SCRIPT], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      REAL_BOT_IMAGE_IN: abs,
      REAL_BOT_IMAGE_OUT: scratchBase,
      REAL_BOT_IMAGE_MIME: mime,
      REAL_BOT_IMAGE_EDGE: String(VISION_LONG_EDGE),
    },
  });
  if (run.status !== 0) return null;
  const answer = run.stdout.trim();
  if (answer === "unchanged") return "as-is";
  return CACHED_FORMATS.find(([ext]) => ext === answer) ?? null;
};
