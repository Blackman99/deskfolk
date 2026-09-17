import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

export const AVATAR_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const AVATAR_MAX_DATA_URI_CHARS = 180_000;

export type AvatarEncodeError = "not_text" | "too_large" | "failed" | "not_found";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function avatarMimeFromPath(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

export function rasterFileToAvatarDataUri(
  abs: string,
): { ok: true; dataUri: string } | { ok: false; code: AvatarEncodeError; message: string } {
  let buf: Buffer;
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return { ok: false, code: "failed", message: "path is a directory" };
    if (st.size > AVATAR_MAX_SOURCE_BYTES) return { ok: false, code: "too_large", message: "file is too large" };
    buf = readFileSync(abs);
  } catch (error) {
    if (isNotFound(error)) return { ok: false, code: "not_found", message: "file not found" };
    return { ok: false, code: "failed", message: "read failed" };
  }
  if (buf.byteLength > AVATAR_MAX_SOURCE_BYTES) {
    return { ok: false, code: "too_large", message: "file is too large" };
  }
  const mime = avatarMimeFromPath(abs);
  if (!mime) {
    return { ok: false, code: "not_text", message: "avatar_path must be a PNG, JPEG, GIF, or WebP image" };
  }
  const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
  if (dataUri.length > AVATAR_MAX_DATA_URI_CHARS) {
    return { ok: false, code: "too_large", message: "file is too large" };
  }
  return { ok: true, dataUri };
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}
