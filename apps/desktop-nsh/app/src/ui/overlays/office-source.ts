/**
 * Where the Office viewer reads a file from (`office-model.ts` opens it): kept apart, with no native
 * import, for the same reason as `pdf-source.ts`.
 */

/** Where a file comes from: a path the runtime serves, an attachment's content it serves, or the bytes themselves (Base64). */
export type OfficeSource =
  | { path: string; attachmentId?: undefined; base64?: undefined }
  | { attachmentId: string; path?: undefined; base64?: undefined }
  | { base64: string; path?: undefined; attachmentId?: undefined };

/**
 * Where the native module reads an Office file from on the runtime this window is connected to,
 * when it is on this computer: an attachment's content, or the workspace file; null otherwise, and
 * the viewer is handed the bytes. The loader reads no bytes for a file this gives a source for
 * (`ArtifactLoaderHost.viewerFetches`).
 */
export function officeSourceOf(file: { relpath: string; byteSource: string | null; attachmentId: string | null | undefined; local: boolean }): OfficeSource | null {
  if (!file.local) return null;
  if (file.byteSource === "attachment" && file.attachmentId) return { attachmentId: file.attachmentId };
  return file.relpath ? { path: file.relpath } : null;
}
