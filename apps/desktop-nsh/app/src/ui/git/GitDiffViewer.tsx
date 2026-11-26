/**
 * Single-file diff viewer wrapping `nsh/base`'s native `DiffView` (ADR 0118).
 * Provides split/unified layout switch, soft wrap toggle, binary/truncation states, and a shortcut
 * to open the full file in Deskfolk's artifact preview.
 */
import type { GitDiffResponse } from "@real-bot/protocol";
import { signal, Text, View } from "nsh";
import { DiffView } from "nsh/base";
import { baseName } from "../../m/paths.ts";
import { copy } from "../../runtime";
import { codeSurface } from "../code-colors";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { tip } from "../tip";

export function GitDiffViewer(props: {
  diff: GitDiffResponse | null;
  loading: boolean;
  error: string | null;
  emptyHint?: string;
  onOpenPreview?: (relpath: string) => void;
  onBack?: () => void;
}) {
  const t = () => copy();
  const layout = signal<"split" | "unified">("unified");
  const softWrap = signal(true);
  const surface = () => codeSurface();

  const togglePill = (id: string, label: string, active: boolean, onPress: () => void) => (
    <View
      role="button"
      testID={id}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      class={`cursor-pointer select-none px-[8px] h-[24px] rounded-(--radius-control-sm) items-center justify-center ${
        active ? "bg-accent-tint" : "hover:bg-row-hover"
      }`}
    >
      <Text class={`text-[11px] font-medium ${active ? "text-brand" : "text-ink-muted"}`}>{label}</Text>
    </View>
  );

  return (
    <View testID="git-diff-viewer" class="flex-1 min-h-0 min-w-0 bg-pane">
      <If when={props.diff}>
        {(d) => (
          <View class="flex-row items-center gap-[6px] px-[10px] h-[36px] shrink-0 border-b border-line-subtle bg-sidebar-bg">
            <If when={props.onBack}>
              <View
                role="button"
                testID="git-diff-back"
                accessibilityLabel={t().git.graph.backToList}
                onPress={() => props.onBack?.()}
                class="cursor-pointer select-none flex-row items-center gap-[4px] px-[6px] h-[24px] rounded-(--radius-control-sm) hover:bg-row-hover shrink-0"
              >
                <Icon name="chevron-left" size={12} class="tint-ink-muted" />
                <Text class="text-[12px] text-ink-muted">{t().common.back}</Text>
              </View>
            </If>
            <Text testID="git-diff-path" class="font-mono text-[12px] font-medium text-ink shrink min-w-0 line-clamp-1">
              {d().path}
            </Text>
            <If when={d().untracked}>
              <View class="px-[6px] h-[18px] rounded-(--radius-xs) bg-ok-bg items-center justify-center shrink-0">
                <Text class="text-[10px] font-semibold text-ok-text">{t().git.changes.untrackedBadge}</Text>
              </View>
            </If>
            <View class="flex-row items-center gap-[4px] ml-auto shrink-0">
              {togglePill("git-diff-unified", t().git.changes.unifiedView, layout() === "unified", () => layout.set("unified"))}
              {togglePill("git-diff-split", t().git.changes.splitView, layout() === "split", () => layout.set("split"))}
              {togglePill("git-diff-wrap", t().git.changes.wrapOn, softWrap(), () => softWrap.set(!softWrap()))}
              <If when={props.onOpenPreview && !d().commit}>
                <View
                  role="button"
                  testID="git-diff-open-preview"
                  accessibilityLabel={t().git.changes.openInPreview}
                  tooltip={tip(t().git.changes.openInPreview)}
                  onPress={() => props.onOpenPreview?.(d().path)}
                  class="cursor-pointer select-none flex-row items-center gap-[4px] px-[7px] h-[24px] rounded-(--radius-control-sm) hover:bg-row-hover"
                >
                  <Icon name="external" size={12} class="tint-ink-muted" />
                </View>
              </If>
            </View>
          </View>
        )}
      </If>

      <If when={props.diff?.truncated}>
        <View class="px-[10px] py-[6px] bg-warn-bg border-b border-warn-line shrink-0">
          <Text class="text-[11px] text-warn-text">{t().git.changes.truncatedNotice}</Text>
        </View>
      </If>

      <If when={props.loading}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[13px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>

      <If when={!props.loading && props.error}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[13px] text-danger-text text-center">{props.error}</Text>
        </View>
      </If>

      <If when={!props.loading && !props.error && !props.diff}>
        <EmptyState testID="git-diff-empty" title={props.emptyHint ?? t().git.changes.selectFileHint} />
      </If>

      <If when={!props.loading && !props.error ? props.diff : null}>
        {(d) => (
          <If
            when={!d().binary && d().patch.trim().length > 0}
            else={
              <EmptyState
                testID="git-diff-binary"
                title={d().binary ? t().git.changes.binaryFile : (d().reason ?? t().git.changes.empty)}
              />
            }
          >
            <View class="flex-1 min-h-0" style={surface() ? { backgroundColor: surface()!.bg } : undefined}>
              <DiffView
                testID="git-nsh-diff-view"
                class="flex-1 min-h-0"
                patch={d().patch}
                language={baseName(d().path)}
                layout={layout()}
                softWrap={softWrap()}
                fontSize={12}
                lineHeight={18}
                lineNumbers={true}
                background={true}
              />
            </View>
          </If>
        )}
      </If>
    </View>
  );
}
