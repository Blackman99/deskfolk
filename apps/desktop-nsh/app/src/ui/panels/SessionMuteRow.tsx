/**
 * The conversation's mute (`SessionMuteRow.svelte`): its replies and routine results stop raising
 * system notifications, while approvals, questions and failures still do. A row of a group's
 * actions, or of a Bot's actions in your direct.
 */
import { Text, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { Switch } from "../Switch";

export function SessionMuteRow(props: { sessionId: string }) {
  return (
    <View testID="session-mute" class="flex-row items-center justify-between gap-[14px]">
      <View class="flex-1 min-w-0 gap-[2px]">
        <Text class="text-[13px] font-semibold text-ink">{copy().notifications.sessionMute}</Text>
        <Text class="text-[12px] text-ink-muted">{copy().notifications.sessionMuteBody}</Text>
      </View>
      <Switch
        testID="session-mute-switch"
        label={copy().notifications.sessionMute}
        checked={runtime.isSessionMuted(props.sessionId)}
        onChange={(checked) => void runtime.setSessionMuted(props.sessionId, checked)}
      />
    </View>
  );
}
