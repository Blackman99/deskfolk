export type BoringAvatarVariant =
  | "beam"
  | "marble"
  | "pixel"
  | "sunset"
  | "bauhaus"
  | "ring";

export const BORING_AVATAR_VARIANTS: readonly BoringAvatarVariant[] = [
  "beam",
  "marble",
  "pixel",
  "sunset",
  "bauhaus",
  "ring",
] as const;

export const DEFAULT_BORING_PALETTES = {
  default: ["#92A1C6", "#146A7C", "#F0AB3D", "#C271B4", "#C20D90"],
  warm: ["#264653", "#2A9D8F", "#E9C46A", "#F4A261", "#E76F51"],
  sunset: ["#F45B69", "#114B5F", "#028090", "#E4FDE1", "#456990"],
  pastel: ["#BEE9E8", "#62B6CB", "#1B4965", "#CAE9FF", "#5FA8D3"],
  neon: ["#00F0FF", "#7000FF", "#FF007A", "#FFE600", "#00FF66"],
  minimal: ["#2B2D42", "#8D99AE", "#EDF2F4", "#EF233C", "#D90429"],
} as const;

export const DEFAULT_COLORS = DEFAULT_BORING_PALETTES.default;

export type BoringAvatarOptions = {
  name: string;
  variant?: BoringAvatarVariant;
  colors?: readonly string[];
  size?: number;
  square?: boolean;
  title?: boolean;
};

