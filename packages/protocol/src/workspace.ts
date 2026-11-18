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

export type WorkspaceTrashResult = {
  /** In the Trash now, or already gone when asked — either way no longer in the workspace. */
  trashed: string[];
  /** Still where they were, with the Mac's reason. */
  failed: Array<{ path: string; message: string }>;
};
