/**
 * The workbench: a layout of three panes (two tabbed, one stacked beside) built from the mirrored
 * layout-tree helpers, placeholder views for the tab bodies, the + menu with the running terminals the
 * story supplies, and a readout of the layout (`wb-state`) a test reads after a split, a drag, a
 * float or a close, and how many times each tab's body was built (`wb-mounts`). The shell's own render props (conversations, the file tree, a terminal) are not
 * here: the workbench takes them as functions.
 */
import { signal, Text, untracked, View } from "nsh";
import type { Terminal } from "@real-bot/protocol";
import { copy } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { statusLabel } from "../src/m/overlays/terminals.ts";
import { narrowWindow } from "../src/ui/Modal";
import { NewPaneMenu, type NewPaneHost } from "../src/ui/workbench/NewPaneMenu";
import { PaneTabLabel } from "../src/ui/workbench/PaneTabLabel";
import { Workbench, type WorkbenchApi } from "../src/ui/workbench/Workbench";
import type { TabAction } from "../src/ui/workbench/types";
import { activateTab, addTab, closeTab, makeBranch, makeLeaf } from "../src/m/workbench/layout-tree.ts";
import type { LayoutNode, WorkbenchLayout, WorkbenchTab } from "../src/m/workbench/layout-types.ts";
import type { PaneContent, PaneKind } from "../src/m/workbench/pane-content.ts";
import type { PaneEdit } from "../src/m/workbench/pane-edit.ts";

const tab = (id: string, kind: PaneKind, title: string): WorkbenchTab => ({ id, kind, params: { title } });

function initial(): WorkbenchLayout {
  const root = makeBranch("r", "row", [
    makeLeaf("a", [tab("t1", "routines", "日程"), tab("t2", "usage", "用量"), tab("t3", "spend", "账单")]),
    makeBranch("c", "column", [makeLeaf("b", [tab("t4", "terminal", "zsh")]), makeLeaf("d", [tab("t5", "workspace", "文件")])]),
  ]);
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: "a" } };
}

/** The layout as one line: `r:row[0.50/0.50](a[t1,*t2,t3] c:col[0.50/0.50](b[t4] d[t5])) float=f1[t6]@10,20,300x200 focus=a`. */
export function describe(layout: WorkbenchLayout): string {
  const leaf = (n: LayoutNode): string =>
    n.type === "leaf"
      ? `${n.id}[${n.tabs.map((x) => (x.id === n.activeTabId ? "*" : "") + x.id).join(",")}]`
      : `${n.id}:${n.axis === "row" ? "row" : "col"}[${n.weights.map((w) => w.toFixed(2)).join("/")}](${n.children.map(leaf).join(" ")})`;
  const floats = layout.floating.map((pane) => `${pane.leaf.id}[${pane.leaf.tabs.map((x) => x.id).join(",")}]@${Math.round(pane.frame.x)},${Math.round(pane.frame.y)},${Math.round(pane.frame.width)}x${Math.round(pane.frame.height)}`);
  return `${leaf(layout.root)} float=${floats.join(";") || "-"} focus=${layout.focus.leafId}`;
}

const TERMINALS = [
  { id: "term-1", cwd: "/work/api", title: "api server", status: "live", exit_code: null },
  { id: "term-2", cwd: "/work/web", title: "vite", status: "live", exit_code: null },
  { id: "term-3", cwd: "/work/ci", title: "build", status: "exited", exit_code: 2 },
] as unknown as Terminal[];

