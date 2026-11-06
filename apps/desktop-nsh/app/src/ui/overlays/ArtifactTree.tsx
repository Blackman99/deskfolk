/**
 * A tree of files (`ArtifactTree.svelte`): a bundle's, or the workspace's. Folders open and fold
 * (`collapsed`, or `expandedLazy` when `lazyDirs`: the folder's listing is asked for on opening),
 * a file selects. Rows are picked with ⌘/Ctrl (one more) or Shift (a range from the last row
 * clicked); a right click or long press reports the row with every row it acts on (`picked`);
 * ⌘⌫ / Ctrl+⌫ or Delete on a focused row asks to trash them; dragging rows (when `dragLabel` is
 * given) carries their paths to a composer (`workspace-drag.ts`). Loading, failed and empty
 * states are lines in the tree, a folder's own below its row.
 *
 * `bind:collapsed` / `bind:expandedLazy` are `collapsed` + `onCollapsedChange` and `expandedLazy`
 * + `onExpandedLazyChange`; the sets are replaced whole. Without them the tree keeps its own.
 * Rows' test ids: `artifact-tree-row:<path>`; the retry button's `artifact-tree-retry`.
 * Not carried over: the loading ring does not spin.
 */
import { effect, keymap, signal, Text, token, View, type JSX } from "nsh";
import type { ArtifactTreeNode } from "../../m/overlays/artifact-tree.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { FileIcon } from "./FileIcon";
import { treeRange, visibleTreePaths } from "../../m/overlays/artifact-tree.ts";
import { pressWorkspacePaths } from "../workspace-drag";
import { tip } from "../tip";

type Line =
  | { key: string; type: "row"; node: ArtifactTreeNode; depth: number }
  | { key: string; type: "state"; busy: boolean; error: boolean; depth: number; retry?: () => void }
  | { key: string; type: "note"; text: string };

