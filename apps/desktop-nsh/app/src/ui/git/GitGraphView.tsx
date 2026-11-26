/**
 * Commit history graph view (ADR 0118).
 * Virtualised List where each fixed-height row draws its lane lines and commit dot on a lightweight
 * per-row Canvas (`Path2D`), paired with a commit detail and per-file diff inspector.
 */
import type { GitCommitDetail, GitDiffResponse, GitLogCommit, GitLogRef } from "@real-bot/protocol";
import { Canvas, Clipboard, computed, effect, List, Path2D, Scroll, signal, Text, token, untracked, View, type CanvasRenderingContext2D } from "nsh";
import { Input } from "nsh/base";
import { buildCommitGraph, type GraphRowLayout } from "../../m/git/graph-lanes.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { FileIcon } from "../overlays/FileIcon";
import { GitDiffViewer } from "./GitDiffViewer";
import { formatRelativeIso, laneStrokeColor, splitRepoPath, statusBadgeClass } from "./git-ui-helpers";

const ROW_H = 38;
const COL_W = 14;
const PAD_X = 10;

function GraphLaneCanvas(props: { row: GraphRowLayout }) {
  const width = () => Math.max(24, PAD_X * 2 + (props.row.maxCols - 1) * COL_W);
  const cxOf = (col: number) => PAD_X + col * COL_W;

  return (
    <Canvas
      testID="git-graph-row-canvas"
      class="shrink-0"
      style={{ width: width(), height: ROW_H, pointerEvents: "none" }}
      draw={(cx: CanvasRenderingContext2D) => {
        const row = props.row;
        const midY = ROW_H / 2;
        cx.clearRect(0, 0, width(), ROW_H);
        cx.lineCap = "round";

        for (const edge of row.edges) {
          cx.beginPath();
          cx.strokeStyle = laneStrokeColor(edge.colorIndex);
          cx.lineWidth = 1.75;
          const x1 = cxOf(edge.fromCol);
          const x2 = cxOf(edge.toCol);
          const p = new Path2D();
          if (edge.kind === "through") {
            p.moveTo(x1, 0);
            p.lineTo(x1, ROW_H);
          } else if (edge.kind === "in") {
            p.moveTo(x1, 0);
            if (x1 === x2) p.lineTo(x2, midY);
            else p.bezierCurveTo(x1, midY * 0.55, x2, midY * 0.45, x2, midY);
          } else {
            p.moveTo(x1, midY);
            if (x1 === x2) p.lineTo(x2, ROW_H);
            else p.bezierCurveTo(x1, midY + (ROW_H - midY) * 0.55, x2, midY + (ROW_H - midY) * 0.45, x2, ROW_H);
          }
          cx.stroke(p);
        }

        const nodeX = cxOf(row.col);
        const nodeColor = laneStrokeColor(row.colorIndex);
        cx.beginPath();
        cx.arc(nodeX, midY, row.isHead ? 5 : row.isMerge ? 4.5 : 3.8, 0, Math.PI * 2);
        cx.fillStyle = row.isMerge ? token("pane") : nodeColor;
        cx.fill();
        if (row.isMerge || row.isHead) {
          cx.lineWidth = 2;
          cx.strokeStyle = nodeColor;
          cx.stroke();
        }
      }}
    />
  );
}

function refBadgeStyle(kind: GitLogRef["kind"]): { bg: string; text: string } {
  switch (kind) {
    case "head":
      return { bg: "bg-brand", text: "text-on-accent" };
    case "local":
      return { bg: "bg-accent-tint", text: "text-brand" };
    case "remote":
      return { bg: "bg-sky-bg", text: "text-sky-text" };
    case "tag":
      return { bg: "bg-mustard-tint", text: "text-mustard-ink" };
    case "worktree":
      return { bg: "bg-purple-bg", text: "text-purple-text" };
  }
}

