export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
};

export type WorkspaceTreePage = {
  path: string;
  truncated: boolean;
  items: WorkspaceTreeEntry[];
};

/**
 * `GET /v1/workspace/stat` and `GET /v1/attachments/:id/stat`: what a file is now, without its
 * bytes. An open preview asks for it every second or so and reloads when `etag` is no longer the
 * one its bytes came with.
 */
export type WorkspaceFileStat = {
  /** The file's hash, as the file GET names it in its `ETag` (the quoted SHA-256 of the whole file). */
  etag: string;
  size: number;
  modified_at: string;
};

/** Workspace-relative files and folders to move to the Mac's Trash; a folder goes with what is in it. */
export type WorkspaceTrashRequest = {
  paths: string[];
};

/**
 * Files and folders elsewhere on this computer (absolute paths, as Finder drops them) to copy into
 * `dir`: a workspace folder (`""` is the workspace itself), or a folder in a project session's
 * directory written absolute. Only this computer's own window asks; a paired device cannot.
 */
export type WorkspaceImportRequest = {
  dir: string;
  sources: string[];
};

export type WorkspaceImportResult = {
  /** Copied, each under the name it has in `dir` now (`report-1.pdf` when `report.pdf` was taken). */
  imported: Array<{ source: string; name: string }>;
  /**
   * Not copied: `missing` (gone, or not readable), `into_itself` (a folder dropped into itself or
   * one inside it), `copy_failed` (the copy stopped partway and was taken away; `message` says why).
   */
  failed: Array<{ source: string; code: "missing" | "into_itself" | "copy_failed"; message: string }>;
};

/**
 * Rows dragged inside a file tree: `sources` moved into the folder `dir`, each written as the tree
 * writes it (a workspace path, or one in a project session's directory written absolute).
 */
export type WorkspaceMoveRequest = {
  dir: string;
  sources: string[];
};

export type WorkspaceMoveResult = {
  /** In `dir` now under their own name (one already there is answered as moved, unchanged). */
  moved: Array<{ source: string; name: string }>;
  /**
   * Not moved: `missing` (gone), `outside` (not in the workspace or a project), `into_itself` (a
   * folder into itself or one inside it), `exists` (that name is taken in `dir`; nothing is
   * overwritten), `move_failed` (the system refused; `message` says why).
   */
  failed: Array<{ source: string; code: "missing" | "outside" | "into_itself" | "exists" | "move_failed"; message: string }>;
};

export type WorkspaceTrashResult = {
  /** In the Trash now, or already gone when asked — either way no longer in the workspace. */
  trashed: string[];
  /** Still where they were, with the Mac's reason. */
  failed: Array<{ path: string; message: string }>;
};
