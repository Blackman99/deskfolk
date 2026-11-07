/**
 * A new build is worth a line, not a takeover (`BuildUpdateNotice.svelte`): a pill along the bottom
 * of the window offering a reload, which can be waved off. `updates` is the mirrored `BuildUpdates`;
 * `onReload` is what "reload" does here (a page's `location.reload()` has no counterpart in NSH).
 */
import { Overlay, safeArea, Text, View } from "nsh";
import type { BuildUpdates } from "../m/build-version.svelte.ts";
import { copy } from "../runtime";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { shadow } from "./styles";
import { widthAtMost } from "../platform/viewport";

export function BuildUpdateNotice(props: { updates: BuildUpdates; onReload: () => void }) {
  const phone = () => widthAtMost(680);
  return (
    <If when={props.updates.offered}>
      <Overlay class="left-0 right-0 items-center" style={{ bottom: safeArea().bottom + (phone() ? 72 : 16) }}>
        <View
          testID="build-update"
          role="alert"
          class={`flex-row items-center bg-pane border border-line rounded-full pl-[14px] ${phone() ? "gap-2 py-1 pr-1" : "gap-[10px] py-[6px] pr-[6px]"}`}
          style={{ boxShadow: shadow("lg") }}
        >
          <View class="w-[7px] h-[7px] rounded-full bg-brand" accessible={false} />
          <Text class="text-[13px] font-medium text-ink line-clamp-1">{copy().common.updateReady}</Text>
          <View
            role="button"
            testID="build-update-reload"
            onPress={() => props.onReload()}
            class={`px-[14px] rounded-full bg-brand hover:bg-accent-hover items-center justify-center ${phone() ? "h-[44px] px-[18px]" : "h-[30px]"}`}
          >
            <Text class="text-[13px] font-semibold text-on-accent">{copy().common.updateReload}</Text>
          </View>
          <IconButton
            icon="x"
            size={phone() ? "lg" : "sm"}
            label={copy().common.close}
            testID="build-update-dismiss"
            class="rounded-full"
            onPress={() => props.updates.dismiss()}
          />
        </View>
      </Overlay>
    </If>
  );
}
