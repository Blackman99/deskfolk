/**
 * The composer's send button (`SendButton.svelte`), and beside it a direct's own Stop while its Bot
 * has a turn going here. The main button is Send (the accent), Stop (ink) while a reply is the main
 * thing to stop, greyed into the accent's tint with nothing to send, and busy once a send has been
 * in flight past `SENDING_SHOW_MS`: then a spinner, or a ring filling clockwise from twelve o'clock
 * as the files go out. Where the composer is narrow it steps aside, with nothing to send, for what
 * can be pressed instead. `data-floor` has no NSH counterpart and is left out.
 */
import { Canvas, effect, signal, token, View } from "nsh";
import type { ComposerAction } from "../../m/chat/composer-mode";
import { interfaceBehaviour } from "../../m/interface/behaviour.svelte";
import { formatShortcut } from "../../m/keymap";
import type { SessionView } from "../../m/session-view.svelte";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { narrowWindow } from "../Modal";

/** A send the machine next door answers at once shows nothing; one still on its way after this long says so on the button. */
export const SENDING_SHOW_MS = 250;
const RING_RADIUS = 8;

/** 0–1 across every file of the send in flight, once the link reports it; null with no files. */
export function uploadFractionOf(upload: SessionView["upload"] | undefined): number | null {
  if (!upload) return null;
  const total = upload.files.reduce((n, file) => n + file.size, 0);
  return total > 0 ? Math.min(1, upload.loaded / total) : null;
}

export function SendButton(props: {
  connected: boolean;
  primaryAction: ComposerAction;
  /** A direct's one Stop, beside Send while its Bot has a turn going here. */
  directStop: boolean;
  /** Greyed with nothing to send while something else can be pressed: gone where the composer is narrow. */
  stepsAside: boolean;
  /** A send from this conversation is in flight. */
  sending: boolean | undefined;
  /** The files of the send in flight and how many of their bytes have gone out. */
  upload: SessionView["upload"] | undefined;
  onStop: () => void;
  onSend: () => void;
}) {
  const sendingShown = signal(false);
  effect(() => {
    if (!props.sending) {
      sendingShown.set(false);
      return;
    }
    const timer = setTimeout(() => sendingShown.set(true), SENDING_SHOW_MS);
    return () => clearTimeout(timer);
  });
  const fraction = () => uploadFractionOf(props.upload);
  const kind = () => props.primaryAction.kind;
  const busy = () => kind() === "send" && sendingShown();
  const size = () => (narrowWindow() ? "w-[40px] h-[40px]" : "w-[34px] h-[34px]");
  const label = () => {
    const t = copy();
    return kind() === "stop" ? t.composer.stopGeneration : sendingShown() ? t.composer.sending : t.composer.send;
  };
  const hint = () => {
    const t = copy();
    if (kind() === "stop") return t.composer.stopGeneration;
    if (sendingShown()) return t.composer.sending;
    return interfaceBehaviour().send_key === "mod_enter" ? t.composer.modSendShortcut(formatShortcut(["mod", "Enter"])) : t.chat.sendHintShortcut;
  };
  /** The look: Stop in ink, Send in the accent, the disabled Send in the accent's tint (kept solid while it is sending). */
  const look = () => {
    const disabled = props.primaryAction.disabled;
    if (kind() === "stop") return { bg: "bg-ink hover:bg-ink-secondary", tint: "tint-pane" };
    if (disabled && !busy()) return { bg: "bg-accent-tint", tint: "tint-brand opacity-[0.55]" };
    return { bg: "bg-brand hover:bg-accent-hover", tint: "tint-on-accent" };
  };

  return (
    <>
      <If when={props.directStop}>
        <View
          role="button"
          testID="stop-button"
          tooltip={tip(copy().composer.stopGeneration)}
          accessibilityLabel={copy().composer.stopGeneration}
          disabled={!props.connected}
          onPress={() => props.onStop()}
          class={`shrink-0 items-center justify-center rounded-full bg-ink hover:bg-ink-secondary active:scale-[0.92] disabled:opacity-[0.5] ${size()}`}
        >
          <Icon name="stop" class="tint-pane" />
        </View>
      </If>
      <If when={!props.stepsAside}>
        <View
          role="button"
          testID="send-button"
          tooltip={tip(hint())}
          accessibilityLabel={label()}
          accessibilityState={{ busy: busy(), disabled: props.primaryAction.disabled }}
          disabled={props.primaryAction.disabled}
          onPress={() => (kind() === "stop" ? props.onStop() : props.onSend())}
          class={`shrink-0 items-center justify-center rounded-full active:scale-[0.92] ${size()} ${look().bg} ${props.directStop && narrowWindow() ? "ml-1" : ""}`}
        >
          <If when={kind() === "stop"} else={<SendGlyph busy={busy()} fraction={fraction()} tint={look().tint} />}>
            <Icon name="stop" class={look().tint} />
          </If>
        </View>
      </If>
    </>
  );
}

function SendGlyph(props: { busy: boolean; fraction: number | null; tint: string }) {
  return (
    <If when={props.busy && props.fraction !== null} else={
      <If when={props.busy} else={<Icon name="arrow-up" class={props.tint} />}>
        <Icon name="spinner" class={`animate-spin ${props.tint}`} />
      </If>
    }>
      <Canvas
        testID="send-progress"
        accessible={false}
        style={{ width: 20, height: 20 }}
        draw={(cx, size) => {
          const ink = String(token("on-accent"));
          const c = size.width / 2;
          const start = -Math.PI / 2;
          cx.lineWidth = 2;
          cx.lineCap = "round";
          cx.globalAlpha = 0.35;
          cx.strokeStyle = ink;
          cx.beginPath();
          cx.arc(c, c, RING_RADIUS, 0, Math.PI * 2);
          cx.stroke();
          cx.globalAlpha = 1;
          const done = props.fraction ?? 0;
          if (done > 0) {
            cx.beginPath();
            cx.arc(c, c, RING_RADIUS, start, start + Math.PI * 2 * done);
            cx.stroke();
          }
        }}
      />
    </If>
  );
}