export function hashCode(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const character = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + character;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function getModulus(num: number, max: number): number {
  return num % max;
}

export function getDigit(number: number, ntn: number): number {
  return Math.floor((number / Math.pow(10, ntn)) % 10);
}

export function getBoolean(number: number, ntn: number): boolean {
  return !(getDigit(number, ntn) % 2);
}

export function getAngle(x: number, y: number): number {
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function getUnit(number: number, range: number, index?: number): number {
  const value = number % range;
  if (index && getDigit(number, index) % 2 === 0) {
    return -value;
  }
  return value;
}

export function getRandomColor(number: number, colors: readonly string[], range: number): string {
  return colors[Math.abs(number) % range];
}

export function getContrast(hexcolor: string): string {
  let hex = hexcolor;
  if (hex.startsWith("#")) {
    hex = hex.slice(1);
  }
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#000000" : "#FFFFFF";
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeId(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function renderBeam(name: string, colors: readonly string[], size: number, square: boolean, title: boolean): string {
  const SIZE = 36;
  const numFromName = hashCode(name);
  const range = colors.length;
  const wrapperColor = getRandomColor(numFromName, colors, range);
  const preTranslateX = getUnit(numFromName, 10, 1);
  const wrapperTranslateX = preTranslateX < 5 ? preTranslateX + SIZE / 9 : preTranslateX;
  const preTranslateY = getUnit(numFromName, 10, 2);
  const wrapperTranslateY = preTranslateY < 5 ? preTranslateY + SIZE / 9 : preTranslateY;

  const data = {
    wrapperColor,
    faceColor: getContrast(wrapperColor),
    backgroundColor: getRandomColor(numFromName + 13, colors, range),
    wrapperTranslateX,
    wrapperTranslateY,
    wrapperRotate: getUnit(numFromName, 360),
    wrapperScale: 1 + getUnit(numFromName, SIZE / 12) / 10,
    isMouthOpen: getBoolean(numFromName, 2),
    isCircle: getBoolean(numFromName, 1),
    eyeSpread: getUnit(numFromName, 5),
    mouthSpread: getUnit(numFromName, 3),
    faceRotate: getUnit(numFromName, 10, 3),
    faceTranslateX: wrapperTranslateX > SIZE / 6 ? wrapperTranslateX / 2 : getUnit(numFromName, 8, 1),
    faceTranslateY: wrapperTranslateY > SIZE / 6 ? wrapperTranslateY / 2 : getUnit(numFromName, 7, 2),
  };

  const maskId = `mask_beam_${safeId(name)}_${numFromName.toString(36)}`;
  const titleTag = title ? `<title>${escapeXml(name)}</title>` : "";
  const mouthPath = data.isMouthOpen
    ? `<path d="M15 ${19 + data.mouthSpread}c2 1 4 1 6 0" stroke="${data.faceColor}" fill="none" stroke-linecap="round" />`
    : `<path d="M13,${19 + data.mouthSpread} a1,0.75 0 0,0 10,0" fill="${data.faceColor}" />`;

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${square ? 0 : SIZE * 2}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${data.backgroundColor}" />` +
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" transform="translate(${data.wrapperTranslateX} ${data.wrapperTranslateY}) rotate(${data.wrapperRotate} ${SIZE / 2} ${SIZE / 2}) scale(${data.wrapperScale})" fill="${data.wrapperColor}" rx="${data.isCircle ? SIZE : SIZE / 6}" />` +
    `<g transform="translate(${data.faceTranslateX} ${data.faceTranslateY}) rotate(${data.faceRotate} ${SIZE / 2} ${SIZE / 2})">` +
    mouthPath +
    `<rect x="${14 - data.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${data.faceColor}" />` +
    `<rect x="${20 + data.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${data.faceColor}" />` +
    `</g>` +
    `</g>` +
    `</svg>`;
}

function renderMarble(name: string, colors: readonly string[], size: number, square: boolean, title: boolean): string {
  const ELEMENTS = 3;
  const SIZE = 80;
  const numFromName = hashCode(name);
  const range = colors.length;

  const elementsProperties = Array.from({ length: ELEMENTS }, (_, i) => ({
    color: getRandomColor(numFromName + i, colors, range),
    translateX: getUnit(numFromName * (i + 1), SIZE / 10, 1),
    translateY: getUnit(numFromName * (i + 1), SIZE / 10, 2),
    scale: 1.2 + getUnit(numFromName * (i + 1), SIZE / 20) / 10,
    rotate: getUnit(numFromName * (i + 1), 360, 1),
  }));

  const maskId = `mask_marble_${safeId(name)}_${numFromName.toString(36)}`;
  const filterId = `filter_${safeId(name)}_${numFromName.toString(36)}`;
  const titleTag = title ? `<title>${escapeXml(name)}</title>` : "";

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${square ? 0 : SIZE * 2}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${elementsProperties[0].color}" />` +
    `<path filter="url(#${filterId})" d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z" fill="${elementsProperties[1].color}" transform="translate(${elementsProperties[1].translateX} ${elementsProperties[1].translateY}) rotate(${elementsProperties[1].rotate} ${SIZE / 2} ${SIZE / 2}) scale(${elementsProperties[2].scale})" />` +
    `<path filter="url(#${filterId})" style="mix-blend-mode: overlay;" d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z" fill="${elementsProperties[2].color}" transform="translate(${elementsProperties[2].translateX} ${elementsProperties[2].translateY}) rotate(${elementsProperties[2].rotate} ${SIZE / 2} ${SIZE / 2}) scale(${elementsProperties[2].scale})" />` +
    `</g>` +
    `<defs>` +
    `<filter id="${filterId}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
    `<feFlood flood-opacity="0" result="BackgroundImageFix" />` +
    `<feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />` +
    `<feGaussianBlur stdDeviation="7" result="effect1_foregroundBlur" />` +
    `</filter>` +
    `</defs>` +
    `</svg>`;
}

function renderPixel(name: string, colors: readonly string[], size: number, square: boolean, title: boolean): string {
  const ELEMENTS = 64;
  const SIZE = 80;
  const numFromName = hashCode(name);
  const range = colors.length;

  const pixelColors = Array.from({ length: ELEMENTS }, (_, i) =>
    getRandomColor(numFromName % (i + 1), colors, range),
  );

  const maskId = `mask_pixel_${safeId(name)}_${numFromName.toString(36)}`;
  const titleTag = title ? `<title>${escapeXml(name)}</title>` : "";

  let rects = "";
  let idx = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const x = c * 10;
      const y = r * 10;
      const color = pixelColors[idx++];
      rects += `<rect x="${x}" y="${y}" width="10" height="10" fill="${color}" />`;
    }
  }

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${square ? 0 : SIZE * 2}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">` +
    rects +
    `</g>` +
    `</svg>`;
}

function renderSunset(name: string, colors: readonly string[], size: number, square: boolean, title: boolean): string {
  const ELEMENTS = 4;
  const SIZE = 80;
  const numFromName = hashCode(name);
  const range = colors.length;

  const sunsetColors = Array.from({ length: ELEMENTS }, (_, i) =>
    getRandomColor(numFromName + i, colors, range),
  );

  const maskId = `mask_sunset_${safeId(name)}_${numFromName.toString(36)}`;
  const grad0Id = `grad0_${safeId(name)}_${numFromName.toString(36)}`;
  const grad1Id = `grad1_${safeId(name)}_${numFromName.toString(36)}`;
  const titleTag = title ? `<title>${escapeXml(name)}</title>` : "";

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${square ? 0 : SIZE * 2}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">` +
    `<path fill="url(#${grad0Id})" d="M0 0h80v40H0z" />` +
    `<path fill="url(#${grad1Id})" d="M0 40h80v40H0z" />` +
    `</g>` +
    `<defs>` +
    `<linearGradient id="${grad0Id}" x1="${SIZE / 2}" y1="0" x2="${SIZE / 2}" y2="${SIZE / 2}" gradientUnits="userSpaceOnUse">` +
    `<stop stop-color="${sunsetColors[0]}" />` +
    `<stop offset="1" stop-color="${sunsetColors[1]}" />` +
    `</linearGradient>` +
    `<linearGradient id="${grad1Id}" x1="${SIZE / 2}" y1="${SIZE / 2}" x2="${SIZE / 2}" y2="${SIZE}" gradientUnits="userSpaceOnUse">` +
    `<stop stop-color="${sunsetColors[2]}" />` +
    `<stop offset="1" stop-color="${sunsetColors[3]}" />` +
    `</linearGradient>` +
    `</defs>` +
    `</svg>`;
}

function renderBauhaus(name: string, colors: readonly string[], size: number, square: boolean, title: boolean): string {
  const ELEMENTS = 4;
  const SIZE = 80;
  const numFromName = hashCode(name);
  const range = colors.length;

  const elementsProperties = Array.from({ length: ELEMENTS }, (_, i) => ({
    color: getRandomColor(numFromName + i, colors, range),
    translateX: getUnit(numFromName * (i + 1), SIZE / 2 - (i + 17), 1),
    translateY: getUnit(numFromName * (i + 1), SIZE / 2 - (i + 17), 2),
    rotate: getUnit(numFromName * (i + 1), 360),
    isSquare: getBoolean(numFromName, 2),
  }));

  const maskId = `mask_bauhaus_${safeId(name)}_${numFromName.toString(36)}`;
  const titleTag = title ? `<title>${escapeXml(name)}</title>` : "";

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${square ? 0 : SIZE * 2}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${elementsProperties[0].color}" />` +
    `<rect x="${(SIZE - 60) / 2}" y="${(SIZE - 20) / 2}" width="${SIZE}" height="${elementsProperties[1].isSquare ? SIZE : SIZE / 8}" fill="${elementsProperties[1].color}" transform="translate(${elementsProperties[1].translateX} ${elementsProperties[1].translateY}) rotate(${elementsProperties[1].rotate} ${SIZE / 2} ${SIZE / 2})" />` +
    `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" fill="${elementsProperties[2].color}" r="${SIZE / 5}" transform="translate(${elementsProperties[2].translateX} ${elementsProperties[2].translateY})" />` +
    `<line x1="0" y1="${SIZE / 2}" x2="${SIZE}" y2="${SIZE / 2}" stroke-width="2" stroke="${elementsProperties[3].color}" transform="translate(${elementsProperties[3].translateX} ${elementsProperties[3].translateY}) rotate(${elementsProperties[3].rotate} ${SIZE / 2} ${SIZE / 2})" />` +
    `</g>` +
    `</svg>`;
}

function renderRing(name: string, colors: readonly string[], size: number, square: boolean, title: boolean): string {
  const SIZE = 90;
  const COLORS = 5;
  const numFromName = hashCode(name);
  const range = colors.length;
  const colorsShuffle = Array.from({ length: COLORS }, (_, i) =>
    getRandomColor(numFromName + i, colors, range),
  );
  const ringColors = [
    colorsShuffle[0],
    colorsShuffle[1],
    colorsShuffle[1],
    colorsShuffle[2],
    colorsShuffle[2],
    colorsShuffle[3],
    colorsShuffle[3],
    colorsShuffle[0],
    colorsShuffle[4],
  ];

  const maskId = `mask_ring_${safeId(name)}_${numFromName.toString(36)}`;
  const titleTag = title ? `<title>${escapeXml(name)}</title>` : "";

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    titleTag +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${square ? 0 : SIZE * 2}" fill="#FFFFFF" />` +
    `</mask>` +
    `<g mask="url(#${maskId})">` +
    `<path d="M0 0h90v45H0z" fill="${ringColors[0]}" />` +
    `<path d="M0 45h90v45H0z" fill="${ringColors[1]}" />` +
    `<path d="M83 45a38 38 0 00-76 0h76z" fill="${ringColors[2]}" />` +
    `<path d="M83 45a38 38 0 01-76 0h76z" fill="${ringColors[3]}" />` +
    `<path d="M77 45a32 32 0 10-64 0h64z" fill="${ringColors[4]}" />` +
    `<path d="M77 45a32 32 0 11-64 0h64z" fill="${ringColors[5]}" />` +
    `<path d="M71 45a26 26 0 00-52 0h52z" fill="${ringColors[6]}" />` +
    `<path d="M71 45a26 26 0 01-52 0h52z" fill="${ringColors[7]}" />` +
    `<circle cx="45" cy="45" r="23" fill="${ringColors[8]}" />` +
    `</g>` +
    `</svg>`;
}

export function generateBoringAvatar(options: BoringAvatarOptions): string {
  const name = (options.name ?? "").trim() || "bot";
  const variant = options.variant ?? "beam";
  const colors = options.colors && options.colors.length > 0 ? options.colors : DEFAULT_COLORS;
  const square = Boolean(options.square);
  const title = Boolean(options.title);
  const size = options.size ?? (variant === "beam" ? 36 : 80);

  switch (variant) {
    case "beam":
      return renderBeam(name, colors, size, square, title);
    case "marble":
      return renderMarble(name, colors, size, square, title);
    case "pixel":
      return renderPixel(name, colors, size, square, title);
    case "sunset":
      return renderSunset(name, colors, size, square, title);
    case "bauhaus":
      return renderBauhaus(name, colors, size, square, title);
    case "ring":
      return renderRing(name, colors, size, square, title);
    default:
      return renderBeam(name, colors, size, square, title);
  }
}
