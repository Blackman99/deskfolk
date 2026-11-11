/** The platform pieces NSH leaves to the app: wheel events forwarded by the shell, and popups over them. */
import { Overlay, signal, Text, View, windowSize, type JSX, type ViewRef } from "nsh";
import { onWheel } from "../src/platform/wheel";
import { WheelLayer } from "../src/platform/wheel-layer";
import { Modal } from "../src/ui/Modal";

/** A view inside a popup that adds up the wheel it hears, shown as `<name>:<sum>`. */
function WheelSum(props: { name: string; class?: string; height?: number }) {
  const sum = signal(0);
  let view: ViewRef | undefined;
  onWheel(
    () => view,
    (e) => sum.update((v) => v + e.dy),
  );
  return (
    <View testID={`wheel-${props.name}`} ref={(n) => (view = n)} class={`bg-line ${props.class ?? ""}`} style={{ height: props.height }}>
      <Text>{`${props.name}:${sum()}`}</Text>
    </View>
  );
}

/** Lays out what its render prop makes, as `WorkspaceView` mounts the preview it is handed. */
function RenderProp(props: { children: (box: string) => JSX.Element }) {
  return <View class="absolute flex-col" style={{ left: 300, top: 200, width: 500, height: 300 }}>{props.children("flex-1")}</View>;
}

export default function Platform() {
  const outer = signal(0);
  const inner = signal(0);
  const zoom = signal(1);
  const dialog = signal(false);
  const overlay = signal(false);
  let outerView: ViewRef | undefined;
  let innerView: ViewRef | undefined;
  onWheel(
    () => outerView,
    (e) => {
      if (e.ctrl) zoom.update((z) => Math.round(z * Math.exp(-e.dy / 100) * 100) / 100);
      else outer.update((v) => v + e.dy);
    },
  );
  onWheel(
    () => innerView,
    (e, at) => inner.set(Math.round(at.x) * 1000 + Math.round(at.y)),
  );
  return (
    <View class="flex-1 bg-bg">
      <View testID="wheel-outer" ref={(n) => (outerView = n)} class="absolute bg-pane" style={{ left: 0, top: 0, width: 400, height: 300 }}>
        <View testID="wheel-inner" ref={(n) => (innerView = n)} class="absolute bg-line" style={{ left: 200, top: 150, width: 100, height: 100 }} />
      </View>
      <View class="absolute gap-1" style={{ left: 420, top: 0 }}>
        <Text testID="wheel-outer-sum">{`outer:${outer()}`}</Text>
        <Text testID="wheel-inner-at">{`inner:${inner()}`}</Text>
        <Text testID="wheel-zoom">{`zoom:${zoom()}`}</Text>
        <View testID="wheel-open-dialog" role="button" onPress={() => dialog.set(true)}>
          <Text>open dialog</Text>
        </View>
        <View testID="wheel-open-overlay" role="button" onPress={() => overlay.set(true)}>
          <Text>open overlay</Text>
        </View>
      </View>
      <If when={dialog()}>
        <Modal title="Wheel" closeLabel="Close" onClose={() => dialog.set(false)}>
          <WheelSum name="dialog" height={200} />
        </Modal>
      </If>
      <If when={overlay()}>
        <Overlay style={{ width: windowSize().width, height: windowSize().height }}>
          <WheelLayer>
            <View testID="wheel-overlay-scrim" class="flex-1 bg-bg/90" onPress={() => overlay.set(false)}>
              <RenderProp>{(box) => <WheelSum name="overlay" class={box} />}</RenderProp>
            </View>
          </WheelLayer>
        </Overlay>
      </If>
    </View>
  );
}
