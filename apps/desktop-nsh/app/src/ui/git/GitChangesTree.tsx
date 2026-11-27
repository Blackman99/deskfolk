/**
 * Virtualised file tree for Git diff changes (`GitChangesView`), built on `nsh/base`'s `Tree`.
 * Directories start expanded and compact single-child folder chains; clicking a folder toggles
 * collapse, clicking a file opens its diff, and keyboard navigation (arrows, Return, typeahead)
 * works natively.
 */
import { computed, effect, signal, Text, untracked, View, type JSX } from "nsh";
import { Tree, type TreeItem, type TreeRef } from "nsh/base";
import {
  ancestorGitChangeTreeDirPaths,
  type GitChangeTreeDirNode,
  type GitChangeTreeFileNode,
  type GitChangeTreeNode,
} from "../../m/git/change-tree.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { copy } from "../../runtime";
import { FileIcon } from "../overlays/FileIcon";
import { tip } from "../tip";
import { statusBadgeClass } from "./git-ui-helpers";

/** Prefixes for `TreeItem` ids so folders and files can never collide without using NUL bytes. */
const DIR_PREFIX = "dir:";
const FILE_PREFIX = "file:";

const dirId = (path: string) => `${DIR_PREFIX}${path}`;
const fileId = (path: string) => `${FILE_PREFIX}${path}`;
const dirPathOf = (id: string) => (id.startsWith(DIR_PREFIX) ? id.slice(DIR_PREFIX.length) : null);
const filePathOf = (id: string) => (id.startsWith(FILE_PREFIX) ? id.slice(FILE_PREFIX.length) : id);
const sameStrings = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function GitChangesTree(props: {
  nodes: readonly GitChangeTreeNode[];
  selectedPath: string | null;
  narrow: boolean;
  /** Active filter query; non-empty auto-expands matching folders while preserving pre-filter collapses. */
  filterQuery?: string;
  /** Changing this key resets user-collapsed folders (e.g. when switching commits). */
  resetKey?: string | null;
  /** Extra bottom padding inside the scroll list (e.g. mobile safe-area inset). */
  bottomInset?: number;
  testID?: string;
  dirTestIdPrefix?: string;
  fileTestIdPrefix?: string;
  onSelectFile: (path: string) => void;
}) {
  const t = () => copy();
  const collapsed = signal(new Set<string>());
  const filterCollapsed = signal(new Set<string>());
  const cursor = signal<string | null>(props.selectedPath ? fileId(props.selectedPath) : null);
  let tree: TreeRef | null = null;

  const filtering = () => Boolean(props.filterQuery?.trim());

  let lastResetKey = props.resetKey ?? null;
  effect(() => {
    const key = props.resetKey ?? null;
    if (key === lastResetKey) return;
    lastResetKey = key;
    untracked(() => {
      collapsed.set(new Set());
      filterCollapsed.set(new Set());
    });
  });

  let lastFilter = props.filterQuery?.trim() ?? "";
  effect(() => {
    const q = props.filterQuery?.trim() ?? "";
    if (q === lastFilter) return;
    lastFilter = q;
    untracked(() => filterCollapsed.set(new Set()));
  });

  const activeCollapsed = () => (filtering() ? filterCollapsed() : collapsed());
  const setActiveCollapsed = (next: Set<string>) => {
    if (filtering()) filterCollapsed.set(next);
    else collapsed.set(next);
  };

  const model = computed(() => {
    const byId = new Map<string, GitChangeTreeNode>();
    const dirIds: string[] = [];
    const walk = (list: readonly GitChangeTreeNode[]): TreeItem[] =>
      list.map((node) => {
        if (node.kind === "file") {
          const id = fileId(node.path);
          byId.set(id, node);
          return { id, label: node.name };
        }
        const id = dirId(node.path);
        byId.set(id, node);
        dirIds.push(id);
        return { id, label: node.name, children: walk(node.children) };
      });
    return { items: walk(props.nodes), byId, dirIds };
  });

  const expandedIds = computed(
    () => {
      const shut = activeCollapsed();
      return model().dirIds.filter((id) => {
        const p = dirPathOf(id);
        return p !== null && !shut.has(p);
      });
    },
    { equals: sameStrings },
  );

  // Follow external selection changes (initial load, Prev/Next pager) by expanding ancestors and revealing.
  let lastSelected = props.selectedPath;
  effect(() => {
    const now = props.selectedPath;
    if (now === lastSelected) return;
    lastSelected = now;
    untracked(() => {
      const targetId = now ? fileId(now) : null;
      cursor.set(targetId);
      if (!now || !targetId) return;
      const ancestors = ancestorGitChangeTreeDirPaths(props.nodes, now);
      if (ancestors.length > 0) {
        const shut = activeCollapsed();
        if (ancestors.some((p) => shut.has(p))) {
          const next = new Set(shut);
          for (const p of ancestors) next.delete(p);
          setActiveCollapsed(next);
        }
      }
      if (model().byId.has(targetId)) queueMicrotask(() => tree?.revealItem(targetId));
    });
  });

  const toggleDir = (path: string) => {
    const next = new Set(activeCollapsed());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setActiveCollapsed(next);
  };

  const onExpandedChange = (ids: string[]) => {
    const open = new Set(ids);
    const shut = new Set<string>();
    for (const id of model().dirIds) {
      if (!open.has(id)) {
        const p = dirPathOf(id);
        if (p !== null) shut.add(p);
      }
    }
    const cur = activeCollapsed();
    if (shut.size !== cur.size || [...shut].some((p) => !cur.has(p))) {
      setActiveCollapsed(shut);
    }
  };

  const renderDirRow = (id: string, depth: number): JSX.Element => {
    const node = (): GitChangeTreeDirNode | undefined => {
      const found = model().byId.get(id);
      return found?.kind === "dir" ? found : undefined;
    };
    const path = () => node()?.path ?? dirPathOf(id) ?? "";
    const open = () => !activeCollapsed().has(path());
    return (
      <View
        role="button"
        testID={`${props.dirTestIdPrefix ?? "git-dir-"}${path()}`}
        accessibilityLabel={node()?.name ?? path()}
        accessibilityState={{ expanded: open() }}
        tooltip={tip(path())}
        onPress={() => {
          cursor.set(id);
          toggleDir(path());
        }}
        class={`cursor-pointer select-none flex-row items-center w-full rounded-(--radius-sm) hover:bg-row-hover active:bg-row-hover ${
          props.narrow ? "min-h-[40px] py-[6px] pr-[10px] gap-[6px]" : "py-[4px] pr-[8px] gap-[4px]"
        }`}
        style={{ paddingLeft: (props.narrow ? 8 : 6) + depth * 12 }}
      >
        <Text
          accessible={false}
          class="w-3 text-[10px] text-ink-muted text-center shrink-0"
          style={{ transform: open() ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▸
        </Text>
        <View accessible={false} class={`${props.narrow ? "w-4" : "w-3"} items-center justify-center shrink-0`}>
          <FileIcon icon={fileIconFor(path(), { isDir: true })} size={props.narrow ? 16 : 12} />
        </View>
        <Text
          class={`${props.narrow ? "text-[13px]" : "text-[12px] leading-[16px]"} flex-1 min-w-0 font-medium text-ink-secondary line-clamp-1`}
        >
          {node()?.name ?? ""}
        </Text>
        <If when={!open() && (node()?.fileCount ?? 0) > 0}>
          <Text class="font-mono text-[10px] text-ink-muted shrink-0">{String(node()?.fileCount ?? 0)}</Text>
        </If>
      </View>
    );
  };

  const renderFileRow = (id: string, depth: number): JSX.Element => {
    const node = (): GitChangeTreeFileNode | undefined => {
      const found = model().byId.get(id);
      return found?.kind === "file" ? found : undefined;
    };
    const file = () => node()?.file;
    const path = () => file()?.path ?? filePathOf(id);
    const active = () => !props.narrow && props.selectedPath === path();
    const badge = () => statusBadgeClass(file()?.status ?? "M");
    const tooltipText = () => {
      const f = file();
      if (!f) return path();
      return f.old_path ? `${f.old_path} → ${f.path}` : f.path;
    };
    return (
      <View
        role="button"
        testID={`${props.fileTestIdPrefix ?? "git-file-"}${path()}`}
        accessibilityLabel={node()?.name ?? path()}
        accessibilityState={{ selected: active() }}
        tooltip={tip(tooltipText())}
        onPress={() => {
          cursor.set(id);
          props.onSelectFile(path());
        }}
        class={`cursor-pointer select-none flex-row items-center w-full rounded-(--radius-sm) ${
          props.narrow ? "min-h-[44px] py-[8px] pr-[10px] gap-[8px] active:bg-row-hover" : "py-[4px] pr-[8px] gap-[5px]"
        } ${active() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
        style={{ paddingLeft: (props.narrow ? 10 : 8) + depth * 12 }}
      >
        <View accessible={false} class={`${props.narrow ? "w-4" : "w-3"} items-center justify-center shrink-0`}>
          <FileIcon icon={fileIconFor(path())} size={props.narrow ? 16 : 12} />
        </View>
        <Text
          class={`${props.narrow ? "text-[13.5px]" : "text-[12px] leading-[16px]"} flex-1 min-w-0 line-clamp-1 ${
            active() ? "font-semibold text-brand" : "text-ink"
          }`}
        >
          {node()?.name ?? ""}
        </Text>
        <If when={file()}>
          {(f) => (
            <View class="flex-row items-center gap-[4px] shrink-0">
              <If when={f().additions !== null && f().additions! > 0}>
                <Text class="font-mono text-[10.5px] text-ok-text">{`+${f().additions}`}</Text>
              </If>
              <If when={f().deletions !== null && f().deletions! > 0}>
                <Text class="font-mono text-[10.5px] text-danger-text">{`-${f().deletions}`}</Text>
              </If>
              <View
                class={`${props.narrow ? "w-[20px] h-[20px]" : "w-[18px] h-[18px]"} rounded-(--radius-xs) items-center justify-center ${badge().bg}`}
              >
                <Text class={`font-mono text-[10px] font-bold ${badge().text}`}>{f().status}</Text>
              </View>
            </View>
          )}
        </If>
      </View>
    );
  };

  return (
    <View testID={props.testID ?? "git-changes-list"} class="flex-1 min-h-0 min-w-0">
      <Tree
        ref={(ref: TreeRef) => {
          tree = ref;
        }}
        class="flex-1 min-h-0"
        listStyle={{
          paddingTop: 4,
          paddingBottom: 8 + (props.bottomInset ?? 0),
          paddingLeft: 4,
          paddingRight: 4,
        }}
        itemClass="focus:bg-row-hover"
        accessibilityLabel={t().git.changes.fileTreeLabel}
        items={model().items}
        expanded={expandedIds()}
        selected={cursor()}
        onExpandedChange={(e) => onExpandedChange(e.expanded)}
        onSelectedChange={(e) => cursor.set(e.selected)}
        onAction={(e) => {
          const found = model().byId.get(e.id);
          if (found?.kind === "file") props.onSelectFile(found.path);
        }}
        renderItem={(entry) =>
          untracked(() => (entry.id.startsWith(DIR_PREFIX) ? renderDirRow(entry.id, entry.depth) : renderFileRow(entry.id, entry.depth)))
        }
      />
    </View>
  );
}
