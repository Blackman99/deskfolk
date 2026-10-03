export type ArtifactTreeNode = {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: ArtifactTreeNode[];
  truncated?: boolean;
  /** Cited by the message this entry was opened from, as opposed to earlier in the same job. */
  fresh?: boolean;
};

export function workspaceEntriesToNodes(
  entries: ReadonlyArray<{ name: string; path: string; kind: "file" | "dir" }>,
): ArtifactTreeNode[] {
  return entries.map((row) =>
    row.kind === "dir"
      ? { name: row.name, path: row.path, kind: "dir", children: [] }
      : { name: row.name, path: row.path, kind: "file" },
  );
}

export function mergeWorkspaceChildren(
  nodes: ArtifactTreeNode[],
  dirPath: string,
  children: ArtifactTreeNode[],
  truncated: boolean,
): ArtifactTreeNode[] {
  return nodes.map((node) => {
    if (node.path === dirPath && node.kind === "dir") {
      return { ...node, children, truncated };
    }
    if (node.children) {
      return {
        ...node,
        children: mergeWorkspaceChildren(node.children, dirPath, children, truncated),
      };
    }
    return node;
  });
}

function splitRel(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("://")) return [];
  const parts: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return [];
    parts.push(seg);
  }
  return parts;
}

type MutableNode = {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: Map<string, MutableNode>;
};

function sortNodes(nodes: ArtifactTreeNode[]): ArtifactTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function freeze(node: MutableNode): ArtifactTreeNode {
  if (node.kind === "file" || !node.children) {
    return { name: node.name, path: node.path, kind: "file" };
  }
  const children = sortNodes([...node.children.values()].map(freeze));
  return { name: node.name, path: node.path, kind: "dir", children };
}

/** Nest cited workspace-relative paths. Duplicate paths collapse; files win over empty dirs of the same name. */
export function buildCitedPathTree(paths: readonly string[]): ArtifactTreeNode[] {
  const root = new Map<string, MutableNode>();

  for (const raw of paths) {
    const parts = splitRel(raw);
    if (parts.length === 0) continue;
    let level = root;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      prefix = prefix ? `${prefix}/${name}` : name;
      const isLast = i === parts.length - 1;
      const existing = level.get(name);
      if (isLast) {
        if (existing?.kind === "dir") break;
        if (!existing) level.set(name, { name, path: prefix, kind: "file" });
        break;
      }
      if (!existing) {
        const dir: MutableNode = { name, path: prefix, kind: "dir", children: new Map() };
        level.set(name, dir);
        level = dir.children!;
        continue;
      }
      if (existing.kind === "file") {
        existing.kind = "dir";
        existing.children = new Map();
      }
      existing.children ??= new Map();
      level = existing.children;
    }
  }

  return sortNodes([...root.values()].map(freeze));
}

