/**
 * Single-file diff viewer wrapping `nsh/base`'s native `DiffView` (ADR 0118).
 * Desktop/wide panes show inline unified/split/wrap toggles; narrow mobile pages force unified
 * layout, apply safe-area insets, and tuck wrap/line-number options into a `BottomSheet`.
 */
import type { GitDiffResponse } from "@real-bot/protocol";
import { safeArea, signal, Text, View } from "nsh";
import { DiffView } from "nsh/base";
import { baseName } from "../../m/paths.ts";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Button } from "../Button";
import { codeSurface } from "../code-colors";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { tip } from "../tip";
import type { GitHost } from "./git-levels";

export function GitDiffViewer(props: {
  diff: GitDiffResponse | null;
  loading: boolean;
  error: string | null;
  emptyHint?: string;
  host?: GitHost;
  narrow?: boolean;
  onOpenPreview?: (relpath: string) => void;
  onLoadFull?: () => void;
  onBack?: () => void;
}) {
  const t = () => copy();
  const layout = signal<"split" | "unified">("unified");
  const softWrap = signal(true);
  const lineNumbers = signal(true);
  const optionsOpen = signal(false);
  const surface = () => codeSurface();
  const isPage = () => props.host === "page";
  const isNarrow = () => props.narrow === true;
  const effectiveLayout = () => (isNarrow() ? "unified" : layout());

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
      <If when={props.diff || props.onBack}>
        <View
          class={`flex-row items-center gap-[6px] shrink-0 border-b border-line-subtle bg-sidebar-bg ${
            isPage() && isNarrow() ? "min-h-[48px] px-[4px]" : "h-[36px] px-[10px]"
          }`}
          style={isPage() && isNarrow() ? { paddingTop: safeArea().top } : undefined}
        >
          <If when={props.onBack}>
            <View
              role="button"
              testID="git-diff-back"
              accessibilityLabel={t().git.graph.backToList}
              onPress={() => props.onBack?.()}
              class={`cursor-pointer select-none flex-row items-center justify-center shrink-0 ${
                isPage() && isNarrow()
                  ? "w-[44px] h-[44px] rounded-(--radius-control-sm) active:bg-row-hover"
                  : "gap-[4px] px-[6px] h-[24px] rounded-(--radius-control-sm) hover:bg-row-hover"
              }`}
            >
              <Icon name="chevron-left" size={isPage() && isNarrow() ? 20 : 12} class="tint-ink-secondary" />
              <If when={!(isPage() && isNarrow())}>
                <Text class="text-[12px] text-ink-muted">{t().common.back}</Text>
              </If>
            </View>
          </If>

          <If when={props.diff}>
            {(d) => (
              <>
                <View tooltip={tip(d().path)} class="flex-1 min-w-0">
                  <Text testID="git-diff-path" class="font-mono text-[12.5px] font-medium text-ink line-clamp-1">
                    {isNarrow() ? baseName(d().path) : d().path}
                  </Text>
                </View>
                <If when={d().untracked}>
                  <View class="px-[6px] h-[18px] rounded-(--radius-xs) bg-ok-bg items-center justify-center shrink-0">
                    <Text class="text-[10px] font-semibold text-ok-text">{t().git.changes.untrackedBadge}</Text>
                  </View>
                </If>
                <View class="flex-row items-center gap-[4px] ml-auto shrink-0">
                  <If when={!isNarrow()}>
                    {togglePill("git-diff-unified", t().git.changes.unifiedView, layout() === "unified", () => layout.set("unified"))}
                    {togglePill("git-diff-split", t().git.changes.splitView, layout() === "split", () => layout.set("split"))}
                    {togglePill("git-diff-wrap", t().git.changes.wrapOn, softWrap(), () => softWrap.set(!softWrap()))}
                  </If>
                  <If when={props.onOpenPreview && !d().commit}>
                    <View
                      role="button"
                      testID="git-diff-open-preview"
                      accessibilityLabel={t().git.changes.openInPreview}
                      tooltip={tip(t().git.changes.openInPreview)}
                      onPress={() => props.onOpenPreview?.(d().path)}
                      class={`cursor-pointer select-none items-center justify-center rounded-(--radius-control-sm) hover:bg-row-hover ${
                        isPage() && isNarrow() ? "w-[40px] h-[40px]" : "px-[7px] h-[24px]"
                      }`}
                    >
                      <Icon name="external" size={isPage() && isNarrow() ? 16 : 12} class="tint-ink-muted" />
                    </View>
                  </If>
                  <If when={isNarrow()}>
                    <View
                      role="button"
                      testID="git-diff-options"
                      accessibilityLabel={t().git.diffOptions}
                      onPress={() => optionsOpen.set(true)}
                      class="cursor-pointer select-none items-center justify-center w-[40px] h-[40px] rounded-(--radius-control-sm) active:bg-row-hover hover:bg-row-hover"
                    >
                      <Icon name="more" size={16} class="tint-ink-secondary" />
                    </View>
                  </If>
                </View>
              </>
            )}
          </If>
        </View>
      </If>

      <If when={props.diff?.truncated}>
        <View class="flex-row items-center justify-between gap-[8px] px-[10px] py-[6px] bg-warn-bg border-b border-warn-line shrink-0">
          <Text class="text-[11px] text-warn-text shrink min-w-0">
            {props.diff?.reason || t().git.changes.truncatedNotice}
          </Text>
          <If when={props.onLoadFull}>
            <Button variant="secondary" size="sm" testID="git-diff-load-full" onPress={() => props.onLoadFull?.()}>
              {t().git.loadFullDiff}
            </Button>
          </If>
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
                layout={effectiveLayout()}
                softWrap={softWrap()}
                fontSize={isNarrow() ? 11.5 : 12}
                lineHeight={isNarrow() ? 17 : 18}
                lineNumbers={lineNumbers()}
                background={true}
              />
            </View>
          </If>
        )}
      </If>

      <If when={optionsOpen()}>
        <BottomSheet title={t().git.diffOptions} closeLabel={t().common.close} onClose={() => optionsOpen.set(false)}>
          <View role="menu" testID="git-diff-options-sheet">
            <SheetItem
              role="menuitem"
              testID="git-diff-opt-wrap"
              icon={softWrap() ? "check" : "file"}
              active={softWrap()}
              label={t().git.changes.wrapOn}
              onPress={() => {
                softWrap.set(!softWrap());
                optionsOpen.set(false);
              }}
            />
            <SheetItem
              role="menuitem"
              testID="git-diff-opt-lines"
              icon={lineNumbers() ? "check" : "file"}
              active={lineNumbers()}
              label={t().git.lineNumbers}
              onPress={() => {
                lineNumbers.set(!lineNumbers());
                optionsOpen.set(false);
              }}
            />
          </View>
        </BottomSheet>
      </If>
    </View>
  );
}
