/** Reading a mutation's body and checking the revision it was made against. */

import { HttpError } from "../errors";
import { matchPath, readJson } from "../http";
import { normalizeFiles, type NormalizedFile } from "../request-digest";
import type { AttachmentInput, Store } from "../store";
import type { FileCommit } from "../store/files";
import type { RequestScope } from "../store/receipts";

export type ParsedMutation = {
  body: Record<string, unknown>; files: AttachmentInput[]; multipart: boolean; stagedWrite?: FileCommit;
  normalizedFiles?: NormalizedFile<AttachmentInput>[]; digestBody?: Record<string, unknown>;
};

export async function parseMutation(request: Request, staged?: AttachmentInput[]): Promise<ParsedMutation> {
  const media = (request.headers.get("content-type") ?? "application/json").split(";")[0]!.trim().toLowerCase();
  if (media !== "application/json" && media !== "multipart/form-data") throw new HttpError(422, "invalid_args", "unsupported mutation media type");
  if (media === "application/json") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "invalid_args", "body must be an object");
    const record = body as Record<string, unknown>;
    if (staged?.length) {
      const digestBody = { ...record };
      delete digestBody.files;
      return {
        body: digestBody, files: staged, multipart: true, digestBody,
        normalizedFiles: staged.map((file) => {
          if (!file.staged?.sha256) throw new HttpError(422, "invalid_args", "file hash mismatch");
          return { file, filename: file.originalFilename, hash: file.staged.sha256 };
        }),
      };
    }
    if (Array.isArray(record.files) && record.files.length) {
      throw new HttpError(422, "invalid_args", "remote file bytes must arrive on type 0x05");
    }
    return { body: record, files: [], multipart: false };
  }
  const form = await request.formData();
  const body: Record<string, unknown> = {};
  const files: AttachmentInput[] = [];
  for (const [key, value] of form) {
    if (value instanceof File) files.push({ originalFilename: value.name, buffer: new Uint8Array(await value.arrayBuffer()) });
    else {
      if (Object.hasOwn(body, key)) throw new HttpError(422, "invalid_args", "duplicate multipart field");
      Object.defineProperty(body, key, { value, enumerable: true });
    }
  }
  const normalizedFiles = normalizeFiles(files, (file) => ({ filename: file.originalFilename, bytes: file.buffer }));
  return { body, files: normalizedFiles.map((item) => item.file), normalizedFiles, multipart: true };
}

/** A prompt edit names the change it was made on: a revision id, or null for a prompt nobody has changed. */
export function promptRevisionGuard(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new HttpError(422, "invalid_args", "if_revision is required: the latest change you saw, or null");
}

export function checkRevision(store: Store, request: Request, url: URL, body: Record<string, unknown>, scope: RequestScope): void {
  if (request.method === "PUT" && url.pathname === "/v1/workspace/file" && scope.requireRevision && !request.headers.has("If-Match")) {
    throw new HttpError(422, "invalid_args", "If-Match is required");
  }
  if ((request.method === "PATCH" || request.method === "DELETE") && matchPath(url.pathname, "/v1/routines/:id")) {
    if (scope.requireRevision && body.if_revision === undefined) throw new HttpError(422, "invalid_args", "if_revision is required");
    // The routine Store method compares once inside this receipt transaction.
    return;
  }
  const destructive = scope.requireRevision && (request.method === "DELETE" || /\/(archive|restore|clear)$/.test(url.pathname));
  if (request.method !== "PATCH" && !destructive) return;
  const revision = body.if_revision;
  if (revision === undefined && !scope.requireRevision) return;
  // The speech endpoint is part of the settings and shares their revision (ADR 0073).
  if (url.pathname === "/v1/settings" || url.pathname === "/v1/speech") {
    if (!Number.isInteger(revision) || revision !== store.settingsCached().settings_rev) throw new HttpError(409, "conflict", "settings revision changed");
  } else {
    const parts = url.pathname.split("/");
    const tables: Record<string, string> = { bots: "bots", skills: "skills", memories: "memories", routines: "routines", providers: "providers", "mcp-servers": "mcp_servers", sessions: "sessions", annotations: "annotations", checks: "acceptance_checks" };
    const table = parts[2] === "allow-rules" && destructive ? "allow_rules" : tables[parts[2] ?? ""];
    if (!table || !parts[3]) return;
    const revisionColumn = table === "allow_rules" ? "created_at" : "updated_at";
    const row = store.db.query<{ updated_at: string }, [string]>(`SELECT ${revisionColumn} AS updated_at FROM ${table} WHERE id = ?`).get(decodeURIComponent(parts[3]));
    if (!row) throw new HttpError(404, "not_found", "entity not found");
    if (typeof revision !== "string" || revision !== row.updated_at) throw new HttpError(409, "conflict", "entity revision changed");
  }
  delete body.if_revision;
}
