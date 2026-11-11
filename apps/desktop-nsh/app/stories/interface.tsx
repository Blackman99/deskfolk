/**
 * Your interface profile in an NSH window (ADR 0108): the window's controller wired as the shell
 * wires it, two real floors (a direct's Stop and an approval button), and what the profile does read
 * back as text — token values in the look shown, a span in the accent, the behaviour, a message
 * time, a changed word, why the window shows the default, the floors it failed, what the theme took.
 * The buttons on top change the profile the daemon keeps (one per run: tests put it back).
 */
import { Scroll, Text, token, View } from "nsh";
import type { InterfacePatch } from "@real-bot/protocol";
import { copy, runtime } from "../src/runtime";
import { formatMessageTime } from "../src/m/chat/chat-view.ts";
import { interfaceBehaviour, interfaceController } from "../src/m/interface/controller.svelte.ts";
import { Button } from "../src/ui/Button";
import { SendButton } from "../src/ui/chat/SendButton";
import { floorCount } from "../src/ui/interface/floor";
import { wireInterfaceHere } from "../src/ui/interface/look";
import { reduceMotion } from "../src/ui/interface/motion";
import { APP_THEME, roundTrip, themeOutcome } from "../src/ui/interface/theme";
import { ToastHost } from "../src/ui/ToastHost";

/** A sample a Bot might write: a violet accent and a paler pane, slower-reading times, ⌘↩ to send, still motion, one word. */
export const SAMPLE: InterfacePatch = {
  tokens: { light: { "--accent": "#7040c0", "--pane": "#fbf7ff", "--dur-fast": "60ms" }, dark: { "--accent": "#c0a0ff" } },
  behaviour: { time_format: "12h", send_key: "mod_enter", motion: "reduce" },
  copy: { zh: { "composer.send": "发出去" } },
};

const RESET: InterfacePatch = { reset: ["tokens", "behaviour", "css", "copy"], enabled: true };

function Chip(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View role="button" testID={props.id} onPress={props.onPress} class="px-2 py-1 border border-line rounded-(--radius-sm) bg-pane">
      <Text class="text-[11px] text-ink">{props.label}</Text>
    </View>
  );
}

const read = (name: string) => String((token as unknown as (name: string) => unknown)(name));

export default function InterfaceStory() {
  wireInterfaceHere({
    connected: () => runtime.connection === "connected",
    api: () => runtime.client,
    state: () => runtime.snapshot.interface ?? null,
    bots: () => runtime.snapshot.bots,
    t: () => copy(),
  });
  const edit = (patch: InterfacePatch) => () => void runtime.client?.patchInterface({ patch, reason: "interface story" });
  const line = (id: string, text: () => string) => <Text testID={id} class="text-[12px] text-ink">{text()}</Text>;

  return (
    <View class="flex-1 min-h-0 bg-bg">
      <ToastHost />
      <View class="flex-row flex-wrap gap-2 p-3 border-b border-line">
        <Chip id="apply-sample" label="sample" onPress={edit(RESET_THEN(SAMPLE))} />
        <Chip id="apply-floor-break" label="hide Stop" onPress={edit(RESET_THEN({ tokens: { light: { "--ink": "#ffffff" } }, copy: { zh: { "composer.send": "发出去" } } }))} />
        <Chip id="apply-hide-approve" label="hide Allow" onPress={edit(RESET_THEN({ tokens: { light: { "--on-accent": "#146a7c" } } }))} />
        <Chip id="apply-dark-break" label="hide Stop in dark" onPress={edit(RESET_THEN({ tokens: { dark: { "--btn-secondary-bg": APP_THEME.cssVars.dark.ink! } } }))} />
        <Chip id="apply-unreadable" label="unreadable" onPress={edit(RESET_THEN({ tokens: { light: { "--pane": "banana", "--accent": "#7040c0" } } }))} />
        <Chip id="apply-off" label="off" onPress={edit({ enabled: false })} />
        <Chip id="reset" label="reset" onPress={edit(RESET)} />
      </View>
      <Scroll class="flex-1" contentClass="p-4 gap-2">
        {line("revision", () => `revision=${runtime.snapshot.interface?.revision ?? "none"}`)}
        {line("token-brand", () => `brand=${read("brand")}`)}
        {line("token-primary", () => `primary=${read("primary")}`)}
        {line("token-you", () => `you=${read("you")}`)}
        {line("token-pane", () => `pane=${read("pane")}`)}
        {line("token-ink", () => `ink=${read("ink")}`)}
        {line("token-secondary", () => `secondary=${read("btn-secondary-bg")}`)}
        <Text testID="brand-ink" class="text-[13px] text-brand">brand-ink</Text>
        {line("behaviour", () => `behaviour=${JSON.stringify(interfaceBehaviour())}`)}
        {line("motion", () => `motion=${reduceMotion()}`)}
        {line("time", () => `time=${formatMessageTime("2026-11-07T15:04:00")}`)}
        {line("words", () => `words=${copy().composer.send}`)}
        {line("paused", () => `paused=${interfaceController.pausedBy ?? "none"}`)}
        {line("floors", () => `floors=${interfaceController.floorFailed.map((failure) => failure.floor).join(",")}`)}
        {line("floor-why", () => `why=${interfaceController.floorFailed.map((failure) => failure.why).join(";")}`)}
        {line("outcome", () => `outcome=${JSON.stringify(themeOutcome())}`)}
        {line("round-trip", () => `roundtrip=${roundTrip()}`)}
        {line("floor-count", () => `marked=${floorCount()}`)}
        <View class="flex-row items-center gap-3 p-3 rounded-(--radius-md) bg-pane">
          <SendButton
            connected={true}
            primaryAction={{ kind: "send", disabled: true }}
            directStop={true}
            stepsAside={false}
            sending={false}
            upload={undefined}
            onStop={() => {}}
            onSend={() => {}}
          />
          <Button testID="story-approve" floor="approval" variant="primary" icon="check">
            {copy().stream.allowOnce}
          </Button>
        </View>
      </Scroll>
    </View>
  );
}

/** Each change starts from the defaults, so a sample never carries the last one's tokens. */
function RESET_THEN(patch: InterfacePatch): InterfacePatch {
  return { ...patch, reset: ["tokens", "behaviour", "css", "copy"], enabled: true };
}
