/**
 * Above the box while the microphone is on or its text is coming, and what went wrong if it did
 * (`VoiceStatus.svelte`, ADR 0073): a pulsing dot and the running clock with a way to discard the
 * recording, "transcribing…", or the notice with a way to put it away.
 */
import { Text, View } from "nsh";
import type { ComposerVoice } from "../../m/chat/composer-voice.svelte";
import { formatClock } from "../../m/chat/voice-recorder";
import { copy } from "../../runtime";

export function VoiceStatus(props: { voice: ComposerVoice }) {
  const act = (label: string, onPress: () => void, testID: string) => (
    <View role="button" testID={testID} accessibilityLabel={label} onPress={onPress} class="shrink-0 px-2 py-[2px] rounded-(--radius-sm) hover:bg-line-subtle group">
      <Text class="text-[12px] font-medium text-ink-secondary group-hover:text-ink">{label}</Text>
    </View>
  );
  return (
    <If
      when={props.voice.phase !== "idle"}
      else={
        <If when={props.voice.notice}>
          {(notice) => (
            <View role="alert" testID="voice-notice" class="flex-row items-center gap-2 px-1 pt-[2px] pb-[6px] min-w-0">
              <Text class="flex-1 min-w-0 text-[12px] text-warn-text">{notice()}</Text>
              {act(copy().speech.dismiss, () => props.voice.dismiss(), "voice-dismiss")}
            </View>
          )}
        </If>
      }
    >
      <View role="text" testID="voice-status" accessibilityLabel={props.voice.phase} class="flex-row items-center gap-2 px-1 pt-[2px] pb-[6px] min-w-0">
        <If when={props.voice.phase !== "transcribing"}>
          <View accessible={false} class="shrink-0 w-[8px] h-[8px] rounded-full bg-danger animate-pulse" />
        </If>
        <Text class="flex-1 min-w-0 text-[12px] text-ink-secondary">
          {props.voice.phase === "transcribing" ? copy().speech.transcribing : copy().speech.recording(formatClock(props.voice.seconds))}
        </Text>
        {act(copy().speech.micCancel, () => props.voice.cancel(), "voice-cancel")}
      </View>
    </If>
  );
}
