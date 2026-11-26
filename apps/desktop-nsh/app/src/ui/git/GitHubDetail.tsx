/**
 * Read-only GitHub PR / Issue detail viewer with Markdown rendering, CI check summary,
 * comments, "Quote to composer" draft insertion, and "Open on GitHub" (ADR 0118).
 */
import type { GitHubIssueDetail, GitHubPrDetail } from "@real-bot/protocol";
import { Scroll, Text, View } from "nsh";
import { openExternalLink } from "../../m/open-link.ts";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { MarkdownBody } from "../MarkdownBody";
import { formatRelativeIso } from "./git-ui-helpers";

export type SelectedGitHubItem =
  | { kind: "pr"; detail: GitHubPrDetail }
  | { kind: "issue"; detail: GitHubIssueDetail };

export function GitHubDetail(props: {
  item: SelectedGitHubItem | null;
  loading: boolean;
  onQuote: (number: number, title: string, url: string) => void;
  onBack?: () => void;
}) {
  const t = () => copy();
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");

  const stateBadge = (state: string, isDraft?: boolean) => {
    const g = t().git.github;
    if (isDraft) return { bg: "bg-chip", text: "text-ink-muted", label: g.draftBadge };
    if (state === "MERGED") return { bg: "bg-purple-bg", text: "text-purple-text", label: g.stateMerged };
    if (state === "CLOSED") return { bg: "bg-danger-bg", text: "text-danger-text", label: g.stateClosed };
    return { bg: "bg-ok-bg", text: "text-ok-text", label: g.stateOpen };
  };

  return (
    <View testID="git-github-detail" class="flex-1 min-h-0 min-w-0 bg-pane">
      <If when={props.loading && !props.item}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[13px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>

      <If when={!props.loading && !props.item}>
        <EmptyState testID="git-github-detail-empty" title={t().git.github.selectItemHint} />
      </If>

      <If when={props.item}>
        {(sel) => {
          const d = () => sel().detail;
          const pr = () => (sel().kind === "pr" ? (sel().detail as GitHubPrDetail) : null);
          const badge = () => stateBadge(d().state, pr()?.is_draft);
          return (
            <View class="flex-1 min-h-0">
              <View class="px-[12px] py-[10px] border-b border-line-subtle gap-[6px] bg-sidebar-bg shrink-0">
                <View class="flex-row items-center gap-[6px] flex-wrap">
                  <If when={props.onBack}>
                    <View
                      role="button"
                      testID="git-gh-detail-back"
                      onPress={() => props.onBack?.()}
                      class="cursor-pointer select-none flex-row items-center gap-[2px] px-[6px] h-[22px] rounded-(--radius-control-sm) hover:bg-row-hover shrink-0"
                    >
                      <Icon name="chevron-left" size={12} class="tint-ink-muted" />
                      <Text class="text-[11px] text-ink-muted">{t().common.back}</Text>
                    </View>
                  </If>
                  <View class={`px-[7px] h-[20px] rounded-full items-center justify-center ${badge().bg}`}>
                    <Text class={`text-[11px] font-semibold ${badge().text}`}>{badge().label}</Text>
                  </View>
                  <Text class="font-mono text-[12px] text-ink-muted">{`#${d().number}`}</Text>
                  <Text class="text-[11px] text-ink-muted">{d().author}</Text>
                  <Text class="text-[11px] text-ink-muted">{formatRelativeIso(d().updated_at, locale())}</Text>
                </View>

                <Text testID="git-gh-detail-title" class="text-[15px] font-semibold text-ink">{d().title}</Text>

                <If when={pr()}>
                  {(p) => (
                    <View class="flex-row flex-wrap items-center gap-[6px]">
                      <Text class="font-mono text-[11px] text-ink-secondary">{`${p().head_ref} → ${p().base_ref}`}</Text>
                      <Text class="font-mono text-[11px] text-ok-text">{`+${p().additions}`}</Text>
                      <Text class="font-mono text-[11px] text-danger-text">{`-${p().deletions}`}</Text>
                      <If when={p().review_decision}>
                        <View class="px-[6px] h-[18px] rounded-(--radius-xs) bg-chip items-center justify-center">
                          <Text class="text-[10px] font-medium text-ink-secondary">
                            {p().review_decision === "APPROVED"
                              ? t().git.github.reviewApproved
                              : p().review_decision === "CHANGES_REQUESTED"
                                ? t().git.github.reviewChanges
                                : t().git.github.reviewRequired}
                          </Text>
                        </View>
                      </If>
                      <If when={p().checks}>
                        {(ck) => (
                          <View
                            class={`px-[6px] h-[18px] rounded-(--radius-xs) items-center justify-center ${
                              ck().failed > 0 ? "bg-danger-bg" : ck().pending > 0 ? "bg-warn-bg" : "bg-ok-bg"
                            }`}
                          >
                            <Text
                              class={`text-[10px] font-semibold ${
                                ck().failed > 0 ? "text-danger-text" : ck().pending > 0 ? "text-warn-text" : "text-ok-text"
                              }`}
                            >
                              {t().git.github.checksSummary(ck().passed, ck().total, ck().failed, ck().pending)}
                            </Text>
                          </View>
                        )}
                      </If>
                    </View>
                  )}
                </If>

                <View class="flex-row flex-wrap items-center gap-[6px] pt-[2px]">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="reply"
                    testID="git-gh-quote"
                    onPress={() => props.onQuote(d().number, d().title, d().url)}
                  >
                    {t().git.github.quoteToComposer}
                  </Button>
                  <If when={d().url}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="external"
                      testID="git-gh-open-external"
                      onPress={() => void openExternalLink(d().url)}
                    >
                      {t().git.github.openOnGitHub}
                    </Button>
                  </If>
                </View>
              </View>

              <Scroll class="flex-1 min-h-0" contentClass="p-[12px] gap-[12px]">
                <If when={d().labels.length > 0}>
                  <View class="flex-row flex-wrap gap-[4px]">
                    <Each of={d().labels.slice()} key={(l) => l.name}>
                      {(l) => (
                        <View class="px-[6px] h-[18px] rounded-full bg-chip border border-line items-center justify-center">
                          <Text class="text-[10px] text-ink-secondary">{l().name}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>

                <If
                  when={d().body.trim().length > 0}
                  else={<Text class="text-[12px] text-ink-muted">{t().git.github.noBody}</Text>}
                >
                  <MarkdownBody source={d().body} copyLabel={t().pane.copy} />
                </If>

                <If when={pr()?.checks && pr()!.checks!.items.length > 0}>
                  <View class="p-[10px] rounded-(--radius-card-sm) border border-line-subtle bg-sidebar-bg gap-[4px]">
                    <Each of={pr()!.checks!.items.slice()} key={(c) => `${c.name}:${c.status}`}>
                      {(c) => (
                        <View class="flex-row items-center gap-[6px]">
                          <Text
                            class={`text-[11px] font-semibold ${
                              c().conclusion === "SUCCESS" || c().status === "SUCCESS"
                                ? "text-ok-text"
                                : c().conclusion === "FAILURE" || c().status === "FAILURE"
                                  ? "text-danger-text"
                                  : "text-warn-text"
                            }`}
                          >
                            {c().conclusion === "SUCCESS" || c().status === "SUCCESS" ? "✓" : c().conclusion === "FAILURE" || c().status === "FAILURE" ? "✕" : "•"}
                          </Text>
                          <Text class="text-[11px] text-ink flex-1 min-w-0 line-clamp-1">{c().name}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>

                <If when={d().comments.length > 0}>
                  <View class="gap-[8px] pt-[6px] border-t border-line-subtle">
                    <Text class="text-[12px] font-semibold text-ink-secondary">{t().git.github.commentsHead(d().comments.length)}</Text>
                    <If when={d().comments_truncated}>
                      <Text class="text-[11px] text-ink-muted">{t().git.github.commentsTruncated}</Text>
                    </If>
                    <Each of={d().comments.slice()} key={(c) => `${c.author}:${c.created_at}`}>
                      {(c) => (
                        <View class="p-[10px] rounded-(--radius-card-sm) border border-line-subtle bg-sidebar-bg gap-[6px]">
                          <View class="flex-row items-center gap-[6px]">
                            <Text class="text-[12px] font-semibold text-ink">{c().author}</Text>
                            <Text class="text-[11px] text-ink-muted">{formatRelativeIso(c().created_at, locale())}</Text>
                          </View>
                          <MarkdownBody source={c().body} copyLabel={t().pane.copy} />
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
              </Scroll>
            </View>
          );
        }}
      </If>
    </View>
  );
}