export function GitGraphView(props: {
  sessionId: string;
  repo: string | null;
  worktree: string | null;
  narrow: boolean;
  reloadToken: number;
}) {
  const t = () => copy();
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const scope = signal<"branch" | "all">("branch");
  const query = signal("");
  const commits = signal<GitLogCommit[]>([]);
  const hasMore = signal(false);
  const loading = signal(false);
  const loadingMore = signal(false);
  const error = signal<string | null>(null);

  const selectedOid = signal<string | null>(null);
  const detail = signal<GitCommitDetail | null>(null);
  const detailLoading = signal(false);
  const selectedFile = signal<string | null>(null);
  const fileDiff = signal<GitDiffResponse | null>(null);
  const fileDiffLoading = signal(false);
  const narrowStep = signal<"list" | "detail" | "diff">("list");

  let logSeq = 0;
  let detailSeq = 0;
  let diffSeq = 0;

  const fetchLog = (skip: number, append: boolean) => {
    const api = runtime.client;
    if (!api) return;
    const req = ++logSeq;
    if (append) loadingMore.set(true);
    else loading.set(commits().length === 0);
    error.set(null);
    void api
      .gitLog(props.sessionId, { scope: scope(), limit: 150, skip, repo: props.repo, worktree: props.worktree })
      .then((res) => {
        if (req !== logSeq) return;
        const next = append ? [...commits(), ...res.commits] : res.commits;
        commits.set(next);
        hasMore.set(res.has_more);
        if (!selectedOid() && next[0]) selectedOid.set(next[0].oid);
      })
      .catch((err) => {
        if (req !== logSeq) return;
        error.set(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (req === logSeq) {
          loading.set(false);
          loadingMore.set(false);
        }
      });
  };

  effect(() => {
    void props.sessionId;
    void props.repo;
    void props.worktree;
    void scope();
    void props.reloadToken;
    untracked(() => fetchLog(0, false));
  });

  effect(() => {
    const oid = selectedOid();
    const api = runtime.client;
    if (!oid || !api) {
      untracked(() => {
        detail.set(null);
        selectedFile.set(null);
        fileDiff.set(null);
      });
      return;
    }
    const req = ++detailSeq;
    untracked(() => {
      detailLoading.set(true);
      selectedFile.set(null);
      fileDiff.set(null);
      void api
        .gitCommit(props.sessionId, oid, { repo: props.repo, worktree: props.worktree })
        .then((res) => {
          if (req !== detailSeq) return;
          detail.set(res);
          selectedFile.set(res.files[0]?.path ?? null);
        })
        .catch(() => {
          if (req === detailSeq) detail.set(null);
        })
        .finally(() => {
          if (req === detailSeq) detailLoading.set(false);
        });
    });
  });

  effect(() => {
    const oid = selectedOid();
    const path = selectedFile();
    const api = runtime.client;
    if (!oid || !path || !api) {
      untracked(() => {
        fileDiff.set(null);
        fileDiffLoading.set(false);
      });
      return;
    }
    const req = ++diffSeq;
    untracked(() => {
      fileDiffLoading.set(true);
      void api
        .gitDiff(props.sessionId, { path, commit: oid, repo: props.repo, worktree: props.worktree })
        .then((res) => {
          if (req === diffSeq) fileDiff.set(res);
        })
        .catch(() => {
          if (req === diffSeq) fileDiff.set(null);
        })
        .finally(() => {
          if (req === diffSeq) fileDiffLoading.set(false);
        });
    });
  });

  const rows = computed(() => {
    const all = buildCommitGraph(commits());
    const q = query().trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.commit.subject.toLowerCase().includes(q) ||
        r.commit.author_name.toLowerCase().includes(q) ||
        r.commit.oid.toLowerCase().startsWith(q) ||
        r.commit.refs.some((ref) => ref.name.toLowerCase().includes(q)),
    );
  });

  const copySha = (oid: string) => {
    void Clipboard.writeText(oid).catch(() => {});
    showToast(t().git.graph.copiedSha, { tone: "info" });
  };

  const graphListPane = () => (
    <View
      testID="git-graph-list-pane"
      class={`${props.narrow ? "flex-1" : "w-[360px] shrink-0 border-r border-line"} min-h-0 bg-sidebar-bg`}
    >
      <View class="px-[8px] py-[8px] gap-[6px] border-b border-line-subtle shrink-0">
        <View class="flex-row items-center gap-[4px]">
          <View
            role="button"
            testID="git-graph-scope-branch"
            onPress={() => scope.set("branch")}
            class={`cursor-pointer select-none px-[8px] h-[22px] rounded-(--radius-control-sm) items-center justify-center ${
              scope() === "branch" ? "bg-accent-tint" : "hover:bg-row-hover"
            }`}
          >
            <Text class={`text-[11px] font-medium ${scope() === "branch" ? "text-brand" : "text-ink-muted"}`}>
              {t().git.graph.scopeBranch}
            </Text>
          </View>
          <View
            role="button"
            testID="git-graph-scope-all"
            onPress={() => scope.set("all")}
            class={`cursor-pointer select-none px-[8px] h-[22px] rounded-(--radius-control-sm) items-center justify-center ${
              scope() === "all" ? "bg-accent-tint" : "hover:bg-row-hover"
            }`}
          >
            <Text class={`text-[11px] font-medium ${scope() === "all" ? "text-brand" : "text-ink-muted"}`}>
              {t().git.graph.scopeAll}
            </Text>
          </View>
        </View>
        <Input
          testID="git-graph-search"
          value={query()}
          placeholder={t().git.graph.searchPlaceholder}
          accessibilityLabel={t().git.graph.searchPlaceholder}
          onChange={(e) => query.set(e.value)}
          class="h-[26px] px-[8px] rounded-(--radius-sm) border border-line bg-input-bg text-[12px] text-ink"
        />
      </View>

      <If when={loading() && commits().length === 0}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[12px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>
      <If when={!loading() && error()}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[12px] text-danger-text text-center">{error()}</Text>
        </View>
      </If>
      <If when={!loading() && !error() && rows().length === 0}>
        <EmptyState testID="git-graph-empty" title={t().git.graph.empty} />
      </If>

      <If when={rows().length > 0}>
        <List
          testID="git-graph-list"
          each={rows()}
          keyExtractor={(item) => item.commit.oid}
          estimatedItemSize={ROW_H}
          class="flex-1 min-h-0"
          contentStyle={{ paddingTop: 2, paddingBottom: 8 }}
        >
          {(row) => {
            const active = () => selectedOid() === row().commit.oid;
            const shownRefs = () => row().commit.refs.slice(0, 3);
            return (
              <View
                role="button"
                testID={`git-commit-${row().commit.short_oid}`}
                accessibilityState={{ selected: active() }}
                onPress={() => {
                  selectedOid.set(row().commit.oid);
                  if (props.narrow) narrowStep.set("detail");
                }}
                class={`cursor-pointer select-none flex-row items-center pr-[8px] ${active() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
                style={{ height: ROW_H }}
              >
                <GraphLaneCanvas row={row()} />
                <View class="flex-1 min-w-0 gap-[1px]">
                  <View class="flex-row items-center gap-[4px] min-w-0">
                    <Each of={shownRefs()} key={(r) => `${r.kind}:${r.name}`}>
                      {(ref) => {
                        const st = () => refBadgeStyle(ref().kind);
                        return (
                          <View class={`px-[5px] h-[15px] rounded-(--radius-xs) items-center justify-center shrink-0 ${st().bg}`}>
                            <Text class={`font-mono text-[10px] font-medium ${st().text} max-w-[90px] line-clamp-1`}>{ref().name}</Text>
                          </View>
                        );
                      }}
                    </Each>
                    <Text class={`text-[12px] shrink min-w-0 line-clamp-1 ${active() ? "font-semibold text-brand" : "text-ink"}`}>
                      {row().commit.subject}
                    </Text>
                  </View>
                  <View class="flex-row items-center gap-[6px]">
                    <Text class="font-mono text-[10px] text-ink-muted">{row().commit.short_oid}</Text>
                    <Text class="text-[10px] text-ink-muted shrink min-w-0 line-clamp-1">{row().commit.author_name}</Text>
                    <Text class="text-[10px] text-ink-muted ml-auto shrink-0">
                      {formatRelativeIso(row().commit.authored_at, locale())}
                    </Text>
                  </View>
                </View>
              </View>
            );
          }}
        </List>
      </If>

      <If when={hasMore() && !query().trim()}>
        <View class="p-[8px] border-t border-line-subtle shrink-0 items-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore()}
            testID="git-graph-load-more"
            onPress={() => fetchLog(commits().length, true)}
          >
            {loadingMore() ? t().git.graph.loadingMore : t().git.graph.loadMore}
          </Button>
        </View>
      </If>
    </View>
  );

  const commitInspector = () => (
    <View testID="git-commit-detail" class="flex-1 min-h-0 min-w-0 bg-pane">
      <If when={detailLoading() && !detail()}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[12px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>
      <If when={!detailLoading() && !detail()}>
        <EmptyState testID="git-commit-empty" title={t().git.graph.selectCommitHint} />
      </If>
      <If when={detail()}>
        {(d) => (
          <View class="flex-1 min-h-0">
            <View class="px-[12px] py-[10px] border-b border-line-subtle gap-[4px] shrink-0 bg-sidebar-bg">
              <View class="flex-row items-center gap-[6px]">
                <If when={props.narrow}>
                  <View
                    role="button"
                    testID="git-commit-back"
                    onPress={() => narrowStep.set("list")}
                    class="cursor-pointer select-none flex-row items-center gap-[2px] px-[6px] h-[22px] rounded-(--radius-control-sm) hover:bg-row-hover shrink-0"
                  >
                    <Icon name="chevron-left" size={12} class="tint-ink-muted" />
                    <Text class="text-[11px] text-ink-muted">{t().common.back}</Text>
                  </View>
                </If>
                <Text class="text-[13px] font-semibold text-ink flex-1 min-w-0 line-clamp-2">{d().subject}</Text>
                <View
                  role="button"
                  testID="git-commit-copy-sha"
                  onPress={() => copySha(d().oid)}
                  class="cursor-pointer select-none flex-row items-center gap-[4px] px-[7px] h-[22px] rounded-(--radius-control-sm) bg-chip hover:bg-row-hover shrink-0"
                >
                  <Icon name="copy" size={12} class="tint-ink-muted" />
                  <Text class="font-mono text-[11px] text-ink-secondary">{d().short_oid}</Text>
                </View>
              </View>
              <If when={d().body}>
                <Text class="text-[12px] text-ink-secondary whitespace-pre-wrap line-clamp-4">{d().body}</Text>
              </If>
              <View class="flex-row flex-wrap items-center gap-[8px]">
                <Text class="text-[11px] text-ink-muted">{d().author_name}</Text>
                <Text class="text-[11px] text-ink-muted">{formatRelativeIso(d().authored_at, locale())}</Text>
                <Text class="text-[11px] text-ink-muted">{t().git.graph.changedFiles(d().files.length)}</Text>
              </View>
            </View>

            <If when={!props.narrow || narrowStep() === "detail"}>
              <Scroll class="max-h-[170px] border-b border-line-subtle shrink-0" contentClass="p-[6px] gap-[2px]">
                <Each of={d().files.slice()} key={(f) => f.path}>
                  {(f) => {
                    const active = () => selectedFile() === f().path;
                    const split = () => splitRepoPath(f().path);
                    const badge = () => statusBadgeClass(f().status);
                    return (
                      <View
                        role="button"
                        testID={`git-commit-file-${f().path}`}
                        onPress={() => {
                          selectedFile.set(f().path);
                          if (props.narrow) narrowStep.set("diff");
                        }}
                        class={`cursor-pointer select-none flex-row items-center gap-[6px] px-[8px] py-[4px] rounded-(--radius-sm) ${
                          active() ? "bg-accent-tint" : "hover:bg-row-hover"
                        }`}
                      >
                        <FileIcon icon={fileIconFor(f().path)} size={16} />
                        <Text class={`text-[12px] shrink min-w-0 line-clamp-1 ${active() ? "font-semibold text-brand" : "text-ink"}`}>
                          {split().dir ? `${split().dir}/${split().name}` : split().name}
                        </Text>
                        <View class="flex-row items-center gap-[4px] ml-auto shrink-0">
                          <If when={f().additions !== null && f().additions! > 0}>
                            <Text class="font-mono text-[10px] text-ok-text">{`+${f().additions}`}</Text>
                          </If>
                          <If when={f().deletions !== null && f().deletions! > 0}>
                            <Text class="font-mono text-[10px] text-danger-text">{`-${f().deletions}`}</Text>
                          </If>
                          <View class={`w-[18px] h-[18px] rounded-(--radius-xs) items-center justify-center ${badge().bg}`}>
                            <Text class={`font-mono text-[10px] font-bold ${badge().text}`}>{f().status}</Text>
                          </View>
                        </View>
                      </View>
                    );
                  }}
                </Each>
              </Scroll>
            </If>

            <If when={!props.narrow || narrowStep() === "diff"}>
              <GitDiffViewer
                diff={fileDiff()}
                loading={fileDiffLoading()}
                error={null}
                onBack={props.narrow ? () => narrowStep.set("detail") : undefined}
              />
            </If>
          </View>
        )}
      </If>
    </View>
  );

  return (
    <View testID="git-graph-view" class="flex-1 min-h-0 flex-row">
      <If when={!props.narrow || narrowStep() === "list"}>{graphListPane()}</If>
      <If when={!props.narrow || narrowStep() !== "list"}>{commitInspector()}</If>
    </View>
  );
}
