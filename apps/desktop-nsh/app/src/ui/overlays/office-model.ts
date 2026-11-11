/**
 * What `deskfolk/native`'s `Office` module hands back (Rust: `app/native/src/office/`), typed, and
 * how the viewer asks for it. The spreadsheet's model is the messenger's own
 * (`m/overlays/office/spreadsheet.ts`); the Word and PowerPoint models are the ones the viewer's
 * parts draw (`office-document.tsx`, `office-slides.tsx`).
 */
import { signal } from "nsh";
import { Office } from "deskfolk/native";
import type { TextViewBlock } from "nsh/base";
import { runtime } from "../../runtime";
import type { OfficeKind } from "../../m/overlays/office/archive.ts";
import type { Spreadsheet } from "../../m/overlays/office/spreadsheet.ts";

export type { OfficeKind, Spreadsheet };

export type WordModel = { kind: "word"; blocks: TextViewBlock[] };

export type SlideRun = { text: string; size: number; bold: boolean; italic: boolean; underline: boolean; strike: boolean; color: string };
export type SlideParagraph = {
  align: string;
  bullet: string | null;
  marL: number;
  indent: number;
  before: number;
  line: number | null;
  size: number;
  color: string;
  runs: SlideRun[];
};
export type SlideText = { anchor: string; insets: [number, number, number, number]; wrap: boolean; paragraphs: SlideParagraph[] };
export type SlideShape = {
  type: "shape" | "picture";
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  geom: string;
  fill?: string;
  line?: { color: string; width: number; dash?: string | null };
  text?: SlideText;
  src?: string;
  alt?: string;
};
export type Slide = { background: string | null; shapes: SlideShape[] };
export type DeckModel = { kind: "presentation"; width: number; height: number; slides: Slide[]; truncated: boolean };
export type SheetModel = Spreadsheet & { kind: "spreadsheet" };
export type OfficeModel = WordModel | SheetModel | DeckModel;

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

/** The reasons a file does not open: too large or expanding too far, or anything else. */
export type OfficeFailure = "limit" | "error";

export function failureOf(error: unknown): OfficeFailure {
  return String(error instanceof Error ? error.message : error).includes("office-limit") ? "limit" : "error";
}

let opened = 0;

/** A fresh id for a document the Rust module holds. */
export function nextOfficeId(): string {
  return `office-${++opened}`;
}

/** Opens `source` as document `id` of `kind`; the model, or a rejection `failureOf` reads. */
export async function openOffice(id: string, kind: OfficeKind, source: OfficeSource): Promise<OfficeModel> {
  let json: string;
  if (source.base64 !== undefined) {
    json = Office.openOfficeBytes(id, kind, source.base64);
  } else {
    const client = runtime.client;
    if (!client || client.kind !== "local") throw new Error("not connected");
    const { origin, token } = client.endpoint;
    const url =
      source.attachmentId !== undefined
        ? `${origin}/v1/attachments/${source.attachmentId}/content`
        : `${origin}/v1/workspace/file?path=${encodeURIComponent(source.path)}`;
    json = await Office.openOffice(id, url, token, kind);
  }
  return JSON.parse(json) as OfficeModel;
}

export function closeOffice(id: string): void {
  forgetPictures(id);
  Office.closeOffice(id);
}

/** A picture of the document as a data URL, from the part a model names (`office-image:<part>`). */
export function officePicture(id: string, src: string): string {
  try {
    return Office.officeImage(id, src.replace(/^office-image:/, ""));
  } catch {
    return "";
  }
}

/** How large a document's picture is handed to the image view, in pixels on its longer side. */
export const OFFICE_PICTURE_MAX = 2560;

/** Reads a picture off the engine thread and scaled to `OFFICE_PICTURE_MAX`, when this build's host can. */
const pictureAsync = (Office as unknown as { officeImageAsync?: (id: string, part: string, max: number) => Promise<string> }).officeImageAsync;

const pictures = new Map<string, ReturnType<typeof signal<string | null>>>();

/**
 * `officePicture`, read off the engine thread: null while it is on the way, then the data URL, or
 * "" when there is none. A full-size photo in a document (24 MB) was decoded on the engine thread
 * each time its page was drawn. An older host reads it as before.
 */
export function officePictureLive(id: string, src: string): () => string | null {
  if (typeof pictureAsync !== "function") {
    const now = officePicture(id, src);
    return () => now;
  }
  const key = `${id}\u0000${src}`;
  let held = pictures.get(key);
  if (!held) {
    const made = signal<string | null>(null);
    held = made;
    pictures.set(key, made);
    void pictureAsync(id, src.replace(/^office-image:/, ""), OFFICE_PICTURE_MAX).then(
      (url) => made.set(url),
      () => made.set(""),
    );
  }
  const live = held;
  return () => live() ?? null;
}

/** Lets go of the pictures read for document `id`. */
function forgetPictures(id: string): void {
  for (const key of [...pictures.keys()]) if (key.startsWith(`${id}\u0000`)) pictures.delete(key);
}
