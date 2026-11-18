/**
 * Where `PdfViewer` reads a PDF from (`pdf-pages.ts` opens it): kept apart from the viewer, with no
 * native import, because the file preview asks it for every file it shows, and anything the app
 * loads at start that imported `deskfolk/native` brought all of it (PDF pages included) before the
 * phone's first screen (`lazy-views.ts`).
 */
import type { Attachment } from "@real-bot/protocol";
import type { artifactByteSource } from "../../m/overlays/artifacts.ts";
import { runtime } from "../../runtime";

/**
 * Where a PDF comes from: the runtime's file endpoint (or any URL it answers) and its token, or its
 * bytes (base64) with the password to try first. A new one opens a new document.
 */
export type PdfSource = { url: string; token: string } | { base64: string; password?: string };

/** The source of a workspace file, on the runtime this window is connected to; null while it is not connected. */
export function pdfSourceFor(path: string): PdfSource | null {
  const client = runtime.client;
  if (!client || client.kind !== "local") return null;
  const { origin, token } = client.endpoint;
  return { url: `${origin}/v1/workspace/file?path=${encodeURIComponent(path)}`, token };
}

/**
 * Where the native module reads a PDF from: an attachment's content, or the workspace file, on the
 * runtime this window is connected to when it is on this computer; null otherwise. The loader reads
 * no bytes for a file this gives a source for (`ArtifactLoaderHost.viewerFetches`).
 */
export function pdfSourceOf(file: {
  relpath: string;
  byteSource: ReturnType<typeof artifactByteSource>;
  attachment: Attachment | null | undefined;
}): PdfSource | null {
  if (file.byteSource === "attachment" && file.attachment) {
    const client = runtime.client;
    if (!client || client.kind !== "local") return null;
    return { url: `${client.endpoint.origin}/v1/attachments/${file.attachment.id}/content`, token: client.endpoint.token };
  }
  return pdfSourceFor(file.relpath);
}
