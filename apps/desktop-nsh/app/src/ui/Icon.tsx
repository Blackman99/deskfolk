/**
 * One of the app's icons (`src/m/icons.ts`, the messenger's table), as a template SVG recoloured
 * by its class: `tint-ink-muted`, `group-hover:tint-ink`, `tint-brand`. The stroke is 1.6 points at
 * every size, as `Icon.svelte`'s non-scaling stroke draws it, so icons of different sizes match.
 *
 *   <Icon name="plus" />                         16pt, grey
 *   <Icon name="pin" size={12} filled class="tint-brand" />
 */
import { Image } from "nsh";
import { iconShapes, type IconName, type IconSize } from "../m/icons.ts";

export type { IconName, IconSize };

const STROKE = 1.6;
const cache = new Map<string, string>();

/** The icon as an SVG data URI, drawn in black for tinting. */
export function iconUri(name: IconName, size: IconSize = 16, filled = false): string {
  const key = `${name}:${size}:${filled ? 1 : 0}`;
  const known = cache.get(key);
  if (known) return known;
  const icon = iconShapes(name, filled);
  const stroke = ((STROKE * 24) / size).toFixed(3);
  const paint = icon.fill ? `fill="#000" stroke="none"` : icon.solid ? `fill="#000" stroke="#000"` : `fill="none" stroke="#000"`;
  const parts = icon.shapes.map((shape) => {
    if ("p" in shape) return `<path d="${shape.p}"${shape.evenodd ? ` fill-rule="evenodd"` : ""}/>`;
    if ("c" in shape) return `<circle cx="${shape.c[0]}" cy="${shape.c[1]}" r="${shape.c[2]}"/>`;
    const [x, y, w, h, rx] = shape.r;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${paint} ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${parts.join("")}</svg>`;
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(key, uri);
  return uri;
}

export function Icon(props: {
  name: IconName;
  /** Edge length in points, by role: 12 inline, 16 default, 20 toolbars, 24 tab bar, 32 empty states. */
  size?: IconSize;
  /** The solid twin, for a state the icon shows (pinned, default). */
  filled?: boolean;
  /** Tailwind classes; the colour is a `tint-*` class (default `tint-ink-muted`). */
  class?: string;
  /** Read out when the icon carries meaning alone; otherwise hidden from readers. */
  label?: string;
}) {
  return (
    <Image
      src={iconUri(props.name, props.size ?? 16, props.filled ?? false)}
      class={`${props.class ?? "tint-ink-muted"}`}
      style={{ width: props.size ?? 16, height: props.size ?? 16, flexShrink: 0 }}
      accessibilityLabel={props.label}
      accessible={props.label !== undefined}
    />
  );
}
