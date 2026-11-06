/**
 * What rides under the pointer while files are dragged out of the tree (`WorkspaceDragGhost.svelte`).
 * Mount it once on the shell; it draws nothing when no drag is under way. The chip takes no
 * pointer, and is placed below and right of the pointer, flipped near an edge (`ghostPlacement`).
 */
import { Overlay, signal, Text, View, windowSize } from "nsh";
import { ghostPlacement } from "../m/workspace-drag.svelte.ts";
import { shadow } from "./styles";
import { workspaceDrag } from "./workspace-drag";

export function WorkspaceDragGhost() {
  const size = signal({ width: 0, height: 0 });
  return (
    <If when={workspaceDrag.current}>
      {(drag) => {
        const at = () => ghostPlacement(drag(), size(), windowSize());
        return (
          <Overlay class="left-0 top-0 right-0 bottom-0" style={{ pointerEvents: "none" }}>
            <View
              accessible={false}
              testID="workspace-drag-ghost"
              onLayout={(e) => size.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
              class={`absolute max-w-[280px] px-2 py-[2px] rounded-(--radius-sm) bg-pane ${drag().over ? "border border-brand" : ""}`}
              style={{ left: at().x, top: at().y, boxShadow: shadow("menu"), pointerEvents: "none" }}
            >
              <Text class="text-[12px] text-ink line-clamp-1">{drag().label}</Text>
            </View>
          </Overlay>
        );
      }}
    </If>
  );
}
