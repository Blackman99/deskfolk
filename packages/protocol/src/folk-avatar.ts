import { FOLK_GEOMETRY, FOLK_LAYER_EDGE, FOLK_LAYERS, type FolkLayer } from "./folk-avatar-assets.ts";

/**
 * The round fills the first folk stood on, one per avatar family in tokens.css (`--av-N-*`) but
 * mustard. The folk stands on nothing now; `folkLook` still draws this trait first so that every
 * name keeps the face and pose it was given then.
 */
export const FOLK_FILLS = ["#cbe1e6", "#f1d4c8", "#d0e3d5", "#e1d4e7", "#d7dee1", "#cfe2ef", "#ebd4db"] as const;

const EYES = ["dot", "happy", "wink"] as const;
const MOUTHS = ["smile", "open", "cat"] as const;
/** What the first folks wore on their heads. A character wears its own now; the pick stays so the picks after it keep their digits. */
const ACCESSORIES = [null, "sprout", "antenna", "bow", "headphones"] as const;

/**
 * Who a Bot's folk is: one of the task map's characters (`taskmap/scene/figures.ts`), each in its own
 * colour, with what it wears and what it holds, and its own way of working. Pudding with its antenna;
 * taro in headphones with a clipboard; sakura in a beret with palette and brush; matcha in a chef's hat
 * with a whisk; caramel in a hard hat with a hammer; sesame in glasses with a pencil and a book;
 * blueberry in a wizard's hat with a wand. Not Mochi, whose white stands for you. A Bot is the same
 * character on its avatar and on the map.
 */
export const FOLK_CHARACTERS = ["pudding", "taro", "sakura", "matcha", "caramel", "sesame", "blueberry"] as const;
export type FolkCharacter = (typeof FOLK_CHARACTERS)[number];

/** Characters that never rest with an arm up: taro's would pass through its headphones. */
const KEEPS_ARMS_DOWN: ReadonlySet<FolkCharacter> = new Set(["taro"]);

/** How far a raised arm turns up about its shoulder, counter-clockwise: nearly straight up. */
export const FOLK_RAISED_ARM_DEG = 160;

export type FolkLook = {
  fill: (typeof FOLK_FILLS)[number];
  eyes: (typeof EYES)[number];
  mouth: (typeof MOUTHS)[number];
  /** Drawn no more (the character wears its own); kept so the name's other picks stay where they were. */
  accessory: (typeof ACCESSORIES)[number];
  /** At rest, its right arm (its left, mirrored) is up, with what that hand holds. */
  wave: boolean;
  mirror: boolean;
  character: FolkCharacter;
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
  // A third of them raise an arm.
  const raised = pick([true, false, false]);
  // Drawn last, so every name kept the face it had before folks became the map's characters.
  const character = pick(FOLK_CHARACTERS);
  return { fill, eyes, mouth, accessory, wave: raised && !KEEPS_ARMS_DOWN.has(character), mirror, character };
}

export type FolkPart = "body" | "antenna" | "arm-l" | "held-l" | "arm-r" | "held-r" | "front";

/** A character's own layer for `part`, or null when it has none (only some hold things, wear glasses, have an antenna). */
export function folkPart(look: Pick<FolkLook, "character">, part: FolkPart): FolkLayer | null {
  const layer = `${look.character}-${part}`;
  return layer in FOLK_LAYERS ? (layer as FolkLayer) : null;
}

/**
 * The layers a look stacks, back to front, before any motion: the body with what it wears, its
 * antenna, each arm with what that hand holds, the face, and what sits over the face (glasses).
 */
export function folkLayers(look: FolkLook): FolkLayer[] {
  const parts: (FolkLayer | null)[] = [
    folkPart(look, "body"),
    folkPart(look, "antenna"),
    folkPart(look, "arm-l"),
    folkPart(look, "held-l"),
    folkPart(look, "arm-r"),
    folkPart(look, "held-r"),
    `eyes-${look.eyes}`,
    `mouth-${look.mouth}`,
    folkPart(look, "front"),
  ];
  return parts.filter((layer): layer is FolkLayer => layer !== null);
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
 * The folk drawn: Pudding, the Deskfolk mascot (the mark's mustard teammate), or another of the task
 * map's characters, rendered in 3D and varied by name. It has no fill and fills its square; the mask
 * only carries the name hash.
 */
export function renderFolk(hash: number, size: number, titleTag: string): string {
  const look = folkLook(hash);
  const edge = FOLK_LAYER_EDGE;
  const [armX, armY] = FOLK_GEOMETRY.shoulderR;
  const raisedLayers = new Set([folkPart(look, "arm-r"), folkPart(look, "held-r")]);
  const images = folkLayers(look)
    .map((layer) => {
      const raised = raisedLayers.has(layer) && look.wave
        ? ` transform="rotate(${-FOLK_RAISED_ARM_DEG} ${armX * edge} ${armY * edge})"`
        : "";
      return `<image href="${folkLayerSrc(layer)}" width="${edge}" height="${edge}"${raised} />`;
    })
    .join("");
  return folkSvg(hash, size, titleTag, look.mirror ? `<g transform="matrix(-1 0 0 1 ${edge} 0)">${images}</g>` : images);
}
