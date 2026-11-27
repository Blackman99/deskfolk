/**
 * Commit history graph view (ADR 0118).
 * Virtualised List where each row draws its lane lines and commit dot on a lightweight per-row
 * Canvas (`Path2D`), paired with a commit detail and per-file diff inspector.
 * Narrow mobile pages step through 3 history-backed levels (`list -> detail -> diff`) via
 * `stepIn` / `holdLevels`, cap Canvas lanes to 5 columns, and reuse `GitDiffPager` on level 2.
 */
import type { GitCommitDetail, GitDiffResponse, GitLogCommit, GitLogRef } from "@real-bot/protocol";
import {
  Canvas,
  cleanup,
  Clipboard,
  computed,
  effect,
  List,
  Path2D,
  safeArea,
  signal,
  Text,
  token,
  untracked,
  View,
  type CanvasRenderingContext2D,
} from "nsh";
import { Input } from "nsh/base";
import { buildGitChangeTree, flattenGitChangeTreeFiles } from "../../m/git/change-tree.ts";
import {
  clampGitCommitFilesHeight,
  clampGitCommitFilesWidth,
  clampGitGraphListWidth,
  isCommitFilesSideBySide,
  loadGitCommitFilesHeight,
  loadGitCommitFilesWidth,
  loadGitGraphListWidth,
  saveGitCommitFilesHeight,
  saveGitCommitFilesWidth,
  saveGitGraphListWidth,
} from "../../m/git/graph-layout.ts";
import { buildCommitGraph, type GraphRowLayout } from "../../m/git/graph-lanes.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { settled } from "../workbench/drag-settle";
import { GitChangesTree } from "./GitChangesTree";
import { GitDiffPager } from "./GitDiffPager";
import { GitSplitHandle } from "./GitSplitHandle";
import { drillIn, registerGitLevels, type GitHost } from "./git-levels";
import { formatRelativeIso, laneStrokeColor } from "./git-ui-helpers";

const COL_W = 14;
const PAD_X = 10;
const REMOTE_DIFF_PREVIEW_BYTES = 200 * 1024;
const REMOTE_DIFF_FULL_BYTES = 640 * 1024;

