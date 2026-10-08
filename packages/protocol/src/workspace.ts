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
