import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { REMOTE_FILE_LIMIT } from "@real-bot/remote";
import { fileEtag } from "./file-integrity";
import { HttpError } from "./errors";

export function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last! > 0 ? { start: Math.max(0, size - last!), end: size - 1 } : null;
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/** Read only the requested bytes; hashing a whole movie here would defeat seeking. */
export function fileRangeResponse(abs: string, mime: string, filename: string, range: string, remote: boolean): Response {
  const fd = openSync(abs, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HttpError(422, "invalid_args", "path is not a file");
    if (remote && stat.size > REMOTE_FILE_LIMIT) throw new HttpError(413, "file_limit", "remote file limit exceeded");
    const selected = parseByteRange(range, stat.size);
    if (!selected) return Response.json({ error: { code: "invalid_range", message: "range not satisfiable" } }, {
      status: 416, headers: { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" },
    });
    const bytes = new Uint8Array(selected.end - selected.start + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, selected.start + offset);
      if (!read) throw new HttpError(409, "file_changed", "file changed while reading");
      offset += read;
    }
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.length),
        "Content-Range": `bytes ${selected.start}-${selected.end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "ETag": fileEtag(bytes),
        "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    closeSync(fd);
  }
}
