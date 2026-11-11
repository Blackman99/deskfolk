/**
 * The workspace itself, with no chrome around it (`WorkspaceView.svelte`): it fills whatever it is
 * put in. Two hosts use it — a pane on the desktop, a slide-over page on a narrow window
 * (`WorkspaceExplorer`) — and neither may add a prop that changes what this draws, or the two will
 * quietly stop agreeing.
 *
 * The file tree and the file beside it are `ArtifactPreview`'s (`mode="workspace"`, a later job):
 * `children` is a render function given the props the Svelte passes it, and `ref` takes the pane's
 * handle. With no workspace chosen, this draws the prompt to open the settings instead.
 */
import { Text, View, type JSX } from "nsh";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { copy } from "../../runtime";
import type { ArtifactPane } from "./ShellPreview";

/** The props the Svelte gives `ArtifactPreview` for the workspace (`mode="workspace"`). */
export type WorkspacePreviewProps = {
  api: MessengerApi | null;
  workspacePath: string;
  /** The file shown beside the tree. */
  relpath: string;
  onClose: () => void;
  /** A file picked in the tree. */
  onSelectWorkspacePath: (path: string) => void;
  /** Starts a terminal in a folder picked from the tree. */
  onOpenTerminal?: (dir: string) => void;
  ref: (pane: ArtifactPane | null) => void;
};

/** What the Svelte exports for its host: asking before closing, leaving, the find bar. */
export type WorkspaceHandle = {
  requestCloseFromParent: (afterClose?: () => void) => void;
  requestLeaveFromParent: (after: () => void) => void;
  closeFind: () => boolean;
  blocksClose: () => boolean;
};

export function WorkspaceView(props: {
  api: MessengerApi | null;
  workspacePath: string | null;
  selected: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  onOpenSettings?: () => void;
  onOpenTerminal?: (dir: string) => void;
  /** Mounts `ArtifactPreview` in workspace mode. */
  children: (preview: WorkspacePreviewProps) => JSX.Element;
  onHandle?: (handle: WorkspaceHandle) => void;
}) {
  let pane: ArtifactPane | null = null;

  props.onHandle?.({
    requestCloseFromParent: (afterClose) => {
      if (!afterClose && pane?.closeFind()) return;
      if (pane) pane.requestCloseFromParent(afterClose);
      else {
        props.onClose();
        afterClose?.();
      }
    },
    requestLeaveFromParent: (after) => {
      if (pane?.requestLeaveFromParent) pane.requestLeaveFromParent(after);
      else after();
    },
    closeFind: () => pane?.closeFind() ?? false,
    blocksClose: () => pane?.blocksClose() ?? false,
  });

  const button = (testID: string, label: string, onPress?: () => void) => (
    <View
      role="button"
      testID={testID}
      onPress={() => onPress?.()}
      class="cursor-pointer select-none min-h-[44px] m-2 px-4 py-2 items-center justify-center border border-line rounded-(--radius-md) bg-pane"
    >
      <Text class="text-[14px] text-brand">{label}</Text>
    </View>
  );

  return (
    <If
      when={props.workspacePath}
      else={
        <View testID="workspace-unset" class="m-auto p-6 items-center">
          <Text role="header" class="text-[18px] font-semibold text-ink">{copy().sidebar.workspace}</Text>
          <Text class="mt-2 text-[14px] text-ink-muted text-center">{copy().sidebar.workspaceUnset}</Text>
          {button("workspace-open-settings", copy().settings.title, props.onOpenSettings)}
          {button("workspace-close", copy().common.close, props.onClose)}
        </View>
      }
    >
      {(workspacePath: () => string) =>
        props.children({
          get api() {
            return props.api;
          },
          get workspacePath() {
            return workspacePath();
          },
          get relpath() {
            return props.selected;
          },
          onClose: props.onClose,
          onSelectWorkspacePath: props.onSelect,
          onOpenTerminal: props.onOpenTerminal,
          ref: (next) => {
            pane = next;
          },
        })
      }
    </If>
  );
}
