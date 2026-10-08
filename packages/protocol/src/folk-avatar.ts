import { FOLK_GEOMETRY, FOLK_LAYER_EDGE, FOLK_LAYERS, type FolkLayer } from "./folk-avatar-assets.ts";

/**
 * The round fills the first folk stood on, one per avatar family in tokens.css (`--av-N-*`) but
 * mustard. The folk stands on nothing now; `folkLook` still draws this trait first so that every
 * name keeps the face, accessory and pose it was given then.
 */
export const FOLK_FILLS = ["#cbe1e6", "#f1d4c8", "#d0e3d5", "#e1d4e7", "#d7dee1", "#cfe2ef", "#ebd4db"] as const;

const EYES = ["dot", "happy", "wink"] as const;
const MOUTHS = ["smile", "open", "cat"] as const;
const ACCESSORIES = [null, "sprout", "antenna", "bow", "headphones"] as const;

/** How far a raised arm turns up about its shoulder, counter-clockwise: nearly straight up. */
export const FOLK_RAISED_ARM_DEG = 160;

export type FolkLook = {
  fill: (typeof FOLK_FILLS)[number];
  eyes: (typeof EYES)[number];
  mouth: (typeof MOUTHS)[number];
  accessory: (typeof ACCESSORIES)[number];
  /** At rest, its right arm (its left, mirrored) is up. */
  wave: boolean;
  mirror: boolean;
};

/** murmur3's finaliser: spreads a name hash over all 32 bits so short names vary too. */
function mix(hash: number): number {
  let h = hash >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Which folk a name hash draws. Every trait reads its own mixed-radix digit of the hash. */
export function folkLook(hash: number): FolkLook {
  let h = mix(hash);
  const pick = <T>(list: readonly T[]): T => {
    const value = list[h % list.length]!;
    h = Math.floor(h / list.length);
    return value;
  };
  const fill = pick(FOLK_FILLS);
  const eyes = pick(EYES);
  const mouth = pick(MOUTHS);
  const accessory = pick(ACCESSORIES);
  const mirror = pick([false, true]);
  // A third of them raise an arm; the raised arm would pass through an ear cup, so not with headphones.
  const wave = pick([true, false, false]) && accessory !== "headphones";
  return { fill, eyes, mouth, accessory, wave, mirror };
}

/** The layers a look stacks, back to front, before any motion. */
export function folkLayers(look: FolkLook): FolkLayer[] {
  const layers: FolkLayer[] = ["body", "arm-l", "arm-r", `eyes-${look.eyes}`, `mouth-${look.mouth}`];
  if (look.accessory) layers.push(`acc-${look.accessory}`);
  return layers;
}

export function folkLayerSrc(layer: FolkLayer): string {
  return `data:image/webp;base64,${FOLK_LAYERS[layer]}`;
}

/**
 * The name hash a folk avatar was drawn from, read from its mask id, or null for anything else.
 * The hash is the folk's identity: the app draws a stored folk from it (`renderFolk`), so every
 * folk follows the current layers and the messenger animates the same face.
 */
export function folkHash(avatar: string | null | undefined): number | null {
  const match = avatar?.trim().startsWith("<svg") ? /\bmask_folk_([0-9a-z]+)"/.exec(avatar) : null;
  return match ? parseInt(match[1]!, 36) : null;
}

function folkSvg(hash: number, size: number, titleTag: string, body: string): string {
  const edge = FOLK_LAYER_EDGE;
  const maskId = `mask_folk_${hash.toString(36)}`;
  return `<svg viewBox="0 0 ${edge} ${edge}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${edge}" height="${edge}">` +
    `<rect width="${edge}" height="${edge}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">${body}</g>` +
    `</svg>`;
}

/**
 * A folk avatar as it is stored and sent: the name hash in its mask id and, for anything that shows
 * it raw, the folk's outline in the mark's mustard. A few hundred characters, where the drawn folk
 * is some 15 000; Bots, tool results and the phone's link carry this one, and the app draws it with
 * `renderFolk`.
 */
export function folkAvatar(hash: number, size: number, titleTag: string): string {
  const e = FOLK_LAYER_EDGE;
  return folkSvg(hash, size, titleTag, `<ellipse cx="${e * 0.5}" cy="${e * 0.6}" rx="${e * 0.38}" ry="${e * 0.4}" fill="#f0ab3d" />`);
}

/** A stored folk avatar in its stored form, whatever form it was saved in; anything else as it is. */
export function compactFolkAvatar(avatar: string): string {
  const hash = folkHash(avatar);
  if (hash === null) return avatar;
  return folkAvatar(hash, 80, /<title>[^<]*<\/title>/.exec(avatar)?.[0] ?? "");
}

/**
 * The folk drawn: Pudding, the Deskfolk mascot (the mark's mustard teammate), rendered in 3D and
 * varied by name. It has no fill and fills its square; the mask only carries the name hash.
 */
export function renderFolk(hash: number, size: number, titleTag: string): string {
  const look = folkLook(hash);
  const edge = FOLK_LAYER_EDGE;
  const [armX, armY] = FOLK_GEOMETRY.shoulderR;
  const images = folkLayers(look)
    .map((layer) => {
      const raised = layer === "arm-r" && look.wave
        ? ` transform="rotate(${-FOLK_RAISED_ARM_DEG} ${armX * edge} ${armY * edge})"`
        : "";
      return `<image href="${folkLayerSrc(layer)}" width="${edge}" height="${edge}"${raised} />`;
    })
    .join("");
  return folkSvg(hash, size, titleTag, look.mirror ? `<g transform="matrix(-1 0 0 1 ${edge} 0)">${images}</g>` : images);
}
