/**
 * The phone's page for the Mac's (or Windows PC's) screen (`overlays/RemoteScreenPane.svelte`). Only
 * a phone reaches its Mac this way, so there is no desktop pane for it; this host fills the window
 * over whatever is under it and names the host's words. The messenger also lifts the key row above
 * a software keyboard by the visual viewport; NSH's own layout handles the keyboard, so that is left out.
 */
import { View } from "nsh";
import { rememberedSignIn } from "../../m/remote/screen-sign-in.ts";
import type { StoredEnrollment } from "../../m/remote/idb.ts";
import type { ScreenViewApi } from "./remote-screen-controller.ts";
import { RemoteScreenView } from "./RemoteScreenView.tsx";

export function RemoteScreenPane(props: {
  /** The remote link's API: `kind` is "remote" for a paired phone, which is the only one with a screen. */
  api: ScreenViewApi & { kind: string; screenHost?: "mac" | "windows"; enrollment?: Pick<StoredEnrollment, "hostId" | "deviceId"> };
  onClose: () => void;
}) {
  return (
    <View testID="screen-overlay" role="group" class="absolute inset-0 bg-pane">
      <If when={props.api.kind === "remote"}>
        <RemoteScreenView
          api={props.api}
          host={props.api.screenHost ?? "mac"}
          onClose={props.onClose}
          remember={props.api.enrollment ? rememberedSignIn(props.api.enrollment) : undefined}
        />
      </If>
    </View>
  );
}