export default function WorkbenchStory() {
  const layout = signal<WorkbenchLayout>(initial());
  const pinned = signal(false);
  const copied = signal("");
  const log = signal("");
  let seq = 0;
  const freshId = () => `story-${++seq}`;
  const commit = (next: WorkbenchLayout) => layout.set(next);
  /** Times each tab's body was built: a commit that keeps the tab must not build it again. */
  const mounts = signal<Record<string, number>>({});
  const mounted = (id: string) => untracked(() => mounts.set({ ...mounts(), [id]: (mounts()[id] ?? 0) + 1 }));
  let api: WorkbenchApi | null = null;

  /** More tabs than the first pane's strip can show, so it scrolls. */
  const addMany = () => {
    let next = layout();
    for (let i = 1; i <= 10; i++) next = addTab(next, "a", tab(`m${i}`, "routines", `标签页 ${i}`));
    commit(next);
  };

  /** A conversation pulled in from the list: the list row's own gesture drives the session. */
  const dragIn = () => {
    const session = api?.dragIn({ tab: tab("t9", "usage", "外来") }, "外来", { x: 300, y: 200 });
    session?.move({ x: 850, y: 260 });
    session?.end();
  };

  /** What the shell's workbench does for the + menu: open content in a pane as a new tab. */
  const host: NewPaneHost = {
    untabbedTerminals: TERMINALS,
    // The shell's own naming: the title, then how a finished session ended.
    terminalName: (row: Terminal) => {
      const status = statusLabel(row, copy());
      return status ? `${row.title} · ${status}` : row.title;
    },
    openNewTerminal: async (leafId: string | null) => {
      if (leafId) commit(addTab(layout(), leafId, tab(freshId(), "terminal", "zsh")));
    },
    openInPane: (leafId: string, content: PaneContent) => {
      const title = content.kind === "terminal" ? (TERMINALS.find((row) => row.id === content.terminalId)?.title ?? "zsh") : content.kind;
      commit(addTab(layout(), leafId, tab(freshId(), content.kind, title)));
    },
  } as unknown as NewPaneHost;

  const tabActions = (_leafId: string, t: WorkbenchTab): TabAction[] =>
    t.id === "t1" ? [{ id: "pin", label: pinned() ? "取消固定" : "固定", active: pinned(), run: () => pinned.set(!pinned()) }] : [];

  /** The terminal's Copy and Paste: only its pane's body keeps its own selection (a tab's own menu is not the terminal). */
  const paneEdit = (leafId: string, tabId: string | null): PaneEdit | null =>
    leafId === "b" && tabId === null ? { canCopy: () => true, copy: () => copied.set("copied"), paste: () => copied.set("pasted") } : null;

  return (
    <View class="flex-1 bg-bg">
      <View class="flex-row items-center gap-3 px-3 py-2">
        <Button variant="secondary" testID="story-reset" onPress={() => layout.set(initial())}>
          reset
        </Button>
        <Button variant="secondary" testID="story-many" onPress={addMany}>
          many
        </Button>
        <Button variant="secondary" testID="story-dragin" onPress={dragIn}>
          drag in
        </Button>
        {/* The same layout as new objects, as the shell's `snapshot(workbench.layout)` hands over on every commit. */}
        <Button variant="secondary" testID="story-copy" onPress={() => commit(JSON.parse(JSON.stringify(layout())) as WorkbenchLayout)}>
          copy
        </Button>
        <Text testID="wb-state" class="flex-1 text-[11px] text-ink-muted">{describe(layout())}</Text>
        <Text testID="wb-note" class="text-[11px] text-ink-muted">{`${pinned() ? "pinned" : "loose"} ${copied()} ${log()}`}</Text>
        <Text testID="wb-mounts" class="text-[11px] text-ink-muted">{`mounts ${Object.entries(mounts()).map(([id, n]) => `${id}=${n}`).join(",")}`}</Text>
      </View>
      <View class="flex-1 min-h-0">
        <Workbench
          layout={layout()}
          mins={() => ({ width: 160, height: 120 })}
          wide={!narrowWindow()}
          tabName={(t) => t.params.title ?? t.kind}
          onLayout={commit}
          onViewport={(box) => log.set(`${Math.round(box.width)}x${Math.round(box.height)}`)}
          onActivate={(leafId, tabId) => commit(activateTab(layout(), leafId, tabId))}
          onCloseTab={(leafId, tabId) => commit(closeTab(layout(), leafId, tabId, freshId()))}
          tabActions={tabActions}
          paneEdit={paneEdit}
          onApi={(handle) => (api = handle)}
          tabBody={(t, leafId) => {
            mounted(t.id);
            return (
              <View testID={`body-${t.id}`} onPress={() => {}} class="flex-1 p-4 gap-1">
                <Text class="text-[14px] font-semibold text-ink">{t.params.title ?? t.kind}</Text>
                <Text class="text-[12px] text-ink-muted">{`${t.kind} · ${leafId}`}</Text>
              </View>
            );
          }}
          tabLabel={(t) => <PaneTabLabel kind={t.kind as PaneKind} title={t.params.title ?? t.kind} />}
          emptyLead={() => (
            <Button variant="primary" icon="user-plus" testID="story-empty-lead" onPress={() => log.set("lead")}>
              add
            </Button>
          )}
          menuActions={(leafId, query, close) => <NewPaneMenu workbench={host} leafId={leafId} query={query} onPick={close} />}
        />
      </View>
    </View>
  );
}
