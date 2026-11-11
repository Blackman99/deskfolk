/**
 * The narrow host for the workspace (`WorkspaceExplorer.svelte`): a page that slides in from the
 * right, dims what is behind it and closes on a press outside. On a wide desktop window the same
 * `WorkspaceView` is a pane instead, with none of this around it.
 *
 * It is an `Overlay` over the window (a fixed box); the part left of the pane is the backdrop, so
 * a press there closes it and one inside the pane never does. On a phone the pane is the whole
 * width, nothing dims, and the page stops above the 60-point navigation bar. Not carried over:
 * the backdrop blur and the slide animation (`pageSlide`).
 */
import { Overlay, safeArea, View, windowSize, type JSX } from "nsh";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { WorkspaceView, type WorkspaceHandle, type WorkspacePreviewProps } from "./WorkspaceView";

export function WorkspaceExplorer(props: {
  api: MessengerApi | null;
  workspacePath: string | null;
  selected: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  onOpenSettings?: () => void;
  onOpenTerminal?: (dir: string) => void;
  /** Mounts `ArtifactPreview` in workspace mode (see `WorkspaceView`). */
  children: (preview: WorkspacePreviewProps) => JSX.Element;
  onHandle?: (handle: WorkspaceHandle) => void;
}) {
  let view: WorkspaceHandle | null = null;

  const requestClose = () => {
    if (view) view.requestCloseFromParent();
    else props.onClose();
  };

  props.onHandle?.({
    requestCloseFromParent: (afterClose) => {
      if (view) view.requestCloseFromParent(afterClose);
      else {
        props.onClose();
        afterClose?.();
      }
    },
    requestLeaveFromParent: (after) => {
      if (view) view.requestLeaveFromParent(after);
      else after();
    },
    closeFind: () => view?.closeFind() ?? false,
    blocksClose: () => view?.blocksClose() ?? false,
  });

  const narrow = () => narrowWindow();

  return (
    <Overlay
      style={{ left: 0, top: 0, right: 0, bottom: narrow() ? 60 + safeArea().bottom : 0 }}
    >
      <View
        role="group"
        testID="workspace-overlay"
        accessibilityLabel={copy().stream.workspaceExplorer}
        class="flex-1 flex-row justify-end"
      >
        <View
          testID="workspace-backdrop"
          accessible={false}
          onPress={requestClose}
          class={`flex-1 ${narrow() ? "" : "bg-modal-backdrop"}`}
        />
        <View
          testID="workspace-pane"
          class={`min-w-0 overflow-hidden bg-pane ${narrow() ? "" : "border-l border-line"}`}
          style={{
            width: narrow() ? windowSize().width : Math.min(1400, windowSize().width - 72),
            boxShadow: narrow() ? undefined : shadow("sheet-end"),
          }}
        >
          <WorkspaceView
            api={props.api}
            workspacePath={props.workspacePath}
            selected={props.selected}
            onClose={props.onClose}
            onSelect={props.onSelect}
            onOpenSettings={props.onOpenSettings}
            onOpenTerminal={props.onOpenTerminal}
            onHandle={(handle) => {
              view = handle;
            }}
          >
            {props.children}
          </WorkspaceView>
        </View>
      </View>
    </Overlay>
  );
}
