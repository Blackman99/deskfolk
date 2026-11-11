/**
 * What a window shows before its first connection (`routes/+page.svelte`'s `.disconnected` screen):
 * the mark and "connecting to the runtime…" with a turning ring while an attempt is under way, or
 * "can't reach the runtime" with a Retry once it has failed. The shell is not mounted until the
 * first snapshot has arrived: on the empty snapshot before it, `wizard_complete` is false, and the
 * shell would show the first-run onboarding for a moment on every start.
 *
 * Only an attempt in progress turns: a host that could not be reached waits for Retry, and a ring
 * turning over "unreachable" said the opposite of the line under it.
 */
import { Text, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { BrandMark } from "../BrandMark";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { reduceMotion } from "../interface/motion";

export function ConnectionScreen() {
  const t = () => copy().disconnected;
  const host = () => runtime.hostUnreachable === "host";
  const connecting = () => runtime.connection === "connecting";
  return (
    <View
      testID={connecting() ? "connecting" : "unreachable"}
      class="flex-1 flex-col items-center justify-center gap-[12px] bg-bg px-6"
    >
      <BrandMark size={48} />
      <Text class="text-center text-[15px] font-semibold text-ink-muted">
        {connecting() ? (host() ? t().connectingHost : t().connecting) : host() ? t().host : t().message}
      </Text>
      <If when={connecting()}>
        <Icon name="spinner" size={20} class={`tint-brand ${reduceMotion() ? "" : "animate-spin"}`} />
      </If>
      <If when={!connecting() && host()}>
        <Text class="max-w-[448px] text-center text-[13px] font-medium leading-[1.45] text-ink-muted">{t().hostHint}</Text>
      </If>
      <If when={!connecting()}>
        <Button testID="retry-connection" size="lg" onPress={() => runtime.retryConnection()}>
          {t().retry}
        </Button>
      </If>
    </View>
  );
}
