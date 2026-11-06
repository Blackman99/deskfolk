/**
 * The tiles a new endpoint starts on (`settings/ConnectorPicker.svelte`, ADR 0072): each built-in
 * connector with its logo, name and blurb, then "custom endpoint". Two columns on a desktop, one on
 * a phone (720px or less in the messenger; here the settings' 680).
 *
 * Props: `onPick(id)` with the connector's id, or null for a custom endpoint. Tiles are
 * `connector-pick-<id>` and `connector-pick-custom`.
 */
import { signal, Text, View, type JSX } from "nsh";
import { CONNECTORS, type ConnectorId } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { ConnectorLogo } from "./ConnectorLogo";

function Tile(props: { width: number; testID: string; name: string; blurb: string; onPress: () => void; mark: JSX.Element }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={`${props.name} ${props.blurb}`}
      onPress={() => props.onPress()}
      class={`flex-row items-center gap-3 min-w-0 p-3 border border-line rounded-(--radius-md) bg-pane hover:border-accent-border hover:bg-accent-tint ${narrowWindow() ? "min-h-16" : ""}`}
      style={{ width: props.width }}
    >
      {props.mark}
      <View class="flex-col gap-[3px] min-w-0 shrink">
        <Text class={`${narrowWindow() ? "text-[15px]" : "text-[14px]"} font-semibold text-ink leading-[1.3]`}>{props.name}</Text>
        <Text class={`${narrowWindow() ? "text-[13px]" : "text-[12px]"} text-ink-muted leading-[1.45]`}>{props.blurb}</Text>
      </View>
    </View>
  );
}

export function ConnectorPicker(props: { onPick: (id: ConnectorId | null) => void }) {
  const t = () => copy().connectors;
  /** The grid's width, so two tiles share a row (one on a phone) without a percentage. */
  const gridWidth = signal(0);
  const tileWidth = () => (narrowWindow() ? gridWidth() : Math.floor((gridWidth() - 10) / 2));
  return (
    <View class="flex-col">
      <Text class="mb-[14px] text-[13px] leading-[1.6] text-ink-muted">{t().pickHint}</Text>
      <View class="flex-row flex-wrap gap-[10px]" onLayout={(e) => gridWidth.set(e.bounds.size.width)}>
        <Each of={CONNECTORS} key={(connector) => connector.id}>
          {(connector) => (
            <Tile
              width={tileWidth()}
              testID={`connector-pick-${connector().id}`}
              name={t().name[connector().id]}
              blurb={t().blurb[connector().id]}
              onPress={() => props.onPick(connector().id)}
              mark={<ConnectorLogo id={connector().id} size={40} />}
            />
          )}
        </Each>
        <Tile
          width={tileWidth()}
          testID="connector-pick-custom"
          name={t().custom}
          blurb={t().customBlurb}
          onPress={() => props.onPick(null)}
          mark={
            <View class="items-center justify-center shrink-0 w-10 h-10 rounded-(--radius-sm) border-[1.5px] border-dashed border-line">
              <Icon name="link" size={20} class="tint-brand" />
            </View>
          }
        />
      </View>
    </View>
  );
}
