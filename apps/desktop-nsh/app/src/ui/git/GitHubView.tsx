/**
 * GitHub associated PRs & Issues + repository browser view (ADR 0118).
 * Prioritises items linked to the current branch, closing issues, commits, and chat URLs,
 * with clean degradation when `gh` is missing, signed out, offline, or non-GitHub.
 * Mobile pages wire detail drill-down into `stepIn` / `holdLevels` and return to chat on quote.
 */
import type {
  GitHubIssueSummary,
  GitHubListFilter,
  GitHubPrSummary,
  GitHubRelatedResponse,
  GitHubRepoStatus,
} from "@real-bot/protocol";
import { cleanup, effect, safeArea, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { showToast } from "../../m/toast.svelte.ts";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { GitHubDetail, type SelectedGitHubItem } from "./GitHubDetail";
import { drillIn, registerGitLevels, type GitHost } from "./git-levels";
import { formatRelativeIso } from "./git-ui-helpers";

const FILTERS: readonly GitHubListFilter[] = ["open", "mine", "review_requested", "closed"];

export function GitHubView(props: {
  sessionId: string;
  projectDir: string;
  repo: string | null;
  worktree: string | null;
  isOtherWorktree?: boolean;
  host?: GitHost;
  isRemote?: boolean;
  narrow: boolean;
  reloadToken: number;
  forceRefreshToken: number;
  onDrillDepthChange?: (depth: number) => void;
  onLeaveAfterQuote?: () => void;
}) {
  const t = () => copy();
  const isPage = () => props.host === "page";
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");

  const related = signal<GitHubRelatedResponse | null>(null);
  const relatedLoading = signal(false);
  const listKind = signal<"prs" | "issues">("prs");
  const filter = signal<GitHubListFilter>("open");
  const search = signal("");
  const submittedSearch = signal("");
  const prs = signal<GitHubPrSummary[]>([]);
  const issues = signal<GitHubIssueSummary[]>([]);
  const listLoading = signal(false);

  const selected = signal<SelectedGitHubItem | null>(null);
  const detailLoading = signal(false);
  const narrowDetail = signal(false);

  effect(() => {
    props.onDrillDepthChange?.(props.narrow && narrowDetail() ? 1 : 0);
  });
  cleanup(() => props.onDrillDepthChange?.(0));

  registerGitLevels({
    name: "git-github-detail",
    active: () => isPage() && props.narrow,
    depth: () => (narrowDetail() ? 1 : 0),
    stepOut: () => narrowDetail.set(false),
  });

  let relSeq = 0;
  let listSeq = 0;
  let detailSeq = 0;
  let activeDetailAc: AbortController | null = null;
  let lastForce = props.forceRefreshToken;
  cleanup(() => activeDetailAc?.abort());

  effect(() => {
    const sid = props.sessionId;
    const repo = props.repo;
    const wt = props.worktree;
    void props.reloadToken;
    const forceNow = props.forceRefreshToken;
    const refresh = forceNow !== lastForce;
    lastForce = forceNow;
    const api = runtime.client;
    if (!api) return;
    const seq = ++relSeq;
    const ac = new AbortController();
    cleanup(() => ac.abort());
    untracked(() => {
      relatedLoading.set(related() === null);
      void api
        .githubRelated(sid, { repo, worktree: wt, refresh }, ac.signal)
        .then((res) => {
          if (seq !== relSeq || ac.signal.aborted) return;
          related.set(res);
          if (!selected() && res.branch_pr) {
            selected.set({ kind: "pr", detail: res.branch_pr });
          }
        })
        .catch(() => {
          // Keep existing cached view on transient network/abort errors.
        })
        .finally(() => {
          if (seq === relSeq && !ac.signal.aborted) relatedLoading.set(false);
        });
    });
  });

  effect(() => {
    const st = related()?.status;
    if (!st || st.state !== "ok") return;
    const sid = props.sessionId;
    const repo = props.repo;
    const wt = props.worktree;
    const kind = listKind();
    const f = filter();
    const q = submittedSearch();
    void props.forceRefreshToken;
    const api = runtime.client;
    if (!api) return;
    const seq = ++listSeq;
    const ac = new AbortController();
    cleanup(() => ac.abort());
    untracked(() => {
      listLoading.set(true);
      if (kind === "prs") {
        void api
          .githubPulls(sid, { filter: f, q, repo, worktree: wt, refresh: false }, ac.signal)
          .then((res) => {
            if (seq === listSeq && !ac.signal.aborted) prs.set(res.items);
          })
          .catch(() => {})
          .finally(() => {
            if (seq === listSeq && !ac.signal.aborted) listLoading.set(false);
          });
      } else {
        void api
          .githubIssues(sid, { filter: f, q, repo, worktree: wt, refresh: false }, ac.signal)
          .then((res) => {
            if (seq === listSeq && !ac.signal.aborted) issues.set(res.items);
          })
          .catch(() => {})
          .finally(() => {
            if (seq === listSeq && !ac.signal.aborted) listLoading.set(false);
          });
      }
    });
  });

  const openDetailStep = () => {
    if (props.narrow) drillIn(isPage(), () => narrowDetail.set(true));
  };

  const openPr = (number: number) => {
    if (related()?.branch_pr?.number === number) {
      selected.set({ kind: "pr", detail: related()!.branch_pr! });
      openDetailStep();
      return;
    }
    const api = runtime.client;
    if (!api) return;
    activeDetailAc?.abort();
    const ac = new AbortController();
    activeDetailAc = ac;
    const seq = ++detailSeq;
    detailLoading.set(true);
    openDetailStep();
    void api
      .githubPrDetail(props.sessionId, number, { repo: props.repo, worktree: props.worktree }, ac.signal)
      .then((detail) => {
        if (seq === detailSeq && !ac.signal.aborted) selected.set({ kind: "pr", detail });
      })
      .catch(() => {})
      .finally(() => {
        if (seq === detailSeq && !ac.signal.aborted) detailLoading.set(false);
      });
  };

  const openIssue = (number: number) => {
    const api = runtime.client;
    if (!api) return;
    activeDetailAc?.abort();
    const ac = new AbortController();
    activeDetailAc = ac;
    const seq = ++detailSeq;
    detailLoading.set(true);
    openDetailStep();
    void api
      .githubIssueDetail(props.sessionId, number, { repo: props.repo, worktree: props.worktree }, ac.signal)
      .then((detail) => {
        if (seq === detailSeq && !ac.signal.aborted) selected.set({ kind: "issue", detail });
      })
      .catch(() => {})
      .finally(() => {
        if (seq === detailSeq && !ac.signal.aborted) detailLoading.set(false);
      });
  };

  const quoteToComposer = (number: number, title: string, url: string) => {
    const view = runtime.sessionView(props.sessionId);
    const snippet = `#${number} ${title}${url ? ` (${url})` : ""}`;
    const existing = view.draft.trim();
    view.draft = existing ? `${existing}\n${snippet} ` : `${snippet} `;
    showToast(t().git.github.quotedToast, { tone: "info" });
    if (isPage()) {
      props.onLeaveAfterQuote?.();
    }
  };

  const filterLabel = (f: GitHubListFilter) => {
    const g = t().git.github;
    if (f === "open") return g.filterOpen;
    if (f === "mine") return g.filterMine;
    if (f === "review_requested") return g.filterReview;
    return g.filterClosed;
  };

  const degradedView = (st: GitHubRepoStatus) => {
    const d = t().git.github.degraded;
    if (st.state === "not_repo") return <EmptyState testID="git-gh-not-repo" title={d.notRepoTitle} hint={d.notRepoHint} />;
    if (st.state === "not_github") {
      return <EmptyState testID="git-gh-not-github" title={d.notGithubTitle} hint={d.notGithubHint(st.remote_url)} />;
    }
    if (st.state === "no_gh") return <EmptyState testID="git-gh-no-gh" title={d.noGhTitle} hint={d.noGhHint} />;
    if (st.state === "not_authed") {
      return (
        <View testID="git-gh-not-authed" class="flex-1 items-center justify-center p-6 gap-[12px]">
          <EmptyState
            title={d.notAuthedTitle}
            hint={props.isRemote ? d.notAuthedRemoteHint : d.notAuthedHint}
          />
          <Button
            variant={props.isRemote ? "secondary" : "primary"}
            size="sm"
            icon="terminal"
            onPress={() => void runtime.openTerminalAt(props.projectDir)}
          >
            {d.openTerminalLogin}
          </Button>
        </View>
      );
    }
    return <EmptyState testID="git-gh-error" title={d.errorTitle} hint={st.error ?? ""} />;
  };

  const prRow = (pr: GitHubPrSummary, tag?: string) => {
    const active = () => !props.narrow && selected()?.kind === "pr" && selected()!.detail.number === pr.number;
    return (
      <View
        role="button"
        testID={`git-gh-pr-${pr.number}`}
        accessibilityState={{ selected: active() }}
        onPress={() => openPr(pr.number)}
        class={`cursor-pointer select-none rounded-(--radius-sm) gap-[3px] ${
          props.narrow ? "px-[10px] py-[10px] active:bg-row-hover" : "px-[8px] py-[7px]"
        } ${active() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
      >
        <View class="flex-row items-center gap-[5px]">
          <Text class="font-mono text-[11.5px] font-semibold text-brand">{`#${pr.number}`}</Text>
          <If when={tag}>
            <View class="px-[5px] h-[16px] rounded-(--radius-xs) bg-purple-bg items-center justify-center">
              <Text class="text-[10px] font-medium text-purple-text">{tag}</Text>
            </View>
          </If>
          <If when={pr.is_draft}>
            <Text class="text-[10px] text-ink-muted">{t().git.github.draftBadge}</Text>
          </If>
          <If when={pr.checks}>
            {(ck) => (
              <Text
                class={`text-[10.5px] font-semibold ml-auto ${
                  ck().failed > 0 ? "text-danger-text" : ck().pending > 0 ? "text-warn-text" : "text-ok-text"
                }`}
              >
                {ck().failed > 0 ? `✕ ${ck().failed}` : ck().pending > 0 ? "…" : `✓ ${ck().passed}`}
              </Text>
            )}
          </If>
        </View>
        <Text class={`${props.narrow ? "text-[13.5px]" : "text-[12px]"} line-clamp-2 ${active() ? "font-semibold text-brand" : "text-ink"}`}>
          {pr.title}
        </Text>
        <View class="flex-row items-center gap-[6px]">
          <Text class="text-[10.5px] text-ink-muted">{pr.author}</Text>
          <Text class="text-[10.5px] text-ink-muted ml-auto">{formatRelativeIso(pr.updated_at, locale())}</Text>
        </View>
      </View>
    );
  };

  const issueRow = (issue: GitHubIssueSummary, tag?: string) => {
    const active = () => !props.narrow && selected()?.kind === "issue" && selected()!.detail.number === issue.number;
    return (
      <View
        role="button"
        testID={`git-gh-issue-${issue.number}`}
        accessibilityState={{ selected: active() }}
        onPress={() => openIssue(issue.number)}
        class={`cursor-pointer select-none rounded-(--radius-sm) gap-[3px] ${
          props.narrow ? "px-[10px] py-[10px] active:bg-row-hover" : "px-[8px] py-[7px]"
        } ${active() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
      >
        <View class="flex-row items-center gap-[5px]">
          <Text class={`font-mono text-[11.5px] font-semibold ${issue.state === "OPEN" ? "text-ok-text" : "text-purple-text"}`}>
            {`#${issue.number}`}
          </Text>
          <If when={tag}>
            <View class="px-[5px] h-[16px] rounded-(--radius-xs) bg-chip items-center justify-center">
              <Text class="text-[10px] text-ink-secondary">{tag}</Text>
            </View>
          </If>
        </View>
        <Text class={`${props.narrow ? "text-[13.5px]" : "text-[12px]"} line-clamp-2 ${active() ? "font-semibold text-brand" : "text-ink"}`}>
          {issue.title}
        </Text>
        <View class="flex-row items-center gap-[6px]">
          <Text class="text-[10.5px] text-ink-muted">{issue.author}</Text>
          <Text class="text-[10.5px] text-ink-muted ml-auto">{formatRelativeIso(issue.updated_at, locale())}</Text>
        </View>
      </View>
    );
  };

  const sourceTag = (src?: string) => {
    const g = t().git.github;
    if (src === "closing") return g.closingIssueTag;
    if (src === "chat") return g.chatRefTag;
    if (src === "commit" || src === "branch") return g.commitRefTag;
    return undefined;
  };

  return (
    <View testID="git-github-view" class="flex-1 min-h-0 bg-pane">
      <If when={relatedLoading() && !related()}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[13px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>

      <If when={related() && related()!.status.state !== "ok"}>
        {degradedView(related()!.status)}
      </If>

      <If when={related() && related()!.status.state === "ok"}>
        <View class="flex-1 min-h-0 flex-row">
          <If when={!props.narrow || !narrowDetail()}>
            <View
              testID="git-gh-list-pane"
              class={`${props.narrow ? "flex-1" : "w-[300px] shrink-0 border-r border-line"} min-h-0 bg-sidebar-bg`}
            >
              <If when={related()!.stale}>
                <View class="px-[8px] py-[5px] bg-warn-bg border-b border-warn-line shrink-0">
                  <Text class="text-[11px] text-warn-text">
                    {t().git.github.staleBanner(formatRelativeIso(related()!.fetched_at, locale()))}
                  </Text>
                </View>
              </If>

              <Scroll
                class="flex-1 min-h-0"
                contentClass="p-[8px] gap-[10px]"
                contentStyle={isPage() && props.narrow ? { paddingBottom: 12 + safeArea().bottom } : undefined}
              >
                {/* Related section */}
                <View class="gap-[4px]">
                  <Text class="text-[11px] font-semibold text-ink-secondary px-[4px]">
                    {props.isOtherWorktree ? t().git.github.relatedBranchHead : t().git.github.relatedHead}
                  </Text>
                  <If
                    when={
                      Boolean(related()!.branch_pr) ||
                      related()!.closing_issues.length > 0 ||
                      related()!.referenced_issues.length > 0 ||
                      related()!.referenced_prs.length > 0
                    }
                    else={<Text class="text-[11px] text-ink-muted px-[4px] py-[4px]">{t().git.github.noRelated}</Text>}
                  >
                    <If when={related()!.branch_pr}>{(bp) => prRow(bp(), t().git.github.branchPrTag)}</If>
                    <Each of={related()!.closing_issues.slice()} key={(i) => `close-${i.number}`}>
                      {(i) => issueRow(i(), t().git.github.closingIssueTag)}
                    </Each>
                    <Each of={related()!.referenced_prs.slice()} key={(p) => `ref-pr-${p.number}`}>
                      {(p) => prRow(p(), sourceTag(p().source))}
                    </Each>
                    <Each of={related()!.referenced_issues.slice()} key={(i) => `ref-is-${i.number}`}>
                      {(i) => issueRow(i(), sourceTag(i().source))}
                    </Each>
                  </If>
                </View>

                {/* Repo list section */}
                <View class="gap-[6px] pt-[8px] border-t border-line-subtle">
                  <View class="flex-row items-center justify-between px-[4px]">
                    <Text class="text-[11px] font-semibold text-ink-secondary">{t().git.github.listHead}</Text>
                    <View class="flex-row items-center gap-[4px]">
                      <View
                        role="button"
                        testID="git-gh-kind-prs"
                        onPress={() => listKind.set("prs")}
                        class={`cursor-pointer select-none px-[10px] rounded-(--radius-xs) items-center justify-center ${
                          props.narrow ? "h-[28px]" : "h-[20px]"
                        } ${listKind() === "prs" ? "bg-accent-tint" : "hover:bg-row-hover"}`}
                      >
                        <Text class={`${props.narrow ? "text-[12px]" : "text-[11px]"} font-medium ${listKind() === "prs" ? "text-brand" : "text-ink-muted"}`}>
                          {t().git.github.kindPrs}
                        </Text>
                      </View>
                      <View
                        role="button"
                        testID="git-gh-kind-issues"
                        onPress={() => listKind.set("issues")}
                        class={`cursor-pointer select-none px-[10px] rounded-(--radius-xs) items-center justify-center ${
                          props.narrow ? "h-[28px]" : "h-[20px]"
                        } ${listKind() === "issues" ? "bg-accent-tint" : "hover:bg-row-hover"}`}
                      >
                        <Text class={`${props.narrow ? "text-[12px]" : "text-[11px]"} font-medium ${listKind() === "issues" ? "text-brand" : "text-ink-muted"}`}>
                          {t().git.github.kindIssues}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View class="flex-row flex-wrap gap-[4px] px-[2px]">
                    <Each of={[...FILTERS]} key={(f) => f}>
                      {(f) => (
                        <View
                          role="button"
                          testID={`git-gh-filter-${f()}`}
                          onPress={() => filter.set(f())}
                          class={`cursor-pointer select-none px-[8px] rounded-(--radius-xs) items-center justify-center ${
                            props.narrow ? "h-[28px]" : "h-[20px]"
                          } ${filter() === f() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
                        >
                          <Text class={`${props.narrow ? "text-[12px]" : "text-[11px]"} ${filter() === f() ? "text-brand font-medium" : "text-ink-muted"}`}>
                            {filterLabel(f())}
                          </Text>
                        </View>
                      )}
                    </Each>
                  </View>

                  <Input
                    testID="git-gh-search"
                    value={search()}
                    placeholder={t().git.github.searchPlaceholder}
                    accessibilityLabel={t().git.github.searchPlaceholder}
                    onChange={(e) => search.set(e.value)}
                    onSubmit={() => submittedSearch.set(search().trim())}
                    class={`px-[10px] rounded-(--radius-sm) border border-line bg-input-bg text-ink ${
                      props.narrow ? "h-[36px] text-[13px]" : "h-[26px] text-[12px]"
                    }`}
                  />

                  <If when={listLoading()}>
                    <Text class="text-[11px] text-ink-muted px-[4px] py-[4px]">{t().git.loading}</Text>
                  </If>

                  <If when={!listLoading() && listKind() === "prs"}>
                    <If
                      when={prs().length > 0}
                      else={<Text class="text-[11px] text-ink-muted px-[4px] py-[4px]">{t().git.github.emptyList}</Text>}
                    >
                      <Each of={prs().slice()} key={(p) => `list-pr-${p.number}`}>
                        {(p) => prRow(p())}
                      </Each>
                    </If>
                  </If>

                  <If when={!listLoading() && listKind() === "issues"}>
                    <If
                      when={issues().length > 0}
                      else={<Text class="text-[11px] text-ink-muted px-[4px] py-[4px]">{t().git.github.emptyList}</Text>}
                    >
                      <Each of={issues().slice()} key={(i) => `list-is-${i.number}`}>
                        {(i) => issueRow(i())}
                      </Each>
                    </If>
                  </If>
                </View>
              </Scroll>
            </View>
          </If>

          <If when={!props.narrow || narrowDetail()}>
            <GitHubDetail
              item={selected()}
              loading={detailLoading()}
              host={props.host}
              narrow={props.narrow}
              onQuote={quoteToComposer}
              onBack={props.narrow ? () => narrowDetail.set(false) : undefined}
            />
          </If>
        </View>
      </If>
    </View>
  );
}
