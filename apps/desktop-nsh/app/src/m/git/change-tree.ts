import type { GitChangeFile } from "@real-bot/protocol";

export type GitChangeTreeDirNode = {
  kind: "dir";
  /** Display label; compacted chains of single-child folders join with `/`. */
  name: string;
  /** Repo-relative path of the deepest directory in this node. */
  path: string;
  children: GitChangeTreeNode[];
  /** Total changed files inside this subtree. */
  fileCount: number;
};

export type GitChangeTreeFileNode = {
  kind: "file";
  /** File basename. */
  name: string;
  /** Original repo-relative file path from `GitChangeFile.path`. */
  path: string;
  file: GitChangeFile;
};

export type GitChangeTreeNode = GitChangeTreeDirNode | GitChangeTreeFileNode;

type MutableDir = {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: GitChangeTreeFileNode[];
};

function splitSegments(rawPath: string): string[] {
  const normalized = rawPath.replace(/\\/g, "/");
  const out: string[] = [];
  for (const seg of normalized.split("/")) {
    if (!seg || seg === ".") continue;
    out.push(seg);
  }
  return out;
}

function compareNodes(a: GitChangeTreeNode, b: GitChangeTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.path.localeCompare(b.path);
}

function freezeDir(dir: MutableDir): GitChangeTreeDirNode {
  const dirChildren = [...dir.dirs.values()].map(freezeDir);
  const children: GitChangeTreeNode[] = [...dirChildren, ...dir.files].sort(compareNodes);
  let fileCount = dir.files.length;
  for (const child of dirChildren) fileCount += child.fileCount;

  // Compact chains of folders that hold only a single child folder (like VS Code / GitHub diff trees).
  if (children.length === 1 && children[0]!.kind === "dir") {
    const only = children[0]!;
    return {
      kind: "dir",
      name: `${dir.name}/${only.name}`,
      path: only.path,
      children: only.children,
      fileCount: only.fileCount,
    };
  }

  return {
    kind: "dir",
    name: dir.name,
    path: dir.path,
    children,
    fileCount,
  };
}

/**
 * Builds a sorted, single-child-compacted directory tree from changed git files.
 * Every input file is preserved as a leaf node whose `path` matches `file.path` verbatim.
 */
export function buildGitChangeTree(files: readonly GitChangeFile[]): GitChangeTreeNode[] {
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: [] };

  for (const file of files) {
    const parts = splitSegments(file.path);
    if (parts.length === 0) {
      root.files.push({ kind: "file", name: file.path, path: file.path, file });
      continue;
    }
    let current = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let next = current.dirs.get(seg);
      if (!next) {
        next = { name: seg, path: prefix, dirs: new Map(), files: [] };
        current.dirs.set(seg, next);
      }
      current = next;
    }
    const leafName = parts[parts.length - 1]!;
    current.files.push({ kind: "file", name: leafName, path: file.path, file });
  }

  const topDirs = [...root.dirs.values()].map(freezeDir);
  return [...topDirs, ...root.files].sort(compareNodes);
}

/** Returns changed files in visual tree order (depth-first, matching rendered rows). */
export function flattenGitChangeTreeFiles(nodes: readonly GitChangeTreeNode[]): GitChangeFile[] {
  const out: GitChangeFile[] = [];
  const walk = (list: readonly GitChangeTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "file") out.push(node.file);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Collects every directory node's `path` in the tree. */
export function collectGitChangeTreeDirPaths(nodes: readonly GitChangeTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly GitChangeTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "dir") {
        out.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Returns ancestor directory paths (from outermost to innermost) containing `filePath`. */
export function ancestorGitChangeTreeDirPaths(
  nodes: readonly GitChangeTreeNode[],
  filePath: string | null,
): string[] {
  if (!filePath) return [];
  const chain: string[] = [];
  const walk = (list: readonly GitChangeTreeNode[]): boolean => {
    for (const node of list) {
      if (node.kind === "file") {
        if (node.path === filePath) return true;
        continue;
      }
      if (walk(node.children)) {
        chain.push(node.path);
        return true;
      }
    }
    return false;
  };
  walk(nodes);
  return chain.reverse();
}
