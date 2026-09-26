/**
 * Workspace pictures handed to an MCP tool.
 *
 * A remote MCP server cannot read this Mac's disk, and a tool that takes a picture as a URL or a
 * data URI left a Bot one way to pass a file it made: write the file's base64 into the call's
 * arguments itself. A model cannot copy tens of thousands of characters exactly, so on 2026-09-25
 * a Bot spent an hour shrinking one storyboard frame into smaller and smaller base64 for a video
 * tool, and never called it.
 *
 * So a string argument that is a `workspace://<path>` reference — the whole string, the path
 * relative to the workspace root as the file tools take it — is replaced with the picture's data
 * URI just before the call
 * goes out. Only the outgoing copy changes: the call the model wrote, the one the transcript and
 * the next hop see, keeps the short reference. Large pictures ride as the same smaller copy a
 * vision model is sent.
 */
import { statSync } from "node:fs";
import { extname } from "node:path";
import { visionImage } from "./vision-image";
import { classifyPath } from "./workspace-paths";

export const WORKSPACE_REF = "workspace://";

/** Past this, even the smaller copy is more than an MCP request should carry. */
export const WORKSPACE_REF_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type InlinedArgs =
  | { ok: true; args: Record<string, unknown>; inlined: number }
  | { ok: false; message: string };

/**
 * `args` with every `workspace://` string replaced by its picture's data URI. A reference that
 * cannot be honoured fails the whole call with a message the model can act on, rather than
 * sending the server a string it would read as a broken URL.
 */
export function inlineWorkspaceRefs(args: Record<string, unknown>, workspace: string | null): InlinedArgs {
  const state: { inlined: number; failure: string | null } = { inlined: 0, failure: null };

  const visit = (value: unknown): unknown => {
    if (state.failure) return value;
    if (typeof value === "string") {
      if (!value.startsWith(WORKSPACE_REF)) return value;
      const resolved = resolveRef(value, workspace);
      if (!resolved.ok) {
        state.failure = resolved.message;
        return value;
      }
      state.inlined += 1;
      return resolved.dataUri;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = visit(item);
      return out;
    }
    return value;
  };

  const next = visit(args) as Record<string, unknown>;
  if (state.failure) return { ok: false, message: state.failure };
  return { ok: true, args: state.inlined > 0 ? next : args, inlined: state.inlined };
}

function resolveRef(ref: string, workspace: string | null): { ok: true; dataUri: string } | { ok: false; message: string } {
  const path = ref.slice(WORKSPACE_REF.length).trim();
  if (!workspace) return { ok: false, message: `${ref}: no workspace is set, so there is nothing to read` };
  if (!path) return { ok: false, message: `${ref}: write the picture's path after ${WORKSPACE_REF}, relative to the workspace root` };
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) {
    return { ok: false, message: `${ref}: only pictures can be passed this way (PNG, JPEG, WebP, GIF)` };
  }
  let abs: string;
  try {
    const classified = classifyPath(workspace, path);
    if (classified.zone !== "inside") return { ok: false, message: `${ref}: the path is outside the workspace` };
    abs = classified.abs;
  } catch {
    return { ok: false, message: `${ref}: the path could not be read` };
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { ok: false, message: `${ref}: no such file in the workspace` };
  }
  if (!stat.isFile()) return { ok: false, message: `${ref}: not a file` };
  let picture;
  try {
    picture = visionImage(abs, mime, { size: stat.size, mtimeMs: stat.mtimeMs });
  } catch {
    return { ok: false, message: `${ref}: the picture could not be read` };
  }
  if (picture.bytes.byteLength > WORKSPACE_REF_MAX_BYTES) {
    return { ok: false, message: `${ref}: the picture is too large to send (over 8 MB even when shrunk)` };
  }
  return { ok: true, dataUri: `data:${picture.mime};base64,${picture.bytes.toString("base64")}` };
}
