/** The platform pieces NSH leaves to the app: wheel events forwarded by the shell. */
import { signal, Text, View, type ViewRef } from "nsh";
import { onWheel } from "../src/platform/wheel";

export default function Platform() {
  const outer = signal(0);
  const inner = signal(0);
  const zoom = signal(1);
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
      </View>
    </View>
  );
}