function GraphLaneCanvas(props: { row: GraphRowLayout; rowHeight: number; maxVisibleCols: number }) {
  const cappedCols = () => Math.min(props.row.maxCols, props.maxVisibleCols);
  const width = () => Math.max(24, PAD_X * 2 + (cappedCols() - 1) * COL_W);
  const cxOf = (col: number) => PAD_X + Math.min(col, props.maxVisibleCols - 1) * COL_W;

  return (
    <Canvas
      testID="git-graph-row-canvas"
      class="shrink-0"
      style={{ width: width(), height: props.rowHeight, pointerEvents: "none" }}
      draw={(cx: CanvasRenderingContext2D) => {
        const row = props.row;
        const h = props.rowHeight;
        const midY = h / 2;
        cx.clearRect(0, 0, width(), h);
        cx.lineCap = "round";

        for (const edge of row.edges) {
          if (edge.fromCol >= props.maxVisibleCols && edge.toCol >= props.maxVisibleCols) continue;
          cx.beginPath();
          cx.strokeStyle = laneStrokeColor(edge.colorIndex);
          cx.lineWidth = 1.75;
          const x1 = cxOf(edge.fromCol);
          const x2 = cxOf(edge.toCol);
          const p = new Path2D();
          if (edge.kind === "through") {
            p.moveTo(x1, 0);
            p.lineTo(x1, h);
          } else if (edge.kind === "in") {
            p.moveTo(x1, 0);
            if (x1 === x2) p.lineTo(x2, midY);
            else p.bezierCurveTo(x1, midY * 0.55, x2, midY * 0.45, x2, midY);
          } else {
            p.moveTo(x1, midY);
            if (x1 === x2) p.lineTo(x2, h);
            else p.bezierCurveTo(x1, midY + (h - midY) * 0.55, x2, midY + (h - midY) * 0.45, x2, h);
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
  host?: GitHost;
  isRemote?: boolean;
  narrow: boolean;
  reloadToken: number;
  onDrillDepthChange?: (depth: number) => void;
}) {
  const t = () => copy();
  const isPage = () => props.host === "page";
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
  const fullDiffKey = signal<string | null>(null);
  const narrowStep = signal<"list" | "detail" | "diff">("list");

  const viewWidth = signal(Number.POSITIVE_INFINITY);
  const inspectorWidth = signal(0);
  const commitBodyHeight = signal(Number.POSITIVE_INFINITY);
  const graphListPreferred = signal(loadGitGraphListWidth());
  const commitFilesWidthPreferred = signal(loadGitCommitFilesWidth());
  const commitFilesHeightPreferred = signal(loadGitCommitFilesHeight());

  const graphListWidth = computed(() => clampGitGraphListWidth(graphListPreferred(), viewWidth()));
  const effectiveInspectorWidth = computed(() =>
    inspectorWidth() > 0 ? inspectorWidth() : Number.isFinite(viewWidth()) ? Math.max(0, viewWidth() - graphListWidth()) : 640,
  );
  const filesSideBySide = settled(() => isCommitFilesSideBySide(effectiveInspectorWidth(), props.narrow));
  const commitFilesWidth = computed(() => clampGitCommitFilesWidth(commitFilesWidthPreferred(), effectiveInspectorWidth()));
  const commitFilesHeight = computed(() => clampGitCommitFilesHeight(commitFilesHeightPreferred(), commitBodyHeight()));

  let graphDragOrigin = 0;
  let filesWidthDragOrigin = 0;
  let filesHeightDragOrigin = 0;

  const stepDepth = () => (narrowStep() === "diff" ? 2 : narrowStep() === "detail" ? 1 : 0);

  effect(() => {
    props.onDrillDepthChange?.(props.narrow ? stepDepth() : 0);
  });
  cleanup(() => props.onDrillDepthChange?.(0));

  registerGitLevels({
    name: "git-graph-drill",
    active: () => isPage() && props.narrow,
    depth: stepDepth,
    stepOut: () => {
      if (narrowStep() === "diff") narrowStep.set("detail");
      else if (narrowStep() === "detail") narrowStep.set("list");
    },
  });

  let logSeq = 0;
  let detailSeq = 0;
  let diffSeq = 0;
  let activeLogAc: AbortController | null = null;

  const fetchLog = (skip: number, append: boolean) => {
    const api = runtime.client;
    if (!api) return;
    activeLogAc?.abort();
    const ac = new AbortController();
    activeLogAc = ac;
    const req = ++logSeq;
    if (append) loadingMore.set(true);
    else loading.set(commits().length === 0);
    error.set(null);
    void api
      .gitLog(props.sessionId, { scope: scope(), limit: 150, skip, repo: props.repo, worktree: props.worktree }, ac.signal)
      .then((res) => {
        if (req !== logSeq || ac.signal.aborted) return;
        const next = append ? [...commits(), ...res.commits] : res.commits;
        commits.set(next);
        hasMore.set(res.has_more);
        if (!selectedOid() && next[0]) selectedOid.set(next[0].oid);
      })
      .catch((err) => {
        if (req !== logSeq || ac.signal.aborted) return;
        if (commits().length === 0) error.set(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (req === logSeq && !ac.signal.aborted) {
          loading.set(false);
          loadingMore.set(false);
        }
      });
  };
  cleanup(() => activeLogAc?.abort());

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
    const needsDetail = !props.narrow || narrowStep() !== "list";
    if (!oid || !api || !needsDetail) {
      untracked(() => {
        if (!oid) {
          detail.set(null);
          selectedFile.set(null);
          fileDiff.set(null);
        }
      });
      return;
    }
    const req = ++detailSeq;
    const ac = new AbortController();
    cleanup(() => ac.abort());
    untracked(() => {
      detailLoading.set(true);
      selectedFile.set(null);
      fileDiff.set(null);
      void api
        .gitCommit(props.sessionId, oid, { repo: props.repo, worktree: props.worktree }, ac.signal)
        .then((res) => {
          if (req !== detailSeq || ac.signal.aborted) return;
          detail.set(res);
          const first = flattenGitChangeTreeFiles(buildGitChangeTree(res.files))[0];
          selectedFile.set(first?.path ?? res.files[0]?.path ?? null);
        })
        .catch(() => {
          if (req === detailSeq && !ac.signal.aborted) detail.set(null);
        })
        .finally(() => {
          if (req === detailSeq && !ac.signal.aborted) detailLoading.set(false);
        });
    });
  });

  effect(() => {
    const oid = selectedOid();
    const path = selectedFile();
    const api = runtime.client;
    const remote = props.isRemote === true;
    const fullKey = fullDiffKey();
    const needsDiff = !props.narrow || narrowStep() === "diff";
    if (!oid || !path || !api || !needsDiff) {
      untracked(() => {
        if (!oid || !path) {
          fileDiff.set(null);
          fileDiffLoading.set(false);
        }
      });
      return;
    }
    const req = ++diffSeq;
    const ac = new AbortController();
    cleanup(() => ac.abort());
    const key = `${oid}\0${path}`;
    const maxBytes = remote ? (fullKey === key ? REMOTE_DIFF_FULL_BYTES : REMOTE_DIFF_PREVIEW_BYTES) : undefined;
    untracked(() => {
      fileDiffLoading.set(true);
      void api
        .gitDiff(props.sessionId, { path, commit: oid, repo: props.repo, worktree: props.worktree, maxBytes }, ac.signal)
        .then((res) => {
          if (req === diffSeq && !ac.signal.aborted) fileDiff.set(res);
        })
        .catch(() => {
          if (req === diffSeq && !ac.signal.aborted) fileDiff.set(null);
        })
        .finally(() => {
          if (req === diffSeq && !ac.signal.aborted) fileDiffLoading.set(false);
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

  const detailTree = computed(() => buildGitChangeTree(detail()?.files ?? []));
  const detailFiles = computed(() => flattenGitChangeTreeFiles(detailTree()));
  const selectedFileIndex = computed(() => {
    const p = selectedFile();
    if (!p) return -1;
    return detailFiles().findIndex((f) => f.path === p);
  });
  const selectCommitFile = (path: string) => {
    fullDiffKey.set(null);
    selectedFile.set(path);
    if (props.narrow) {
      drillIn(isPage(), () => narrowStep.set("diff"));
    }
  };
  const stepCommitFile = (delta: number) => {
    const next = detailFiles()[selectedFileIndex() + delta];
    if (next) {
      fullDiffKey.set(null);
      selectedFile.set(next.path);
    }
  };

  const copySha = (oid: string) => {
    void Clipboard.writeText(oid).catch(() => {});
    showToast(t().git.graph.copiedSha, { tone: "info" });
  };

  const rowHeight = () => (props.narrow ? 44 : 38);
  const maxVisibleCols = () => (props.narrow ? 5 : 16);

  const canLoadFull = () =>
    props.isRemote === true &&
    Boolean(fileDiff()?.truncated) &&
    fullDiffKey() !== `${selectedOid() ?? ""}\0${selectedFile() ?? ""}`;

  const graphListPane = () => (
    <View
      testID="git-graph-list-pane"
      class={`${props.narrow ? "flex-1" : "shrink-0"} min-h-0 bg-sidebar-bg`}
      style={props.narrow ? undefined : { width: graphListWidth() }}
    >
      <View class="px-[8px] py-[8px] gap-[6px] border-b border-line-subtle shrink-0">
        <View class="flex-row items-center gap-[6px]">
          <View
            role="button"
            testID="git-graph-scope-branch"
            onPress={() => scope.set("branch")}
            class={`cursor-pointer select-none px-[10px] rounded-(--radius-control-sm) items-center justify-center ${
              props.narrow ? "h-[32px]" : "h-[22px]"
            } ${scope() === "branch" ? "bg-accent-tint" : "hover:bg-row-hover"}`}
          >
            <Text class={`${props.narrow ? "text-[12.5px]" : "text-[11px]"} font-medium ${scope() === "branch" ? "text-brand" : "text-ink-muted"}`}>
              {t().git.graph.scopeBranch}
            </Text>
          </View>
          <View
            role="button"
            testID="git-graph-scope-all"
            onPress={() => scope.set("all")}
            class={`cursor-pointer select-none px-[10px] rounded-(--radius-control-sm) items-center justify-center ${
              props.narrow ? "h-[32px]" : "h-[22px]"
            } ${scope() === "all" ? "bg-accent-tint" : "hover:bg-row-hover"}`}
          >
            <Text class={`${props.narrow ? "text-[12.5px]" : "text-[11px]"} font-medium ${scope() === "all" ? "text-brand" : "text-ink-muted"}`}>
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
          class={`px-[10px] rounded-(--radius-sm) border border-line bg-input-bg text-ink ${
            props.narrow ? "h-[36px] text-[13px]" : "h-[26px] text-[12px]"
          }`}
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
          estimatedItemSize={rowHeight()}
          class="flex-1 min-h-0"
          contentStyle={{ paddingTop: 2, paddingBottom: 8 + (isPage() && props.narrow ? safeArea().bottom : 0) }}
        >
          {(row) => {
            const active = () => !props.narrow && selectedOid() === row().commit.oid;
            const maxRefs = () => (props.narrow ? 1 : 3);
            const shownRefs = () => row().commit.refs.slice(0, maxRefs());
            const extraRefs = () => Math.max(0, row().commit.refs.length - maxRefs());
            return (
              <View
                role="button"
                testID={`git-commit-${row().commit.short_oid}`}
                accessibilityState={{ selected: active() }}
                onPress={() => {
                  selectedOid.set(row().commit.oid);
                  if (props.narrow) {
                    drillIn(isPage(), () => narrowStep.set("detail"));
                  }
                }}
                class={`cursor-pointer select-none flex-row items-center pr-[10px] ${
                  active() ? "bg-accent-tint" : "hover:bg-row-hover active:bg-row-hover"
                }`}
                style={{ height: rowHeight() }}
              >
                <GraphLaneCanvas row={row()} rowHeight={rowHeight()} maxVisibleCols={maxVisibleCols()} />
                <View class="flex-1 min-w-0 gap-[2px]">
                  <View class="flex-row items-center gap-[4px] min-w-0">
                    <Each of={shownRefs()} key={(r) => `${r.kind}:${r.name}`}>
                      {(ref) => {
                        const st = () => refBadgeStyle(ref().kind);
                        return (
                          <View class={`px-[5px] h-[16px] rounded-(--radius-xs) items-center justify-center shrink-0 ${st().bg}`}>
                            <Text class={`font-mono text-[10px] font-medium ${st().text} max-w-[84px] line-clamp-1`}>{ref().name}</Text>
                          </View>
                        );
                      }}
                    </Each>
                    <If when={extraRefs() > 0}>
                      <View class="px-[4px] h-[16px] rounded-(--radius-xs) bg-chip items-center justify-center shrink-0">
                        <Text class="font-mono text-[9.5px] text-ink-muted">{`+${extraRefs()}`}</Text>
                      </View>
                    </If>
                    <Text class={`${props.narrow ? "text-[13px]" : "text-[12px]"} shrink min-w-0 line-clamp-1 ${active() ? "font-semibold text-brand" : "text-ink"}`}>
                      {row().commit.subject}
                    </Text>
                  </View>
                  <View class="flex-row items-center gap-[6px]">
                    <Text class="font-mono text-[10.5px] text-ink-muted">{row().commit.short_oid}</Text>
                    <Text class="text-[10.5px] text-ink-muted shrink min-w-0 line-clamp-1">{row().commit.author_name}</Text>
                    <Text class="text-[10.5px] text-ink-muted ml-auto shrink-0">
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
        <View
          class="p-[8px] border-t border-line-subtle shrink-0 items-center"
          style={isPage() && props.narrow ? { paddingBottom: 8 + safeArea().bottom } : undefined}
        >
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
    <View
      testID="git-commit-detail"
      class="flex-1 min-h-0 min-w-0 bg-pane"
      onLayout={(e) => inspectorWidth.set(e.bounds.size.width)}
    >
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
            <If when={!props.narrow || narrowStep() === "detail"}>
              <View
                class="px-[10px] py-[10px] border-b border-line-subtle gap-[5px] shrink-0 bg-sidebar-bg"
                style={isPage() && props.narrow ? { paddingTop: Math.max(8, safeArea().top) } : undefined}
              >
                <View class="flex-row items-center gap-[6px]">
                  <If when={props.narrow}>
                    <View
                      role="button"
                      testID="git-commit-back"
                      accessibilityLabel={t().common.back}
                      onPress={() => narrowStep.set("list")}
                      class={`cursor-pointer select-none flex-row items-center justify-center shrink-0 rounded-(--radius-control-sm) active:bg-row-hover hover:bg-row-hover ${
                        isPage() ? "w-[40px] h-[40px]" : "gap-[2px] px-[6px] h-[22px]"
                      }`}
                    >
                      <Icon name="chevron-left" size={isPage() ? 20 : 12} class="tint-ink-secondary" />
                      <If when={!isPage()}>
                        <Text class="text-[11px] text-ink-muted">{t().common.back}</Text>
                      </If>
                    </View>
                  </If>
                  <Text class="text-[13.5px] font-semibold text-ink flex-1 min-w-0 line-clamp-2">{d().subject}</Text>
                  <View
                    role="button"
                    testID="git-commit-copy-sha"
                    onPress={() => copySha(d().oid)}
                    class="cursor-pointer select-none flex-row items-center gap-[4px] px-[8px] h-[28px] rounded-(--radius-control-sm) bg-chip hover:bg-row-hover shrink-0"
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
            </If>

            <View
              testID="git-commit-body"
              class={`flex-1 min-h-0 min-w-0 ${filesSideBySide() ? "flex-row" : "flex-col"}`}
              onLayout={(e) => commitBodyHeight.set(e.bounds.size.height || Number.POSITIVE_INFINITY)}
            >
              <If when={!props.narrow || narrowStep() === "detail"}>
                <View
                  testID="git-commit-files-pane"
                  class={`${
                    props.narrow ? "flex-1 min-h-0" : filesSideBySide() ? "shrink-0 min-h-0" : "shrink-0 min-w-0"
                  } bg-sidebar-bg`}
                  style={
                    props.narrow
                      ? undefined
                      : filesSideBySide()
                        ? { width: commitFilesWidth() }
                        : { height: commitFilesHeight() }
                  }
                >
                  <GitChangesTree
                    nodes={detailTree()}
                    selectedPath={selectedFile()}
                    narrow={props.narrow}
                    resetKey={d().oid}
                    testID="git-commit-files-tree"
                    dirTestIdPrefix="git-commit-dir-"
                    fileTestIdPrefix="git-commit-file-"
                    bottomInset={isPage() && props.narrow ? safeArea().bottom : 0}
                    onSelectFile={selectCommitFile}
                  />
                </View>
              </If>

              <If when={!props.narrow && filesSideBySide()}>
                <GitSplitHandle
                  axis="vertical"
                  testID="git-commit-files-split"
                  label={t().git.graph.resizeFilesWidth}
                  onDragStart={() => {
                    filesWidthDragOrigin = commitFilesWidth();
                  }}
                  onDragDelta={(dx) => {
                    commitFilesWidthPreferred.set(clampGitCommitFilesWidth(filesWidthDragOrigin + dx, effectiveInspectorWidth()));
                  }}
                  onDragEnd={() => saveGitCommitFilesWidth(commitFilesWidthPreferred())}
                />
              </If>

              <If when={!props.narrow && !filesSideBySide()}>
                <GitSplitHandle
                  axis="horizontal"
                  testID="git-commit-files-split-v"
                  label={t().git.graph.resizeFilesHeight}
                  onDragStart={() => {
                    filesHeightDragOrigin = commitFilesHeight();
                  }}
                  onDragDelta={(dy) => {
                    commitFilesHeightPreferred.set(clampGitCommitFilesHeight(filesHeightDragOrigin + dy, commitBodyHeight()));
                  }}
                  onDragEnd={() => saveGitCommitFilesHeight(commitFilesHeightPreferred())}
                />
              </If>

              <If when={!props.narrow || narrowStep() === "diff"}>
                <GitDiffPager
                  diff={fileDiff()}
                  loading={fileDiffLoading()}
                  error={null}
                  host={props.host}
                  narrow={props.narrow}
                  index={selectedFileIndex()}
                  total={detailFiles().length}
                  onPrev={() => stepCommitFile(-1)}
                  onNext={() => stepCommitFile(1)}
                  onLoadFull={
                    canLoadFull() ? () => fullDiffKey.set(`${selectedOid() ?? ""}\0${selectedFile() ?? ""}`) : undefined
                  }
                  onBack={props.narrow ? () => narrowStep.set("detail") : undefined}
                />
              </If>
            </View>
          </View>
        )}
      </If>
    </View>
  );

  return (
    <View
      testID="git-graph-view"
      class="flex-1 min-h-0 flex-row"
      onLayout={(e) => viewWidth.set(e.bounds.size.width || Number.POSITIVE_INFINITY)}
    >
      <If when={!props.narrow || narrowStep() === "list"}>{graphListPane()}</If>
      <If when={!props.narrow}>
        <GitSplitHandle
          axis="vertical"
          testID="git-graph-split"
          label={t().git.graph.resizeCommits}
          onDragStart={() => {
            graphDragOrigin = graphListWidth();
          }}
          onDragDelta={(dx) => {
            graphListPreferred.set(clampGitGraphListWidth(graphDragOrigin + dx, viewWidth()));
          }}
          onDragEnd={() => saveGitGraphListWidth(graphListPreferred())}
        />
      </If>
      <If when={!props.narrow || narrowStep() !== "list"}>{commitInspector()}</If>
    </View>
  );
}
