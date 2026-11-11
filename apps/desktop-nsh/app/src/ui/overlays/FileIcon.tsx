/**
 * A file's kind at a glance (`overlays/FileIcon.svelte`): a code file's letters (`TS`, `PY`, `{}`)
 * or the app icon of its kind, in the kind's colour from `src/m/overlays/file-icon.ts`. Those
 * colours are picked against a light pane; on a dark one each is lifted 40% toward the text colour,
 * or the greys of Markdown and plain text all but vanish.
 */
import { colorScheme, Image, Text, token, View } from "nsh";
import type { FileIcon as FileIconSpec } from "../../m/overlays/file-icon.ts";
import { iconUri, type IconSize } from "../Icon";

function hex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})/i.exec(color.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `color-mix(in srgb, tint 60%, ink)`, as the messenger's dark rule draws it. */
export function liftedTint(tint: string, ink: string): string {
  const a = hex(tint);
  const b = hex(ink);
  if (!a || !b) return tint;
  const mix = a.map((v, i) => Math.round(v * 0.6 + b[i]! * 0.4));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function FileIcon(props: { icon: FileIconSpec; size?: IconSize }) {
  const size = () => props.size ?? 16;
  const color = () => (colorScheme() === "dark" ? liftedTint(props.icon.tint, token("ink")) : props.icon.tint);
  return (
    <View
      accessible={false}
      class="items-center justify-center shrink-0"
      style={{ width: size(), height: size() }}
    >
      <If
        when={props.icon.letter}
        else={<Image src={iconUri(props.icon.glyph, size())} style={{ width: size(), height: size(), tintColor: color() }} accessible={false} />}
      >
        {(letter: () => string) => (
          <Text
            class="font-mono font-bold tracking-[-0.04em] leading-none"
            style={{ fontSize: Math.max(8, size() - 4), color: color() }}
          >
            {letter()}
          </Text>
        )}
      </If>
    </View>
  );
}
