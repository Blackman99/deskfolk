/**
 * The pane's right-click menu, for what lies in a pane's body (`WorkbenchLeaf` provides it).
 *
 * NSH has no bubbling: a secondary press goes to the nearest view around the one under the pointer
 * that listens to `onContextMenu`, unless a selectable view or selectable text is nearer, which then
 * shows NSH's own Copy menu instead. A body that wraps its content in a `<View selectable>` (one
 * selection across its lines) would so keep every right click from the pane's menu, so that view
 * opens the pane's menu itself with this, and what is inside it carries no `selectable` of its own.
 * Outside a pane there is none: a right click there keeps NSH's Copy menu.
 */
import { context } from "nsh";

/** Opens the pane's menu at a point in the window, as a right click on the pane does. */
export type OpenPaneMenu = (at: { x: number; y: number }) => void;

export const PaneMenu = context<OpenPaneMenu | null>(null);
