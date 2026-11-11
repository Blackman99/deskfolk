/**
 * The Mac's own screen, on the paired device (`overlays/RemoteScreenView.svelte`): macOS Screen
 * Sharing, or a Windows PC's VNC server, reached straight or through the relay (see
 * `m/remote/screen-connect.ts`) and drawn by the app's own RFB client (`app/native/src/rfb`, where
 * the messenger drives noVNC). Taps are clicks where the finger lands, two fingers a right click or a
 * scroll; in trackpad mode the glass moves a pointer instead. Smooth mode asks the Mac to lower its
 * resolution while connected. The row at the bottom has the keys a soft keyboard lacks.
 *
 * The state and the connection live in `remote-screen-controller.ts`, the picture and its gestures
 * in `remote-screen-stage.tsx`, the key row in `remote-screen-keys-row.tsx`; this is the header and
 * the page that holds them together.
 *
 * Not carried over: the page's own scrolling above a soft keyboard (`RemoteScreenPane` leaves it to
 * the window) and the haptic tick when a drag begins (NSH has none).
 */
import { cleanup, effect, pixelRatio, Text, View } from "nsh";
import { lifecycle } from "../../platform/lifecycle";
import { IconButton } from "../IconButton";
import { copy } from "../../runtime";
import { screenCopy } from "../../m/copy.ts";
import type { connectScreen } from "../../m/remote/screen-connect.ts";
import type { RememberedSignIn } from "../../m/remote/screen-sign-in.ts";
import { ScreenController, type ScreenViewApi } from "./remote-screen-controller.ts";
import { ScreenKeys } from "./remote-screen-keys-row.tsx";
import { ScreenStage } from "./remote-screen-stage.tsx";
import { TextButton } from "./remote-screen-parts.tsx";

export function RemoteScreenView(props: {
  api: ScreenViewApi;
  onClose: () => void;
  /** The Mac account kept on this phone after it once got in; absent, it is asked every time. */
  remember?: RememberedSignIn;
  /** Whose screen: a Mac's Screen Sharing, or a Windows PC's VNC server. */
  host?: "mac" | "windows";
  /** Tests hand in a stand-in. */
  connect?: typeof connectScreen;
  /** How often the page tells the Mac it is still here. */
  keepaliveMs?: number;
  /** How long Screen Sharing gets to answer once the channel is up, before the page gives up. */
  answerMs?: number;
}) {
  const host = props.host ?? "mac";
  const screen = new ScreenController({
    api: props.api,
    host,
    words: () => screenCopy(copy(), host),
    connect: props.connect,
    keepaliveMs: props.keepaliveMs,
    answerMs: props.answerMs,
    remember: props.remember,
  });
  const words = () => screen.words;
  const zoomed = () => screen.view().zoom > 1.01;
  const live = () => screen.phase() === "live";
  const active = () => live() || screen.phase() === "connecting" || screen.phase() === "signin";

  void screen.start();
  cleanup(() => screen.dispose());
  // Away from the screen the connection is let go, and comes back with the person.
  effect(() => screen.setBackground(lifecycle() === "background"));

  return (
    <View testID="screen-pane" class="flex-1 min-h-0 bg-pane">
      <View class="flex-row items-center gap-2 px-2 py-[6px] border-b border-line">
        <IconButton icon="chevron-left" size="lg" label={copy().common.back} testID="screen-back" onPress={props.onClose} />
        <View class="flex-1 min-w-0 flex-row items-center gap-2">
          <Text class="shrink text-[15px] font-semibold text-ink" style={{ numberOfLines: 1 }}>{words().title}</Text>
          <If when={live() ? screen.route() : null}>
            {(route: () => string) => (
              <View
                testID="screen-route"
                tooltip={route() === "relay" ? words().relayHint : undefined}
                class={`shrink-0 px-[6px] py-px rounded-full bg-accent-tint`}
              >
                <Text class="text-[11px] font-medium text-ink-muted">{route() === "relay" ? words().relay : words().direct}</Text>
              </View>
            )}
          </If>
        </View>
        <If when={live()}>
          <TextButton testID="screen-trackpad" pressed={screen.trackpad()} tooltip={words().trackpadTitle} onPress={() => screen.toggleTrackpad()}>
            {words().trackpad}
          </TextButton>
          <If
            when={host === "mac"}
            else={
              <TextButton
                testID="screen-ctrl-alt-del"
                label={words().ctrlAltDelLabel}
                small
                onPress={() => {
                  screen.takeArmed();
                  screen.ctrlAltDel();
                }}
              >
                <View class="items-center">
                  <Text class="text-[11px] leading-[1.15] text-ink">{words().ctrlAltDel.replace(/\+(?=[^+]*$)/, "\n").split("\n")[0]}</Text>
                  <Text class="text-[11px] leading-[1.15] text-ink">{words().ctrlAltDel.replace(/\+(?=[^+]*$)/, "\n").split("\n")[1] ?? ""}</Text>
                </View>
              </TextButton>
            }
          >
            <TextButton testID="screen-smooth" pressed={screen.smooth()} tooltip={words().smoothTitle} onPress={() => screen.toggleSmooth()}>
              {words().smooth}
            </TextButton>
          </If>
          <TextButton testID="screen-zoom" pressed={zoomed()} onPress={() => screen.toggleZoom(pixelRatio())}>
            {zoomed() ? words().fit : words().actualSize}
          </TextButton>
        </If>
        <If when={active()}>
          <TextButton testID="screen-disconnect" onPress={() => screen.disconnect()}>{words().disconnect}</TextButton>
        </If>
      </View>
      <ScreenStage screen={screen} />
      <If when={live()}>
        <ScreenKeys screen={screen} />
      </If>
    </View>
  );
}
