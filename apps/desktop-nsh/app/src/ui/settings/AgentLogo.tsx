/**
 * A built-in connector's mark (ADR 0072), a speech service's (ADR 0073) and a local agent's
 * (ADR 0079) on its brand's own tile, the same in both themes (`settings/ConnectorLogo.svelte`,
 * `AgentLogo.svelte`). A logo is not themed, so the glyph is an SVG data URI in its own colours,
 * not a `tint-*` image; only an agent of your own, which has no brand, wears the app's ink.
 */
import { Image, View, token } from "nsh";
import type { BotRunner } from "@real-bot/protocol";
import type { VendorId } from "../../m/model-source";
import { GLYPHS } from "./logo-glyphs";

type Tile = { background: string; color?: string; padding?: number };

/** Each vendor's own tile, keyed by every vendor so one added without its mark fails the type check. */
const CONNECTOR_TILE: Record<VendorId, Tile> = {
  anthropic: { background: "#f0eee6", color: "#141413" },
  xiaomi: { background: "#ff6900", color: "#ffffff", padding: 0.1 },
  qwen: { background: "#ffffff" },
  deepseek: { background: "#ffffff", padding: 0.12 },
  openai: { background: "#ffffff", color: "#000000" },
  groq: { background: "#f55036", color: "#ffffff" },
  siliconflow: { background: "#ffffff", color: "#6e29f6" },
  deepgram: { background: "#000000", color: "#13ef93", padding: 0.2 },
  elevenlabs: { background: "#ffffff", color: "#000000", padding: 0.22 },
};

const AGENT_TILE: Record<BotRunner, Tile> = {
  claude_code: { background: "#f0eee6", padding: 0.18 },
  codex: { background: "#ffffff", padding: 0 },
  grok: { background: "#000000", color: "#ffffff", padding: 0.18 },
  opencode: { background: "#ffffff", color: "#000000", padding: 0.2 },
  antigravity: { background: "#ffffff", padding: 0.14 },
  zcode: { background: "#ffffff", color: "#000000", padding: 0.2 },
  custom: { background: "", padding: 0.16 },
};

const cache = new Map<string, string>();

/** A glyph as a data URI, `currentColor` replaced by the tile's colour. */
export function glyphUri(key: string, color: string, size: number): string {
  const cacheKey = `${key}|${color}|${size}`;
  const known = cache.get(cacheKey);
  if (known) return known;
  const svg = (GLYPHS[key] ?? "")
    // HTML takes attribute values without quotes (`id=connector-qwen`); an SVG document does not.
    .replace(/(\s[\w:-]+)=([^\s"'>]+)/g, '$1="$2"')
    .replace(/currentColor/g, color)
    .replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `);
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(cacheKey, uri);
  return uri;
}

function Tiled(props: { glyph: string; tile: Tile; size: number; custom?: boolean; testID?: string }) {
  const pad = () => Math.round(props.size * (props.tile.padding ?? 0.16) * 100) / 100;
  const inner = () => Math.max(1, props.size - 2 - pad() * 2);
  const color = () => props.tile.color ?? (props.custom ? token("ink-secondary") : "#000000");
  return (
    <View
      testID={props.testID}
      accessible={false}
      class={`items-center justify-center overflow-hidden rounded-(--radius-sm) border shrink-0 ${props.custom ? "border-chip-line bg-chip" : "border-[#00000014]"}`}
      style={{ width: props.size, height: props.size, backgroundColor: props.custom ? undefined : props.tile.background }}
    >
      <Image src={glyphUri(props.glyph, color(), inner())} style={{ width: inner(), height: inner() }} />
    </View>
  );
}

export function ConnectorLogo(props: { id: VendorId; size?: number }) {
  return <Tiled glyph={props.id} tile={CONNECTOR_TILE[props.id]} size={props.size ?? 36} />;
}

export function AgentLogo(props: { runner: BotRunner; size?: number }) {
  const key = () => (props.runner === "claude_code" ? "spark" : `agent:${props.runner}`);
  return <Tiled glyph={key()} tile={AGENT_TILE[props.runner]} size={props.size ?? 36} custom={props.runner === "custom"} testID={`agent-logo-${props.runner}`} />;
}

/** The Claude Spark, Anthropic's mark for Claude, as `ClaudeSpark.svelte` draws it. */
export function ClaudeSpark(props: { size?: number }) {
  const size = () => props.size ?? 16;
  return <Image src={glyphUri("spark", "#D97757", size())} style={{ width: size(), height: size(), flexShrink: 0 }} accessible={false} />;
}
