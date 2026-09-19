import {
  generateBoringAvatar,
  BORING_AVATAR_VARIANTS,
  DEFAULT_BORING_PALETTES,
  DEFAULT_COLORS,
  USER_MEMBER,
  type BoringAvatarVariant,
  type Bot,
  type SessionSummary,
} from "@real-bot/protocol";
import { activeMembers } from "./sidebar/session-groups.ts";

export {
  generateBoringAvatar,
  BORING_AVATAR_VARIANTS,
  DEFAULT_BORING_PALETTES,
  DEFAULT_COLORS,
  type BoringAvatarVariant,
};

export const AVATAR_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const AVATAR_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const AVATAR_MAX_EDGE = 256;
export const AVATAR_MAX_DATA_URI_CHARS = 180_000;

export type AvatarImageError = "type" | "size" | "decode";

const RASTER_DATA_URI = /^data:image\/(png|jpeg|jpg|webp|gif)\b/i;

/**
 * True when the stored avatar is a user-supplied raster image (uploaded data URI
 * or a leftover http(s) URL), not a generated SVG.
 */
export function isCustomAvatar(avatar: string | null | undefined): boolean {
  if (!avatar) return false;
  const trimmed = avatar.trim();
  if (trimmed.length === 0) return false;
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    RASTER_DATA_URI.test(trimmed)
  );
}

export type AvatarEditorMode = "generated" | "custom";
export type AvatarEditorAction = "randomize" | "style" | "upload";

/** Generated SVG vs an uploaded raster. Drives which editor buttons appear. */
export function avatarEditorMode(avatar: string | null | undefined): AvatarEditorMode {
  return isCustomAvatar(avatar) ? "custom" : "generated";
}

/**
 * Primary actions next to the preview. Randomize and Style both return to a
 * generated SVG, so they never share a row: generated keeps Randomize + Upload;
 * an uploaded image keeps Style + Upload.
 */
export function avatarEditorPrimaryActions(mode: AvatarEditorMode): readonly AvatarEditorAction[] {
  if (mode === "custom") return ["style", "upload"];
  return ["randomize", "upload"];
}

export function mimeFromAvatarFile(file: { type: string; name: string }): string {
  const raw = file.type.trim().toLowerCase();
  if (raw === "image/jpg") return "image/jpeg";
  if (raw.length > 0) return raw;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "";
}

export function classifyAvatarFile(file: { type: string; name: string; size: number }): AvatarImageError | null {
  const mime = mimeFromAvatarFile(file);
  if (!(AVATAR_IMAGE_TYPES as readonly string[]).includes(mime)) return "type";
  if (file.size > AVATAR_MAX_SOURCE_BYTES) return "size";
  return null;
}

export function coverDrawParams(
  sourceW: number,
  sourceH: number,
  edge: number,
): { dx: number; dy: number; dw: number; dh: number; edge: number } {
  const width = Math.max(1, sourceW);
  const height = Math.max(1, sourceH);
  const size = Math.max(1, edge);
  const scale = Math.max(size / width, size / height);
  const dw = width * scale;
  const dh = height * scale;
  return { dx: (size - dw) / 2, dy: (size - dh) / 2, dw, dh, edge: size };
}

/**
 * Reads a local image file, center-crops it to a square, and returns a compact
 * JPEG data URI suitable for storing on the Bot record.
 */
export async function fileToAvatarDataUri(
  file: File,
): Promise<{ ok: true; dataUri: string } | { ok: false; error: AvatarImageError }> {
  const classified = classifyAvatarFile(file);
  if (classified) return { ok: false, error: classified };
  let decoded: { width: number; height: number; source: CanvasImageSource; close?: () => void };
  try {
    decoded = await decodeAvatarImage(file);
  } catch {
    return { ok: false, error: "decode" };
  }
  try {
    const dataUri = await rasterizeAvatar(decoded.source, decoded.width, decoded.height);
    if (!dataUri || dataUri.length > AVATAR_MAX_DATA_URI_CHARS) {
      return { ok: false, error: "size" };
    }
    return { ok: true, dataUri };
  } catch {
    return { ok: false, error: "decode" };
  } finally {
    decoded.close?.();
  }
}

