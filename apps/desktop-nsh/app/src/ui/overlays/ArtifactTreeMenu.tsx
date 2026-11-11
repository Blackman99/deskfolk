/**
 * The menu of a right click (a long press on a phone) on a tree row (`ArtifactTreeMenu.svelte`):
 * open with the system's app, show in Finder, a terminal here, copy the path, copy the path on
 * the machine, move to the Trash. Above one row (`count`) only what applies to all of them is
 * offered: the copies and the Trash.
 *
 * On a desktop a small menu at the pointer (`x`, `y` in the window), kept in the window by
 * `Overlay`, closed by a press outside or Escape, with Up / Down moving between entries; on a
 * phone a `BottomSheet`. Mount it while it is open. Every entry runs, then closes the menu.
 * Entries' test ids: `artifact-tree-menu-{open,reveal,open-terminal,copy-path,copy-abs-path,trash}`.
 */
import { keymap, Overlay, Text, View, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem, SheetSeparator } from "../BottomSheet";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";

type Entry = { id: string; label: string; danger?: boolean; run: () => void };

export function ArtifactTreeMenu(props: {
  /** Window coordinates of the right-click. */
  x: number;
  y: number;
  onOpen: () => void;
  onReveal: () => void;
  /** Starts a terminal in the row's folder, or the folder a file sits in; absent where no terminal can open. */
  onOpenTerminal?: () => void;
  /** Copies the row's workspace-relative path. */
  onCopyPath?: () => void;
  /** Copies the row's path on the machine; absent while the workspace root is unknown. */
  onCopyAbsPath?: () => void;
  /** How many rows the menu acts on. */
  count?: number;
  /** Asks to move the rows to the Trash; absent where nothing can reach the Mac. */
  onTrash?: () => void;
  /** The row's name, for a phone's sheet; none when the menu acts on several. */
  title?: string | null;
  onClose: () => void;
}) {
  const t = () => copy().stream;
  const single = () => (props.count ?? 1) <= 1;
  const pick = (run: () => void) => () => {
    run();
    props.onClose();
  };

  /** Entries in groups, each group set off from the one before it by a separator. */
  const groups = (): Entry[][] => {
    const out: Entry[][] = [];
    if (single()) {
      const first: Entry[] = [
        { id: "open", label: t().artifactOpenSystem, run: props.onOpen },
        { id: "reveal", label: t().artifactReveal, run: props.onReveal },
      ];
      if (props.onOpenTerminal) first.push({ id: "open-terminal", label: t().artifactOpenTerminal, run: props.onOpenTerminal });
      out.push(first);
    }
    const copies: Entry[] = [];
    if (props.onCopyPath) copies.push({ id: "copy-path", label: t().artifactCopyPath, run: props.onCopyPath });
    if (props.onCopyAbsPath) copies.push({ id: "copy-abs-path", label: t().artifactCopyAbsPath, run: props.onCopyAbsPath });
    if (copies.length) out.push(copies);
    const { onTrash } = props;
    if (onTrash) {
      out.push([{ id: "trash", label: single() ? t().artifactTrash : t().artifactTrashCount(props.count ?? 1), danger: true, run: onTrash }]);
    }
    return out;
  };

  const refs: ViewRef[] = [];
  let focused = -1;
  const rove = (step: number) => {
    const live = refs.filter(Boolean);
    if (!live.length) return;
    focused = (focused + step + live.length) % live.length;
    live[focused]!.focus();
  };

  keymap.bind("down", () => rove(1), { when: "always" });
  keymap.bind("up", () => rove(-1), { when: "always" });

  return (
    <If
      when={narrowWindow()}
      else={
          <Overlay
            anchor={{ x: props.x, y: props.y }}
            placement="bottom"
            align="start"
            margin={8}
            onPressOutside={() => props.onClose()}
            onCancel={() => props.onClose()}
          >
            <View
              role="menu"
              testID="artifact-tree-menu"
              accessibilityLabel={t().artifactTree}
              class="min-w-[196px] p-[5px] gap-[2px] bg-pane border border-line rounded-(--radius-md)"
              style={{ boxShadow: shadow("menu") }}
            >
              {() =>
                groups().map((group, index) => (
                  <View class="gap-[2px]">
                    {index > 0 ? <View role="none" class="h-[1px] mx-2 my-[3px] bg-line-subtle" /> : null}
                    {group.map((entry) => (
                      <View
                        role="menuitem"
                        testID={`artifact-tree-menu-${entry.id}`}
                        accessibilityLabel={entry.label}
                        ref={(node: ViewRef) => void refs.push(node)}
                        onPress={pick(entry.run)}
                        class={`cursor-pointer select-none flex-row items-center w-full px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle focus:bg-line-subtle ${entry.danger ? "hover:bg-danger-bg group" : "group"}`}
                      >
                        <Text class={`text-[13px] font-medium ${entry.danger ? "text-ink group-hover:text-danger-text" : "text-ink group-hover:text-brand"}`}>
                          {entry.label}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))
              }
            </View>
          </Overlay>
      }
    >
      <BottomSheet title={props.title ?? null} label={props.title ?? t().artifactTree} closeLabel={copy().common.close} onClose={props.onClose}>
        <View role="menu" testID="artifact-tree-menu" accessibilityLabel={props.title ?? t().artifactTree}>
          {() =>
            groups().map((group, index) => (
              <View>
                {index > 0 ? <SheetSeparator /> : null}
                {group.map((entry) => (
                  <SheetItem
                    role="menuitem"
                    testID={`artifact-tree-menu-${entry.id}`}
                    label={entry.label}
                    danger={entry.danger}
                    onPress={pick(entry.run)}
                  />
                ))}
              </View>
            ))
          }
        </View>
      </BottomSheet>
    </If>
  );
}
