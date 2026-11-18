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
import { Overlay, safeArea, Text, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { BrandMark } from "../BrandMark";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { reduceMotion } from "../interface/motion";
import { shadow } from "../styles";

export function ConnectionScreen() {
  const t = () => copy().disconnected;
  const host = () => runtime.hostUnreachable === "host";
  const connecting = () => runtime.connection === "connecting";
  return (
    // The whole screen moves the window (no title bar on Windows and Linux); Retry keeps its press.
    <View
      testID={connecting() ? "connecting" : "unreachable"}
      desktop={{ windowDrag: true }}
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

/**
 * The phone's page open in another tab too (`routes/+page.svelte`'s `tab-standby`): one tab holds the
 * device's link to the relay at a time, and this one waits behind it until it is asked to take over.
 * A takeover the other tab does not answer in time says so.
 */
export function TabStandbyScreen() {
  const t = () => copy().notifications;
  return (
    <View testID="tab-standby" class="flex-1 flex-col items-center justify-center gap-[12px] bg-bg px-6">
      <BrandMark size={48} />
      <Text class="max-w-[448px] text-center text-[15px] font-semibold text-ink-muted">{t().tabTakeoverNotice}</Text>
      <Button testID="tab-takeover" size="lg" onPress={() => void runtime.requestTabTakeover()}>
        {t().tabTakeoverButton}
      </Button>
      <If when={runtime.tabTakeoverTimeout}>
        <Text class="max-w-[448px] text-center text-[13px] font-medium leading-[1.45] text-ink-muted">{t().tabTakeoverTimeout}</Text>
      </If>
    </View>
  );
}

/**
 * A connection lost once the shell has been up (`routes/+page.svelte`'s offline veil and banner):
 * the shell stays where it was, faded under a veil that takes its presses, and a pill at the top
 * says what is going on, "connecting…" with a turning ring, or "can't reach" with Retry. A phone
 * loses the link each time the page goes to the background; without this the shell looked live
 * while nothing it did went anywhere.
 */
export function OfflineBanner() {
  const t = () => copy().disconnected;
  const host = () => runtime.hostUnreachable === "host";
  const connecting = () => runtime.connection === "connecting";
  return (
    <If when={runtime.connection !== "connected"}>
      <Overlay class="left-0 top-0 right-0 bottom-0 items-center bg-bg/45">
        <View
          role="alert"
          testID={connecting() ? "connecting" : "unreachable"}
          class={`flex-row items-center gap-[10px] min-h-[44px] max-w-[560px] mx-3 rounded-full bg-pane border border-warn-line py-[6px] ${connecting() ? "pl-4 pr-4" : "pl-[18px] pr-[6px]"}`}
          style={{ marginTop: safeArea().top + 10, boxShadow: shadow("lg") }}
        >
          <If when={connecting()}>
            <Icon name="spinner" size={16} class={`tint-brand ${reduceMotion() ? "" : "animate-spin"}`} />
          </If>
          <Text class="shrink text-[13px] font-semibold text-ink">
            {connecting() ? (host() ? t().connectingHost : t().connecting) : host() ? t().host : t().message}
          </Text>
          <If when={!connecting()}>
            <Button testID="retry-connection" size="sm" onPress={() => runtime.retryConnection()}>
              {t().retry}
            </Button>
          </If>
        </View>
      </Overlay>
    </If>
  );
}
