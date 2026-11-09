/**
 * A tree of files (`ArtifactTree.svelte`): a bundle's, or the workspace's. Folders open and fold
 * (`collapsed`, or `expandedLazy` when `lazyDirs`: the folder's listing is asked for on opening),
 * a file selects. Rows are picked with ⌘/Ctrl (one more) or Shift (a range from the last row
 * clicked); a right click or long press reports the row with every row it acts on (`picked`);
 * ⌘⌫ / Ctrl+⌫ or Delete on a focused row asks to trash them; dragging rows (when `dragLabel` is
 * given) carries their paths to a composer (`workspace-drag.ts`). Loading, failed and empty
 * states are lines in the tree, a folder's own below its row.
 *
 * On nsh/base's `Tree`, which makes only the rows in view, scrolls them natively and keeps the
 * keys of a tree (arrows, Home and End, typeahead; Return opens a file or a folder). What a row
 * looks like and what pressing it does are this file's (`renderItem`): a row's own press is heard
 * instead of the Tree's, so the picks above work as before. A folder's loading, failed and empty
 * lines and its truncation note are items under it; a lazy folder not listed yet has its loading
 * line, so it can open, and opening it asks for the listing.
 *
 * Drawn with `Each`, every row was made whatever was in view, opening a folder made every row
 * again, and each row's highlight walked the whole tree: on 1,740 rows a pick took 3.5 s and a
 * folder 1.9 s. On `Tree` both take a frame.
 *
 * `bind:collapsed` / `bind:expandedLazy` are `collapsed` + `onCollapsedChange` and `expandedLazy`
 * + `onExpandedLazyChange`; the sets are replaced whole. Without them the tree keeps its own.
 * Rows' test ids: `artifact-tree-row:<path>` (only the rows in view are made); the retry button's
 * `artifact-tree-retry`. Not carried over: the loading ring does not spin.
 */
import { computed, effect, keymap, signal, Text, token, untracked, View, type JSX } from "nsh";
import { Tree, type TreeItem, type TreeRef } from "nsh/base";
import type { ArtifactTreeNode } from "../../m/overlays/artifact-tree.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { FileIcon } from "./FileIcon";
import { treeRange, visibleTreePaths } from "../../m/overlays/artifact-tree.ts";
import { pressWorkspacePaths } from "../workspace-drag";
import { tip } from "../tip";

/** The lines that are not files: ids no path can be. */
const STATE = "\u0000state:";
const NOTE = "\u0000note:";

type Extra = { type: "state"; busy: boolean; error: boolean; retry?: () => void } | { type: "note"; text: string };