export function ArtifactTree(props: {
  nodes: ArtifactTreeNode[];
  selected: string;
  label: string;
  onSelect: (node: ArtifactTreeNode) => void;
  /** Right-click (or long press) on a row, at window coordinates; `picked` is what the menu acts on. */
  onContextMenu?: (node: ArtifactTreeNode, at: { x: number; y: number }, picked: ArtifactTreeNode[]) => void;
  /** Trash key on a focused row, with the rows it applies to. */
  onTrash?: (picked: ArtifactTreeNode[]) => void;
  /** Rows can be dragged onto a composer; what the chip says for more than one row. */
  dragLabel?: (count: number) => string;
  lazyDirs?: boolean;
  loadedDirs?: ReadonlySet<string>;
  onExpandDir?: (path: string) => void;
  truncatedLabel?: string;
  loadingDirs?: ReadonlySet<string>;
  failedDirs?: ReadonlySet<string>;
  loading?: boolean;
  failed?: boolean;
  loadingLabel: string;
  failedLabel: string;
  emptyLabel: string;
  retryLabel: string;
  onRetry?: () => void;
  /** The folders folded shut, and the lazily listed ones opened. */
  collapsed?: Set<string>;
  onCollapsedChange?: (next: Set<string>) => void;
  expandedLazy?: Set<string>;
  onExpandedLazyChange?: (next: Set<string>) => void;
}) {
  /** Rows picked with ⌘/Ctrl or Shift. Empty: the file on screen is the one highlighted. */
  const picked = signal<string[]>([]);
  let anchor: string | null = null;
  const ownCollapsed = signal(new Set<string>());
  const ownExpanded = signal(new Set<string>());
  const focused = signal<string | null>(null);

  const collapsed = () => props.collapsed ?? ownCollapsed();
  const expandedLazy = () => props.expandedLazy ?? ownExpanded();
  const setCollapsed = (next: Set<string>) => {
    ownCollapsed.set(next);
    props.onCollapsedChange?.(next);
  };
  const setExpanded = (next: Set<string>) => {
    ownExpanded.set(next);
    props.onExpandedLazyChange?.(next);
  };
  const isOpen = (path: string) => (props.lazyDirs ? expandedLazy().has(path) : !collapsed().has(path));

  const byPath = () => {
    const map = new Map<string, ArtifactTreeNode>();
    const walk = (list: readonly ArtifactTreeNode[]) => {
      for (const node of list) {
        map.set(node.path, node);
        if (node.children) walk(node.children);
      }
    };
    walk(props.nodes);
    return map;
  };
  const order = () => visibleTreePaths(props.nodes, isOpen);
  /** Rows that went away, trashed or renamed on disk, drop out of what is picked. */
  const livePicked = () => {
    const map = byPath();
    return picked().filter((path) => map.has(path));
  };
  const highlighted = () => new Set(livePicked().length ? livePicked() : [props.selected]);

  // Another file opened from elsewhere (a chat chip, a flow card) is the new selection.
  let lastSelected = props.selected;
  effect(() => {
    const now = props.selected;
    if (now === lastSelected) return;
    lastSelected = now;
    picked.set([]);
    anchor = null;
  });

  /** What an action on `node` applies to, in screen order: everything highlighted if it is, else it alone. */
  const targetsFor = (node: ArtifactTreeNode): ArtifactTreeNode[] => {
    const lit = highlighted();
    if (!lit.has(node.path)) return [node];
    const rows = order();
    const rank = (path: string) => {
      const at = rows.indexOf(path);
      return at < 0 ? rows.length : at;
    };
    const map = byPath();
    return [...lit]
      .sort((a, b) => rank(a) - rank(b))
      .map((path) => map.get(path))
      .filter((row): row is ArtifactTreeNode => Boolean(row));
  };

  const onNode = (node: ArtifactTreeNode) => {
    if (node.kind === "file") {
      props.onSelect(node);
      return;
    }
    if (props.lazyDirs) {
      const next = new Set(expandedLazy());
      if (next.has(node.path)) {
        next.delete(node.path);
        setExpanded(next);
        return;
      }
      next.add(node.path);
      setExpanded(next);
      if (!props.loadedDirs?.has(node.path)) props.onExpandDir?.(node.path);
      return;
    }
    if (!node.children?.length) {
      props.onSelect(node);
      return;
    }
    const next = new Set(collapsed());
    if (next.has(node.path)) next.delete(node.path);
    else next.add(node.path);
    setCollapsed(next);
  };

  const onRowPress = (node: ArtifactTreeNode, mods: { shift: boolean; platform: boolean; control: boolean }) => {
    if (mods.shift) {
      const rows = order();
      const from = anchor ?? (rows.includes(props.selected) ? props.selected : null);
      picked.set(treeRange(rows, from, node.path));
      anchor = from ?? node.path;
      return;
    }
    if (mods.platform || mods.control) {
      // The file on screen was the selection until now, so it stays in what is picked.
      const live = livePicked();
      const base = live.length ? live : order().includes(props.selected) ? [props.selected] : [];
      picked.set(base.includes(node.path) ? base.filter((path) => path !== node.path) : [...base, node.path]);
      anchor = node.path;
      return;
    }
    picked.set([]);
    anchor = node.path;
    onNode(node);
  };

  const onRowMenu = (node: ArtifactTreeNode, at: { x: number; y: number }) => {
    if (!props.onContextMenu) return;
    const targets = targetsFor(node);
    // Right-clicking outside the selection selects that row, so the highlight shows what the menu acts on.
    if (!highlighted().has(node.path)) {
      picked.set([node.path]);
      anchor = node.path;
    }
    props.onContextMenu(node, at, targets);
  };

  /** A press that may become a drag: of everything highlighted when this row is, else of this row. */
  const dragFor = (node: ArtifactTreeNode) =>
    pressWorkspacePaths({
      items: () => targetsFor(node).map((row) => ({ path: row.path, isDir: row.kind === "dir" })),
      label: (items) => (items.length === 1 ? (byPath().get(items[0]!.path)?.name ?? items[0]!.path) : (props.dragLabel?.(items.length) ?? "")),
    });

  // Escape drops a multi-pick; the trash keys act on the focused row. Bound only while they apply.
  effect(() => {
    if (!livePicked().length) return;
    return keymap.bind("escape", () => picked.set([]), { when: "always" });
  });
  effect(() => {
    const path = focused();
    if (!path || !props.onTrash) return;
    const trash = () => {
      const node = byPath().get(path);
      if (node) props.onTrash?.(targetsFor(node));
    };
    const offs = [keymap.bind("mod+backspace", trash), keymap.bind("delete", trash)];
    return () => offs.forEach((off) => off());
  });

  const lines = (): Line[] => {
    const out: Line[] = [];
    if (props.loading || props.failed || props.nodes.length === 0) {
      out.push({ key: "state:root", type: "state", busy: props.loading ?? false, error: props.failed ?? false, depth: 0, retry: props.onRetry });
    }
    const walk = (list: readonly ArtifactTreeNode[], depth: number) => {
      for (const node of list) {
        out.push({ key: `row:${node.path}`, type: "row", node, depth });
        if (node.kind !== "dir" || !isOpen(node.path)) continue;
        const busy = props.loadingDirs?.has(node.path) ?? false;
        const error = props.failedDirs?.has(node.path) ?? false;
        if (props.lazyDirs && (busy || error || (props.loadedDirs?.has(node.path) && !node.children?.length && !node.truncated))) {
          out.push({ key: `state:${node.path}`, type: "state", busy, error, depth: depth + 1, retry: () => props.onExpandDir?.(node.path) });
        }
        if (node.truncated && props.truncatedLabel) out.push({ key: `note:${node.path}`, type: "note", text: props.truncatedLabel });
        walk(node.children ?? [], depth + 1);
      }
    };
    walk(props.nodes, 0);
    return out;
  };

  const stateBlock = (line: Extract<Line, { type: "state" }>): JSX.Element => (
    <View testID="artifact-tree-state" style={{ paddingLeft: 12 + line.depth * 12 }} class="py-[10px] pr-3 gap-[6px]">
      {line.busy ? (
        <View role="text" accessibilityState={{ busy: true }} accessibilityLabel={props.loadingLabel} class="flex-row items-center gap-2">
          <View accessible={false} class="w-3 h-3 rounded-full border-2 border-line" style={{ borderTopColor: token("brand") }} />
          <Text class="text-[12px] leading-[18px] text-ink-muted">{props.loadingLabel}</Text>
        </View>
      ) : line.error ? (
        <>
          <Text role="alert" class="text-[12px] leading-[18px] text-ink-muted">{props.failedLabel}</Text>
          <View
            role="button"
            testID="artifact-tree-retry"
            accessibilityLabel={props.retryLabel}
            onPress={() => line.retry?.()}
            class="self-start min-h-[32px] px-[10px] py-1 items-center justify-center border border-line rounded-(--radius-sm) bg-pane hover:bg-row-hover"
          >
            <Text class="text-[12px] text-brand">{props.retryLabel}</Text>
          </View>
        </>
      ) : (
        <Text role="text" class="text-[12px] leading-[18px] text-ink-muted">{props.emptyLabel}</Text>
      )}
    </View>
  );

  const rowBlock = (node: ArtifactTreeNode, depth: number): JSX.Element => {
    const pan = props.dragLabel ? dragFor(node) : null;
    const lit = () => highlighted().has(node.path);
    return (
      <View
        role="button"
        testID={`artifact-tree-row:${node.path}`}
        accessibilityLabel={node.name}
        accessibilityState={{ expanded: node.kind === "dir" ? isOpen(node.path) : undefined, selected: lit() }}
        tooltip={tip(node.path)}
        onFocus={() => focused.set(node.path)}
        onBlur={() => focused() === node.path && focused.set(null)}
        onPress={(e) => onRowPress(node, e.modifiers)}
        onLongPress={(e) => onRowMenu(node, e.pagePosition)}
        onContextMenu={(e) => onRowMenu(node, e.pagePosition)}
        {...(pan ? pan.panHandlers : {})}
        class={`flex-row items-center gap-1 w-full py-1 pr-[10px] ${lit() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {node.kind === "dir" ? (
          <Text accessible={false} class="w-3 text-[10px] text-ink-muted text-center" style={{ transform: isOpen(node.path) ? "rotate(90deg)" : "rotate(0deg)" }}>
            ▸
          </Text>
        ) : null}
        <View accessible={false} class="w-3 items-center justify-center">
          <FileIcon icon={fileIconFor(node.path, { isDir: node.kind === "dir" })} size={12} />
        </View>
        <Text class={`shrink min-w-0 text-[12px] leading-[16px] line-clamp-1 ${lit() ? "text-brand" : "text-ink"}`}>{node.name}</Text>
        {node.fresh ? <View accessible={false} class="ml-auto w-[6px] h-[6px] rounded-full bg-brand" /> : null}
      </View>
    );
  };

  return (
    <View role="group" accessibilityLabel={props.label} testID="workspace-tree" class="min-w-0 flex-1 py-2 bg-sidebar-bg border-r border-line">
      <Each of={lines()} key={(line) => line.key}>
        {(line) => {
          const l = () => line();
          return (
            <>
              {l().type === "row" ? rowBlock((l() as Extract<Line, { type: "row" }>).node, (l() as Extract<Line, { type: "row" }>).depth) : null}
              {l().type === "state" ? stateBlock(l() as Extract<Line, { type: "state" }>) : null}
              {l().type === "note" ? (
                <Text class="pt-2 pr-5 pb-2 pl-12 text-[11px] text-ink-muted">{(l() as Extract<Line, { type: "note" }>).text}</Text>
              ) : null}
            </>
          );
        }}
      </Each>
    </View>
  );
}
