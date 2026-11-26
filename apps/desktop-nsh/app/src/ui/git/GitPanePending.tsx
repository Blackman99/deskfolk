/**
 * Lightweight first-load stand-in for `GitPane` while its lazy chunk downloads on a phone/web page.
 * Renders a 48px back bar (with top safe-area inset) so slow networks never trap the user on a
 * blank screen; desktop workbench panes render nothing while loading (matching other lazy views).
 */
import { safeArea, Text, View } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";

export function GitPanePending(props: { host?: "pane" | "page"; onClose?: () => void }) {
  if (props.host !== "page") return <View class="flex-1 min-h-0" />;
  const t = () => copy();
  return (
    <View testID="git-page-pending" class="flex-1 min-h-0 bg-pane">
      <View
        class="flex-row items-center px-[4px] border-b border-line shrink-0"
        style={{ paddingTop: safeArea().top, height: 48 + safeArea().top }}
      >
        <View
          role="button"
          testID="git-page-pending-back"
          accessibilityLabel={t().common.back}
          onPress={() => props.onClose?.()}
          class="cursor-pointer select-none items-center justify-center w-[44px] h-[44px] rounded-(--radius-control-sm) active:bg-row-hover"
        >
          <Icon name="chevron-left" size={20} class="tint-ink-secondary" />
        </View>
        <Text class="text-[16px] font-semibold text-ink px-[6px]">{t().git.title}</Text>
      </View>
      <View class="flex-1 items-center justify-center p-6">
        <Text class="text-[13px] text-ink-muted">{t().git.loading}</Text>
      </View>
    </View>
  );
}