/** The rows on screen, top to bottom: a folder's children count only while it is open. */
export function visibleTreePaths(
  nodes: readonly ArtifactTreeNode[],
  isOpen: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const walk = (list: readonly ArtifactTreeNode[]) => {
    for (const node of list) {
      out.push(node.path);
      if (node.kind === "dir" && node.children && isOpen(node.path)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** A Shift-click: the rows from the anchor to the target, both ends in; the target alone without one on screen. */
export function treeRange(order: readonly string[], anchor: string | null, target: string): string[] {
  const to = order.indexOf(target);
  if (to < 0) return [];
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (from < 0) return [target];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Whether `path` is one of `roots` or sits inside one of them. */
export function isUnderAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** The tree without these paths and whatever sits inside them. */
export function removeTreePaths(
  nodes: readonly ArtifactTreeNode[],
  removed: readonly string[],
): ArtifactTreeNode[] {
  if (removed.length === 0) return [...nodes];
  const out: ArtifactTreeNode[] = [];
  for (const node of nodes) {
    if (isUnderAny(node.path, removed)) continue;
    out.push(node.children ? { ...node, children: removeTreePaths(node.children, removed) } : node);
  }
  return out;
}

export function collectTreePaths(nodes: readonly ArtifactTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly ArtifactTreeNode[]) => {
    for (const node of list) {
      out.push(node.path);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Ancestor directory paths that should start expanded for `selected`. */
export function expandedDirsForSelection(
  nodes: readonly ArtifactTreeNode[],
  selected: string | null,
): Set<string> {
  const open = new Set<string>();
  if (!selected) return open;
  const walk = (list: readonly ArtifactTreeNode[]): boolean => {
    for (const node of list) {
      if (node.path === selected) return true;
      if (node.children && walk(node.children)) {
        open.add(node.path);
        return true;
      }
    }
    return false;
  };
  walk(nodes);
  return open;
}

export function countCitedFiles(nodes: readonly ArtifactTreeNode[]): number {
  let n = 0;
  const walk = (list: readonly ArtifactTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "file") n += 1;
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return n;
}

/**
 * The name a bundle shows: its folder (`citedBundleRoot`), and past it the one folder all of it is in.
 * Files in a ticket's folder are cited as `work/<job>/<NN-ticket>/…`, so the root alone read 「work」
 * on a hand-over's card (2026-10-04) — the one name every job's files share.
 */
export function citedBundleName(nodes: readonly ArtifactTreeNode[]): string | null {
  const root = citedBundleRoot(nodes);
  if (!root) return null;
  let node = findNode(nodes, root);
  while (node?.kind === "dir" && node.children?.length === 1 && node.children[0]!.kind === "dir") node = node.children[0]!;
  return node?.name ?? root.split("/").pop() ?? root;
}

function findNode(nodes: readonly ArtifactTreeNode[], path: string): ArtifactTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "dir" && path.startsWith(`${node.path}/`)) return findNode(node.children ?? [], path);
  }
  return null;
}

/** Project folder for the bubble entry: the only root dir, or the dir that holds most cited files. */
export function citedBundleRoot(nodes: readonly ArtifactTreeNode[]): string | null {
  if (nodes.length === 1 && nodes[0]?.kind === "dir") return nodes[0].path;
  const total = countCitedFiles(nodes);
  let best: ArtifactTreeNode | null = null;
  let bestCount = 0;
  for (const node of nodes) {
    if (node.kind !== "dir") continue;
    const n = countCitedFiles(node.children ?? []);
    if (n > bestCount) {
      best = node;
      bestCount = n;
    }
  }
  if (best && bestCount >= Math.ceil(total / 2)) return best.path;
  return null;
}

/**
 * The tree a work dir's entry opens: that folder is the single expanded root, and anything the job
 * cited outside it sits flat beside it.
 *
 * Not the deepest common ancestor — one `report.md` at the workspace root drags that all the way up
 * and the reader is back to expanding `work / <dated folder> /` before seeing a file. The work dir
 * is known, so it is used.
 */
export function buildTaskArtifactTree(
  dir: string,
  paths: readonly string[],
  fresh: readonly string[] = [],
): ArtifactTreeNode[] {
  const isFresh = new Set(fresh);
  const prefix = `${dir}/`;
  // What this message handed over belongs in the list even when the job's record does not have it:
  // the record is what the Mac noticed, and a message can name files it never saw. A tree without
  // the file you are looking at reads as the list being wrong, which is what it was.
  const known = new Set(paths);
  const all = [...paths, ...fresh.filter((path) => !known.has(path))];
  const inside = all.filter((path) => path.startsWith(prefix));
  const outside = all.filter((path) => !path.startsWith(prefix));

  const roots: ArtifactTreeNode[] = [];
  if (inside.length > 0) {
    const nested = buildCitedPathTree(inside.map((path) => path.slice(prefix.length)));
    roots.push({
      name: dir.split("/").pop() ?? dir,
      path: dir,
      kind: "dir",
      children: reroot(nested, prefix, isFresh),
    });
  }
  for (const node of buildCitedPathTree(outside)) roots.push(markFresh(node, isFresh));
  return roots;
}

/** Paths inside the work dir were nested without their prefix; put it back so clicks still resolve. */
function reroot(
  nodes: readonly ArtifactTreeNode[],
  prefix: string,
  isFresh: ReadonlySet<string>,
): ArtifactTreeNode[] {
  return nodes.map((node) => {
    const path = `${prefix}${node.path}`;
    return node.kind === "dir"
      ? { ...node, path, children: reroot(node.children ?? [], prefix, isFresh) }
      : { ...node, path, ...(isFresh.has(path) ? { fresh: true } : {}) };
  });
}

function markFresh(node: ArtifactTreeNode, isFresh: ReadonlySet<string>): ArtifactTreeNode {
  return node.kind === "dir"
    ? { ...node, children: (node.children ?? []).map((child) => markFresh(child, isFresh)) }
    : { ...node, ...(isFresh.has(node.path) ? { fresh: true } : {}) };
}
