/**
 * Where `showToast` puts its notice (`ToastHost.svelte`): one card in the top-right corner, just
 * under the pane tabs (the top of the window on a phone), the store being `src/m/toast.svelte.ts`.
 * A pointer on the card or focus in it holds the countdown; ✕ closes it; an action runs and closes.
 */
import { Overlay, safeArea, Text, View } from "nsh";
import { toasts, type ToastTone } from "../m/toast.svelte.ts";
import { copy } from "../runtime";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { shadow } from "./styles";
import { widthAtMost } from "../platform/viewport";

const GLYPHS: Record<ToastTone, IconName> = { neutral: "check-circle", info: "info", error: "alert-circle" };
const TINT: Record<ToastTone, string> = { neutral: "tint-ok", info: "tint-ink-muted", error: "tint-danger" };

export function ToastHost() {
  const phone = () => widthAtMost(680);
  return (
    <If when={toasts.current}>
      {(toast) => (
        <Overlay
          class={phone() ? "left-[12px] right-[12px]" : "right-[16px] w-[360px]"}
          style={{ top: safeArea().top + (phone() ? 8 : 48) }}
        >
          <View
            testID="toast"
            role="alert"
            accessibilityLabel={toast().text}
            onMouseEnter={() => toasts.hold("pointer")}
            onMouseLeave={() => toasts.release("pointer")}
            onFocus={() => toasts.hold("focus")}
            onBlur={() => toasts.release("focus")}
            class={`flex-row items-start gap-[10px] bg-pane border rounded-(--radius-lg) pl-3 pr-2 py-2 transition-opacity duration-[180ms] ${toast().leaving ? "opacity-0" : "opacity-100"} ${toast().tone === "error" ? "border-danger-line" : "border-line"}`}
            style={{ boxShadow: shadow("menu") }}
          >
            <View class={`items-center justify-center ${phone() ? "h-[40px]" : "h-[28px]"}`} accessible={false}>
              <Icon name={GLYPHS[toast().tone]} size={16} class={TINT[toast().tone]} />
            </View>
            <Text testID="toast-text" class={`flex-1 min-w-0 text-[13px] font-medium text-ink leading-[20px] line-clamp-3 ${phone() ? "py-[10px]" : "py-[4px]"}`}>
              {toast().text}
            </Text>
            <If when={toast().action}>
              {(action) => (
                <View
                  role="button"
                  testID="toast-action"
                  onPress={() => {
                    action().run();
                    toasts.dismiss();
                  }}
                  class={`cursor-pointer select-none px-[10px] rounded-(--radius-sm) items-center justify-center hover:bg-accent-tint ${phone() ? "h-[40px]" : "h-[28px]"}`}
                >
                  <Text class="text-[13px] font-semibold text-brand">{action().label}</Text>
                </View>
              )}
            </If>
            <IconButton
              icon="x"
              size={phone() ? "lg" : "sm"}
              label={copy().common.close}
              testID="toast-close"
              class="rounded-full"
              onPress={() => toasts.dismiss()}
            />
          </View>
        </Overlay>
      )}
    </If>
  );
}