const sameStrings = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

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
  /** The row the Tree's keys act on: the file on screen until the arrows move it. */
  const cursor = signal<string | null>(props.selected || null);
  let tree: TreeRef | null = null;

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

  /** The Tree's items, with what the rows need to know beside them: made once per listing or state. */
  const model = computed(() => {
    const byPath = new Map<string, ArtifactTreeNode>();
    const extra = new Map<string, Extra>();
    const dirs: string[] = [];
    const line = (id: string, value: Extra): TreeItem => {
      extra.set(id, value);
      return { id, label: value.type === "note" ? value.text : "", disabled: true };
    };
    const walk = (list: readonly ArtifactTreeNode[]): TreeItem[] =>
      list.map((node) => {
        byPath.set(node.path, node);
        if (node.kind !== "dir") return { id: node.path, label: node.name };
        dirs.push(node.path);
        const under: TreeItem[] = [];
        if (props.lazyDirs) {
          const busy = props.loadingDirs?.has(node.path) ?? false;
          const error = props.failedDirs?.has(node.path) ?? false;
          const listed = props.loadedDirs?.has(node.path) ?? false;
          if (busy || error || !listed || (!node.children?.length && !node.truncated)) {
            under.push(line(`${STATE}${node.path}`, { type: "state", busy: busy || (!listed && !error), error, retry: () => props.onExpandDir?.(node.path) }));
          }
        }
        if (node.truncated && props.truncatedLabel) under.push(line(`${NOTE}${node.path}`, { type: "note", text: props.truncatedLabel }));
        under.push(...walk(node.children ?? []));
        return { id: node.path, label: node.name, children: under.length > 0 ? under : undefined };
      });
    const items: TreeItem[] = [];
    if (props.loading || props.failed || props.nodes.length === 0) {
      items.push(line(`${STATE}.`, { type: "state", busy: props.loading ?? false, error: props.failed ?? false, retry: props.onRetry }));
    }
    items.push(...walk(props.nodes));
    return { items, byPath, extra, dirs };
  });
  const byPath = () => model().byPath;

  const expandedIds = computed(() => (props.lazyDirs ? [...expandedLazy()] : model().dirs.filter((path) => !collapsed().has(path))), { equals: sameStrings });
  const order = () => visibleTreePaths(props.nodes, isOpen);
  /** Rows that went away, trashed or renamed on disk, drop out of what is picked. */
  const livePicked = computed(() => {
    const map = byPath();
    return picked().filter((path) => map.has(path));
  });
  const highlighted = computed(() => new Set(livePicked().length ? livePicked() : [props.selected]));

  // Another file opened from elsewhere (a chat chip, a flow card) is the new selection, brought into view.
  let lastSelected = props.selected;
  effect(() => {
    const now = props.selected;
    if (now === lastSelected) return;
    lastSelected = now;
    picked.set([]);
    anchor = null;
    cursor.set(now || null);
    if (now && untracked(byPath).has(now)) queueMicrotask(() => tree?.revealItem(now));
  });

  /** What an action on `path` applies to, in screen order: everything highlighted if it is, else it alone. */
  const targetsFor = (path: string): ArtifactTreeNode[] => {
    const map = byPath();
    const lit = highlighted();
    if (!lit.has(path)) {
      const node = map.get(path);
      return node ? [node] : [];
    }
    const rows = order();
    const rank = (p: string) => {
      const at = rows.indexOf(p);
      return at < 0 ? rows.length : at;
    };
    return [...lit]
      .sort((a, b) => rank(a) - rank(b))
      .map((p) => map.get(p))
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

  /** The Tree's own opening and folding (Right, Left, Return, a reveal): a lazy folder opened is listed. */
  const onExpandedChange = (ids: string[]) => {
    const next = new Set(ids.filter((id) => !id.startsWith("\u0000")));
    if (props.lazyDirs) {
      const was = expandedLazy();
      setExpanded(next);
      for (const id of next) if (!was.has(id) && !props.loadedDirs?.has(id)) props.onExpandDir?.(id);
      return;
    }
    const shut = new Set(model().dirs.filter((path) => !next.has(path)));
    const now = collapsed();
    if (shut.size !== now.size || [...shut].some((path) => !now.has(path))) setCollapsed(shut);
  };

  const onRowPress = (node: ArtifactTreeNode, mods: { shift: boolean; platform: boolean; control: boolean }) => {
    cursor.set(node.path);
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
    const targets = targetsFor(node.path);
    // Right-clicking outside the selection selects that row, so the highlight shows what the menu acts on.
    if (!highlighted().has(node.path)) {
      picked.set([node.path]);
      anchor = node.path;
    }
    props.onContextMenu(node, at, targets);
  };

  /** A press that may become a drag: of everything highlighted when this row is, else of this row. */
  const dragFor = (path: string) =>
    pressWorkspacePaths({
      items: () => targetsFor(path).map((row) => ({ path: row.path, isDir: row.kind === "dir" })),
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
      if (byPath().has(path)) props.onTrash?.(targetsFor(path));
    };
    const offs = [keymap.bind("mod+backspace", trash), keymap.bind("delete", trash)];
    return () => offs.forEach((off) => off());
  });

  const stateBlock = (id: string, depth: number): JSX.Element => {
    const line = () => model().extra.get(id) as Extract<Extra, { type: "state" }> | undefined;
    return (
      <View testID="artifact-tree-state" style={{ paddingLeft: 12 + depth * 12 }} class="w-full py-[10px] pr-3 gap-[6px]">
        <If when={line()?.busy}>
          <View role="text" accessibilityState={{ busy: true }} accessibilityLabel={props.loadingLabel} class="flex-row items-center gap-2">
            <View accessible={false} class="w-3 h-3 rounded-full border-2 border-line" style={{ borderTopColor: token("brand") }} />
            <Text class="text-[12px] leading-[18px] text-ink-muted">{props.loadingLabel}</Text>
          </View>
        </If>
        <If when={!line()?.busy && line()?.error}>
          <>
            <Text role="alert" class="text-[12px] leading-[18px] text-ink-muted">{props.failedLabel}</Text>
            <View
              role="button"
              testID="artifact-tree-retry"
              accessibilityLabel={props.retryLabel}
              onPress={() => line()?.retry?.()}
              class="self-start min-h-[32px] px-[10px] py-1 items-center justify-center border border-line rounded-(--radius-sm) bg-pane hover:bg-row-hover"
            >
              <Text class="text-[12px] text-brand">{props.retryLabel}</Text>
            </View>
          </>
        </If>
        <If when={!line()?.busy && !line()?.error}>
          <Text role="text" class="text-[12px] leading-[18px] text-ink-muted">{props.emptyLabel}</Text>
        </If>
      </View>
    );
  };

  const rowBlock = (path: string, depth: number): JSX.Element => {
    const node = () => byPath().get(path);
    const isDir = () => node()?.kind === "dir";
    const pan = props.dragLabel ? dragFor(path) : null;
    const lit = () => highlighted().has(path);
    return (
      <View
        role="button"
        testID={`artifact-tree-row:${path}`}
        accessibilityLabel={node()?.name ?? path}
        accessibilityState={{ expanded: isDir() ? isOpen(path) : undefined, selected: lit() }}
        tooltip={tip(path)}
        onFocus={() => focused.set(path)}
        onBlur={() => focused() === path && focused.set(null)}
        onPress={(e) => {
          const n = node();
          if (n) onRowPress(n, e.modifiers);
        }}
        onLongPress={(e) => {
          const n = node();
          if (n) onRowMenu(n, e.pagePosition);
        }}
        onContextMenu={(e) => {
          const n = node();
          if (n) onRowMenu(n, e.pagePosition);
        }}
        {...(pan ? pan.panHandlers : {})}
        class={`flex-row items-center gap-1 w-full py-1 pr-[10px] ${lit() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <If when={isDir()}>
          <Text accessible={false} class="w-3 text-[10px] text-ink-muted text-center" style={{ transform: isOpen(path) ? "rotate(90deg)" : "rotate(0deg)" }}>
            ▸
          </Text>
        </If>
        <View accessible={false} class="w-3 items-center justify-center">
          <FileIcon icon={fileIconFor(path, { isDir: isDir() })} size={12} />
        </View>
        <Text class={`shrink min-w-0 text-[12px] leading-[16px] line-clamp-1 ${lit() ? "text-brand" : "text-ink"}`}>{node()?.name ?? ""}</Text>
        <If when={node()?.fresh}>
          <View accessible={false} class="ml-auto w-[6px] h-[6px] rounded-full bg-brand" />
        </If>
      </View>
    );
  };

  /** One row of the Tree, made while it is in view. Untracked: what it shows follows through its bindings. */
  const rowFor = (id: string, depth: number): JSX.Element =>
    untracked(() => {
      if (id.startsWith(STATE)) return stateBlock(id, depth);
      if (id.startsWith(NOTE)) return <Text class="w-full pt-2 pr-5 pb-2 pl-12 text-[11px] text-ink-muted">{props.truncatedLabel ?? ""}</Text>;
      return rowBlock(id, depth);
    });

  return (
    <View testID="workspace-tree" class="min-w-0 flex-1 bg-sidebar-bg border-r border-line">
      <Tree
        ref={(ref: TreeRef) => {
          tree = ref;
        }}
        class="flex-1 min-h-0"
        listClass="py-2"
        itemClass="focus:bg-row-hover"
        accessibilityLabel={props.label}
        items={model().items}
        expanded={expandedIds()}
        selected={cursor()}
        onExpandedChange={(e) => onExpandedChange(e.expanded)}
        onSelectedChange={(e) => cursor.set(e.selected)}
        onAction={(e) => {
          const node = byPath().get(e.id);
          if (node) onRowPress(node, { shift: false, platform: false, control: false });
        }}
        renderItem={(entry) => rowFor(entry.id, entry.depth)}
      />
    </View>
  );
}
