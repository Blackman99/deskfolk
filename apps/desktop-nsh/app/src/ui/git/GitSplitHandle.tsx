/**
 * Shared 1px divider with a 7px `PanResponder` drag grip for resizing Git sub-panes
 * (vertical `col-resize` between side-by-side columns, horizontal `row-resize` when stacked).
 */
import { PanResponder, signal, View } from "nsh";
import { tip } from "../tip";

export function GitSplitHandle(props: {
  axis: "vertical" | "horizontal";
  testID: string;
  label: string;
  enabled?: boolean;
  onDragStart: () => void;
  onDragDelta: (delta: number) => void;
  onDragEnd: () => void;
}) {
  const dragging = signal(false);

  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => props.enabled !== false,
    onPanResponderGrant: () => {
      dragging.set(true);
      props.onDragStart();
    },
    onPanResponderMove: (_e, g) => {
      props.onDragDelta(props.axis === "vertical" ? g.dx : g.dy);
    },
    onPanResponderRelease: () => {
      dragging.set(false);
      props.onDragEnd();
    },
    onPanResponderTerminate: () => {
      dragging.set(false);
      props.onDragEnd();
    },
    onPanResponderTerminationRequest: () => false,
  });

  if (props.axis === "horizontal") {
    return (
      <View class="h-px bg-line shrink-0" style={{ zIndex: 5 }}>
        <View
          role="button"
          testID={props.testID}
          accessibilityLabel={props.label}
          tooltip={tip(props.label)}
          {...pan.panHandlers}
          class="absolute left-0 right-0 cursor-row-resize select-none group"
          style={{ top: -3, height: 7, cursor: "row-resize" }}
        >
          <View
            accessible={false}
            class={`absolute left-0 right-0 ${dragging() ? "bg-brand" : "bg-transparent group-hover:bg-accent-border"}`}
            style={{ top: 2, height: 3, pointerEvents: "none" }}
          />
        </View>
      </View>
    );
  }

  return (
    <View class="w-px bg-line shrink-0" style={{ zIndex: 5 }}>
      <View
        role="button"
        testID={props.testID}
        accessibilityLabel={props.label}
        tooltip={tip(props.label)}
        {...pan.panHandlers}
        class="absolute top-0 bottom-0 cursor-col-resize select-none group"
        style={{ left: -3, width: 7, cursor: "col-resize" }}
      >
        <View
          accessible={false}
          class={`absolute top-0 bottom-0 ${dragging() ? "bg-brand" : "bg-transparent group-hover:bg-accent-border"}`}
          style={{ left: 2, width: 3, pointerEvents: "none" }}
        />
      </View>
    </View>
  );
}
