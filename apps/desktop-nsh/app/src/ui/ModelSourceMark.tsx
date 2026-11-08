/**
 * Where a model comes from, or whose a speech service is, in front of its name in a picker (see
 * `src/m/model-source.ts`): a vendor's or agent's logo, the Claude spark, or "Custom".
 */
import { Text, untracked, View } from "nsh";
import type { ModelSource } from "../m/model-source";
import { Icon } from "./Icon";
import { AgentLogo, ClaudeSpark, ConnectorLogo } from "./settings/AgentLogo";

export function ModelSourceMark(props: {
  source: ModelSource;
  /** Where marks stand in a column of sources (the picker's): an endpoint of no known vendor as a plain tile, not the word "Custom", so the names line up. */
  tile?: boolean;
  /** Logo edge in points (16 by default; the phone's sheet draws 28). */
  size?: number;
}) {
  const size = () => props.size ?? 16;
  const s = () => props.source;
  const kind = () => {
    const source = s();
    return source.kind === "connector" || source.kind === "vendor" ? source.id : source.kind;
  };
  /** What the mark draws, as one key. */
  const markKey = () => {
    const source = s() as { kind: string; id?: string; runner?: string; name?: string };
    return `${source.kind}|${source.id ?? ""}|${source.runner ?? ""}|${source.name ?? ""}|${props.tile ? 1 : 0}|${size()}`;
  };
  return (
    <View
      testID={`model-source-${kind()}`}
      accessible={false}
      class="items-center justify-center shrink-0 flex-row"
      style={{ minWidth: size(), height: size() }}
    >
      {/* Drawn again only when what it draws changes: the source arrives as a new object on every
          snapshot (each streamed token), and the logo was made again each time. */}
      <Each of={[markKey()]} key={(k: string) => k}>
        {() => untracked(() => {
        const source = s();
        if (source.kind === "connector" || source.kind === "vendor") return <ConnectorLogo id={source.id} size={size()} />;
        if (source.kind === "claude-agent" && props.tile) return <AgentLogo runner="claude_code" size={size()} />;
        if (source.kind === "claude-agent") return <ClaudeSpark size={Math.round(size() * 0.875)} />;
        if (source.kind === "agent") return <AgentLogo runner={source.runner} size={size()} />;
        if (props.tile) {
          return (
            <View class="items-center justify-center rounded-(--radius-sm) border border-chip-line bg-chip" style={{ width: size(), height: size() }}>
              <Icon name="server" size={12} class="tint-ink-secondary" />
            </View>
          );
        }
        // Drawn, not written: an option's text stays the model's name, for type-to-find and copying.
        return (
          <View class="h-[16px] px-[4px] justify-center rounded-(--radius-sm) border border-chip-line bg-chip">
            <Text class="text-[10px] font-semibold text-ink-secondary">{source.name}</Text>
          </View>
        );
        })}
      </Each>
    </View>
  );
}