async function decodeAvatarImage(
  file: File,
): Promise<{ width: number; height: number; source: CanvasImageSource; close?: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadHtmlImage(url);
    return { width: image.naturalWidth, height: image.naturalHeight, source: image };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode"));
    image.src = url;
  });
}

async function rasterizeAvatar(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
): Promise<string> {
  const qualities = [0.85, 0.7, 0.55];
  const edges = [AVATAR_MAX_EDGE, 192, 128];
  let last = "";
  for (const edge of edges) {
    const { canvas, ctx } = makeCanvas(edge);
    const draw = coverDrawParams(sourceW, sourceH, edge);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, edge, edge);
    ctx.drawImage(source, draw.dx, draw.dy, draw.dw, draw.dh);
    for (const quality of qualities) {
      last = await canvasToJpeg(canvas, quality);
      if (last.length > 0 && last.length <= AVATAR_MAX_DATA_URI_CHARS) return last;
    }
  }
  return last;
}

function makeCanvas(edge: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("decode");
    return { canvas, ctx };
  }
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(edge, edge);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("decode");
    return { canvas, ctx };
  }
  throw new Error("decode");
}

async function canvasToJpeg(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
): Promise<string> {
  if ("toDataURL" in canvas) {
    return canvas.toDataURL("image/jpeg", quality);
  }
  if ("convertToBlob" in canvas) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return blobToDataUri(blob);
  }
  throw new Error("decode");
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("decode"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Returns a URL/data URI string suitable for an <img src="..."> element,
 * or null if no valid avatar is present.
 */
export function avatarSrc(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  const trimmed = avatar.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
    return trimmed;
  }
  if (trimmed.startsWith("<svg")) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(trimmed)}`;
  }
  return null;
}

export type CompositeAvatarLayoutType = "empty" | "single" | "pair" | "triad" | "quad";

export type CompositeAvatarPlan<T> = {
  layout: CompositeAvatarLayoutType;
  visible: readonly T[];
  overflowCount: number;
  overflowNames: readonly string[];
};

/**
 * Plans the visual layout for a composite avatar based on member count.
 * - 0: empty fallback icon
 * - 1: single avatar (100% size)
 * - 2: pair layout (diagonal overlap)
 * - 3: triad layout (top-center, bottom-left, bottom-right triangle cluster)
 * - 4: quad layout (2x2 cluster)
 * - 5+: quad layout with 3 visible member avatars and a +N overflow counter
 */
export function compositeAvatarLayout<T extends { name: string | null }>(
  avatars: readonly T[],
): CompositeAvatarPlan<T> {
  const count = avatars.length;
  if (count === 0) {
    return { layout: "empty", visible: [], overflowCount: 0, overflowNames: [] };
  }
  if (count === 1) {
    return { layout: "single", visible: avatars, overflowCount: 0, overflowNames: [] };
  }
  if (count === 2) {
    return { layout: "pair", visible: avatars, overflowCount: 0, overflowNames: [] };
  }
  if (count === 3) {
    return { layout: "triad", visible: avatars, overflowCount: 0, overflowNames: [] };
  }
  if (count === 4) {
    return { layout: "quad", visible: avatars, overflowCount: 0, overflowNames: [] };
  }
  return {
    layout: "quad",
    visible: avatars.slice(0, 3),
    overflowCount: count - 3,
    overflowNames: avatars.slice(3).map((a) => a.name ?? "?"),
  };
}

export function sessionAvatars(
  session: SessionSummary,
  bots: ReadonlyMap<string, Bot>,
): { id: string; name: string | null; src: string | null }[] {
  return activeMembers(session.participants)
    .filter((id) => id !== USER_MEMBER)
    .map((id) => {
      const bot = bots.get(id);
      return { id, name: bot?.name ?? null, src: avatarSrc(bot?.avatar) };
    });
}
