import { FOLK_LAYER_EDGE, FOLK_LAYERS, type FolkLayer } from "./folk-avatar-assets.ts";

/**
 * Round fills behind the folk, one per avatar family in tokens.css (`--av-N-*`) except the
 * mustard one, which the mustard body would vanish into. Each sits between that family's
 * light background and line, so it holds up on the dark theme too: an `<img>` cannot follow
 * the app's theme, so the fill is baked in like every other generated avatar's colours.
 */
export const FOLK_FILLS = ["#cbe1e6", "#f1d4c8", "#d0e3d5", "#e1d4e7", "#d7dee1", "#cfe2ef", "#ebd4db"] as const;

const EYES = ["dot", "happy", "wink"] as const;
const MOUTHS = ["smile", "open", "cat"] as const;
const ACCESSORIES = [null, "sprout", "antenna", "bow", "headphones"] as const;

export type FolkLook = {
  fill: (typeof FOLK_FILLS)[number];
  eyes: (typeof EYES)[number];
  mouth: (typeof MOUTHS)[number];
  accessory: (typeof ACCESSORIES)[number];
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
  // A third of them wave; the raised arm would pass through an ear cup, so not with headphones.
  const wave = pick([true, false, false]) && accessory !== "headphones";
  return { fill, eyes, mouth, accessory, wave, mirror };
}

/** The folk avatar: the Deskfolk mark's mustard teammate, rendered in 3D, varied by name. */
export function renderFolk(hash: number, size: number, square: boolean, titleTag: string): string {
  const look = folkLook(hash);
  const edge = FOLK_LAYER_EDGE;
  const layers: FolkLayer[] = [
    look.wave ? "body-wave" : "body-rest",
    `eyes-${look.eyes}`,
    `mouth-${look.mouth}`,
  ];
  if (look.accessory) layers.push(`acc-${look.accessory}`);
  const images = layers
    .map((layer) => `<image href="data:image/webp;base64,${FOLK_LAYERS[layer]}" width="${edge}" height="${edge}" />`)
    .join("");
  const maskId = `mask_folk_${hash.toString(36)}`;
  return `<svg viewBox="0 0 ${edge} ${edge}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${edge}" height="${edge}">` +
    `<rect width="${edge}" height="${edge}" rx="${square ? 0 : edge * 2}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">` +
    `<rect width="${edge}" height="${edge}" fill="${look.fill}" />` +
    (look.mirror ? `<g transform="matrix(-1 0 0 1 ${edge} 0)">${images}</g>` : images) +
    `</g>` +
    `</svg>`;
}
