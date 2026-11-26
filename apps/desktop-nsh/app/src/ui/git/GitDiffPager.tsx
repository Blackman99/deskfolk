/**
 * Diff viewer paired with a narrow/mobile bottom Prev/Next file pager (`‹ 上一个 · 3 / 14 · 下一个 ›`),
 * shared by `GitChangesView` (depth 1) and `GitGraphView` (depth 2) (ADR 0118).
 */
import type { GitDiffResponse } from "@real-bot/protocol";
import { safeArea, Text, View } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { GitDiffViewer } from "./GitDiffViewer";
import type { GitHost } from "./git-levels";

export function GitDiffPager(props: {
  diff: GitDiffResponse | null;
  loading: boolean;
  error: string | null;
  emptyHint?: string;
  host?: GitHost;
  narrow?: boolean;
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  onOpenPreview?: (relpath: string) => void;
  onLoadFull?: () => void;
  onBack?: () => void;
}) {
  const t = () => copy();
  const showPager = () => props.narrow === true && props.total > 1;
  const hasPrev = () => props.index > 0;
  const hasNext = () => props.index >= 0 && props.index < props.total - 1;

  return (
    <View testID="git-diff-pager" class="flex-1 min-h-0 min-w-0 bg-pane">
      <GitDiffViewer
        diff={props.diff}
        loading={props.loading}
        error={props.error}
        emptyHint={props.emptyHint}
        host={props.host}
        narrow={props.narrow}
        onOpenPreview={props.onOpenPreview}
        onLoadFull={props.onLoadFull}
        onBack={props.onBack}
      />
      <If when={showPager()}>
        <View
          testID="git-diff-pager-bar"
          class="flex-row items-center justify-between px-[8px] border-t border-line bg-sidebar-bg shrink-0"
          style={{
            minHeight: 44 + (props.host === "page" ? safeArea().bottom : 0),
            paddingBottom: props.host === "page" ? safeArea().bottom : 0,
          }}
        >
          <View
            role="button"
            testID="git-diff-prev"
            accessibilityLabel={t().git.prevFile}
            disabled={!hasPrev()}
            onPress={() => {
              if (hasPrev()) props.onPrev?.();
            }}
            class="cursor-pointer select-none disabled:cursor-default disabled:opacity-[0.4] flex-row items-center gap-[4px] px-[10px] h-[36px] rounded-(--radius-control-sm) active:bg-row-hover hover:bg-row-hover"
          >
            <Icon name="chevron-left" size={16} class="tint-ink-secondary" />
            <Text class="text-[13px] font-medium text-ink">{t().git.prevFile}</Text>
          </View>
          <Text testID="git-diff-pager-pos" class="font-mono text-[12px] text-ink-muted">
            {`${Math.max(1, props.index + 1)} / ${props.total}`}
          </Text>
          <View
            role="button"
            testID="git-diff-next"
            accessibilityLabel={t().git.nextFile}
            disabled={!hasNext()}
            onPress={() => {
              if (hasNext()) props.onNext?.();
            }}
            class="cursor-pointer select-none disabled:cursor-default disabled:opacity-[0.4] flex-row items-center gap-[4px] px-[10px] h-[36px] rounded-(--radius-control-sm) active:bg-row-hover hover:bg-row-hover"
          >
            <Text class="text-[13px] font-medium text-ink">{t().git.nextFile}</Text>
            <Icon name="chevron-right" size={16} class="tint-ink-secondary" />
          </View>
        </View>
      </If>
    </View>
  );
}
