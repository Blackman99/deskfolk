/**
 * A popup's content as one wheel layer (`platform/wheel.ts`): while it is mounted, the views under
 * the popup stop hearing the wheel and those inside it keep hearing it. Put it just inside a
 * dialog or a full-window overlay that is mounted only while open.
 */
import type { JSX } from "nsh";
import { openWheelLayer, WheelLayerContext } from "./wheel";

export function WheelLayer(props: { children?: JSX.Element }): JSX.Element {
  const layer = openWheelLayer();
  return <WheelLayerContext.Provider value={layer}>{props.children}</WheelLayerContext.Provider>;
}
