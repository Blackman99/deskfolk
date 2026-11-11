/**
 * What `deskfolk/native`'s `Office` module hands back (Rust: `app/native/src/office/`), typed, and
 * how the viewer asks for it. The spreadsheet's model is the messenger's own
 * (`m/overlays/office/spreadsheet.ts`); the Word and PowerPoint models are the ones the viewer's
 * parts draw (`office-document.tsx`, `office-slides.tsx`).
 */
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

/** Where a file comes from: a path the runtime serves, or the bytes themselves (Base64). */
export type OfficeSource = { path: string; base64?: undefined } | { base64: string; path?: undefined };

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
    json = await Office.openOffice(id, `${origin}/v1/workspace/file?path=${encodeURIComponent(source.path)}`, token, kind);
  }
  return JSON.parse(json) as OfficeModel;
}

export function closeOffice(id: string): void {
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
