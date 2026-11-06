/**
 * The composer's microphone (`VoiceButton.svelte`, ADR 0073): press to record, press again to stop
 * and transcribe. It drives the runtime's `ComposerVoice`, which records through a `VoiceRecorder`
 * and has the daemon's speech endpoint transcribe it; while listening it is a stop button in red
 * with a ring that breathes with the level.
 */
import { View } from "nsh";
import type { ComposerVoice } from "../../m/chat/composer-voice.svelte";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

export function VoiceButton(props: { voice: ComposerVoice; disabled: boolean }) {
  const listening = () => props.voice.phase === "recording" || props.voice.phase === "starting";
  const busy = () => props.voice.phase === "transcribing" || props.voice.phase === "starting";
  const label = () => {
    const t = copy().speech;
    return listening() ? t.micStop : props.voice.phase === "transcribing" ? t.transcribing : t.micStart;
  };
  const level = () => Math.max(0, Math.min(1, props.voice.level));
  return (
    <View
      role="button"
      testID="voice-button"
      tooltip={tip(label())}
      accessibilityLabel={label()}
      accessibilityState={{ selected: listening(), busy: busy(), disabled: props.voice.phase === "transcribing" || (props.disabled && props.voice.phase === "idle") }}
      disabled={props.voice.phase === "transcribing" || (props.disabled && props.voice.phase === "idle")}
      onPress={() => void props.voice.toggle()}
      class={`group shrink-0 items-center justify-center rounded-full active:scale-[0.96] disabled:opacity-[0.4] ${narrowWindow() ? "w-[40px] h-[40px]" : "w-[34px] h-[34px]"} ${listening() ? "bg-danger-bg" : "hover:bg-line-subtle"}`}
    >
      <If when={listening()}>
        <View
          accessible={false}
          class="absolute -inset-[2px] rounded-full border-2 border-danger"
          style={{ opacity: 0.25 + level() * 0.75, transform: `scale(${1 + level() * 0.18})`, pointerEvents: "none" }}
        />
      </If>
      <If when={props.voice.phase === "transcribing"} else={
        <If when={listening()} else={<Icon name="mic" size={20} class="tint-ink-muted group-hover:tint-ink" />}>
          <Icon name="stop" class="tint-danger" />
        </If>
      }>
        <Icon name="spinner" class="animate-spin tint-brand" />
      </If>
    </View>
  );
}
