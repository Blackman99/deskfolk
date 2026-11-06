/**
 * The black stage the picture is shown on (`.screen-stage` of `RemoteScreenView.svelte`): the
 * picture's box placed by zoom and pan and made of 256-pixel tiles (`ScreenSession`), the trackpad
 * pointer, the tip and transfer lines over it, and what covers it before it is live: the wait, the
 * sign-in form, the ended and failed notes.
 */
import { Image, Text, View, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { boxFor } from "../../m/overlays/screen-zoom.ts";
import type { ScreenController } from "./remote-screen-controller.ts";
import { screenGestures } from "./remote-screen-gestures.ts";
import type { Tile } from "./remote-screen-session.ts";

/** Its tip is at (2, 2) in the 20 × 24 box. */
const ARROW = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" viewBox="-2 -2 20 24"><path d="M0 0v16.5l4.4-4.2 3 6.8 2.8-1.2-2.9-6.7h6.2z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const ARROW_URI = `data:image/svg+xml,${encodeURIComponent(ARROW)}`;

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

function TileImage(props: { tile: Tile; scale: () => number }) {
  // Each edge rounds on its own so neighbours meet with no seam however the zoom falls.
  const left = () => Math.floor(props.tile.x * props.scale());
  const top = () => Math.floor(props.tile.y * props.scale());
  return (
    <Image
      testID={`screen-tile-${props.tile.x}-${props.tile.y}`}
      src={props.tile.uri()}
      fadeDuration={0}
      style={{
        position: "absolute",
        left: left(),
        top: top(),
        width: Math.ceil((props.tile.x + props.tile.w) * props.scale()) - left(),
        height: Math.ceil((props.tile.y + props.tile.h) * props.scale()) - top(),
      }}
    />
  );
}

function SignIn(props: { screen: ScreenController }) {
  const screen = props.screen;
  const words = () => screen.words;
  const ready = () => screen.password().length > 0 && (!screen.needsUsername() || screen.username().trim().length > 0);
  const submit = () => {
    if (ready()) screen.signIn();
  };
  const field = "h-[40px] px-[10px] text-[16px] text-ink bg-input-bg border border-line rounded-(--radius-sm)";
  return (
    <View testID="screen-signin" class="absolute inset-0 bg-pane items-center justify-center p-6">
      <View class="w-full max-w-[360px] gap-3">
        <Text role="header" class="text-[17px] font-semibold text-ink">{words().signInTitle}</Text>
        <Text class="text-[13px] text-ink-muted">{words().signInHint}</Text>
        <If when={screen.problem()}>
          {(problem: () => string) => (
            <Text role="alert" testID="screen-problem" class="text-[13px] text-danger-text">{problem()}</Text>
          )}
        </If>
        <If when={screen.needsUsername()}>
          <View class="gap-1">
            <Text class="text-[13px] text-ink-muted">{words().username}</Text>
            <Input
              testID="screen-username"
              value={screen.username()}
              onChange={(e) => screen.username.set(e.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect={false}
              class={field}
            />
          </View>
        </If>
        <View class="gap-1">
          <Text class="text-[13px] text-ink-muted">{words().password}</Text>
          <Input
            testID="screen-password"
            value={screen.password()}
            onChange={(e) => screen.password.set(e.value)}
            onSubmit={submit}
            masked
            autoComplete="current-password"
            class={field}
          />
        </View>
        <If when={screen.remember}>
          <Checkbox testID="screen-keep" checked={screen.keepSignIn()} onChange={(on) => screen.keepSignIn.set(on)} label={words().keepSignIn} />
        </If>
        <Button testID="screen-submit" variant="primary" size="lg" disabled={!ready()} onPress={submit}>{words().signIn}</Button>
      </View>
    </View>
  );
}

export function ScreenStage(props: { screen: ScreenController }) {
  const screen = props.screen;
  const words = () => screen.words;
  let stage: ViewRef | undefined;
  const gestures = screenGestures(screen, () => stage);
  const box = () => {
    const frame = screen.frame();
    const size = screen.stage();
    return frame && size.w && size.h ? boxFor(size, frame, screen.view()) : null;
  };
  const scale = () => {
    const frame = screen.frame();
    const b = box();
    return frame && b ? b.width / frame.w : 1;
  };
  return (
    <View
      ref={(node) => (stage = node)}
      testID="screen-stage"
      class="flex-1 min-h-0 overflow-hidden bg-black"
      onLayout={(e) => {
        screen.stage.set({ w: e.bounds.size.width, h: e.bounds.size.height });
        void stage?.measure().then((m) => m && gestures.measured(m.pagePosition));
      }}
      {...gestures.panHandlers}
    >
      <If when={screen.phase() === "live" ? box() : null}>
        {() => (
          <View
            testID="screen-canvas"
            style={{ pointerEvents: "none", position: "absolute", left: box()!.left, top: box()!.top, width: box()!.width, height: box()!.height }}
          >
            <Each of={screen.tiles()} key={(t: Tile) => t.key}>
              {(tile: () => Tile) => <TileImage tile={tile()} scale={scale} />}
            </Each>
          </View>
        )}
      </If>
      <If when={screen.phase() === "live" ? screen.pointerShown() : null}>
        {() => {
          const at = () => screen.pointerShown()!;
          return (
            <View testID="screen-pointer" style={{ pointerEvents: "none", position: "absolute", left: at().x - 2, top: at().y - 2, width: 20, height: 24 }}>
              <If when={screen.dragging()}>
                <View
                  class="absolute border-2 border-white rounded-full bg-brand/55"
                  style={{ left: -10, top: -10, width: 24, height: 24 }}
                />
              </If>
              <Image src={ARROW_URI} style={{ width: 20, height: 24 }} />
            </View>
          );
        }}
      </If>
      <If when={screen.phase() === "live" ? screen.tip() : null}>
        {(tip: () => string) => (
          <View role="text" style={{ pointerEvents: "none" }} testID="screen-tip" class="absolute top-3 self-center max-w-[90%] px-3 py-[6px] rounded-[12px] bg-black/70">
            <Text class="text-[12px] leading-[1.5] text-white text-center">{tip()}</Text>
          </View>
        )}
      </If>
      <If when={screen.phase() === "live" ? screen.transfer() : null}>
        {(transfer: () => { total: number; rate: number }) => (
          <View role="text" style={{ pointerEvents: "none" }} testID="screen-transfer" class="absolute bottom-3 self-center px-[10px] py-1 rounded-full bg-black/60">
            <Text class="text-[12px] text-white">{words().receiving(megabytes(transfer().total), megabytes(transfer().rate))}</Text>
          </View>
        )}
      </If>
      <If when={screen.phase() === "connecting"}>
        <View role="text" testID="screen-note" class="absolute inset-0 bg-pane items-center justify-center gap-3 p-6">
          <Text class="text-[14px] text-ink text-center">
            {screen.step() === "loading" ? words().loading : screen.step() === "linking" ? words().linking : words().waitingMac}
          </Text>
        </View>
      </If>
      <If when={screen.phase() === "signin"}>
        <SignIn screen={screen} />
      </If>
      <If when={screen.phase() === "ended" || screen.phase() === "failed" || screen.phase() === "paused"}>
        <View role="text" testID="screen-note" class="absolute inset-0 bg-pane items-center justify-center gap-3 p-6">
          <Text class="text-[14px] text-ink text-center">
            {screen.phase() === "failed" ? (screen.problem() ?? "") : screen.phase() === "paused" ? words().paused : words().ended}
          </Text>
          <Button testID="screen-reconnect" variant="primary" size="lg" onPress={() => void screen.start()}>{words().reconnect}</Button>
        </View>
      </If>
    </View>
  );
}
