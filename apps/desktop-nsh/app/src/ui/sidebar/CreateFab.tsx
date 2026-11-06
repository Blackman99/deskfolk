/**
 * Creating on a phone (`CreateFab.svelte`): one button that floats over the list rather than a + in
 * each group header. The headers' buttons are 22px targets at the top of a screen you hold from the
 * bottom, and there are two of them saying the same kind of thing; this asks which once, where your
 * thumb is, in a sheet from the bottom. (The Svelte `wrapEl` was the sidebar's outside-click check;
 * the sheet has its own backdrop here.)
 */
import { Overlay, safeArea, View } from "nsh";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";

export function CreateFab(props: {
  /** What the + opens. A menu, so Back and Escape close it first. */
  createMenuOpen: boolean;
  onCreateMenuOpenChange: (open: boolean) => void;
  /** A Bot and a group; left out (a phone's projects page), the menu has neither. */
  onCreateBot?: () => void;
  onCreateGroup?: () => void;
  /** A project session (ADR 0095): a new one in a folder, or a terminal session carried on; left out, the menu has neither. */
  onNewProject?: () => void;
  onImportProject?: () => void;
}) {
  const close = () => props.onCreateMenuOpenChange(false);
  const choose = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <>
      <If when={props.createMenuOpen}>
        <BottomSheet title={copy().sidebar.createMenu} closeLabel={copy().common.close} onClose={close}>
          <View role="menu" testID="fab-menu" accessibilityLabel={copy().sidebar.createMenu}>
            <If when={props.onCreateBot}>
              {(action) => <SheetItem role="menuitem" testID="fab-add-bot" icon="bot" label={copy().sidebar.addBot} onPress={choose(action())} />}
            </If>
            <If when={props.onCreateGroup}>
              {(action) => <SheetItem role="menuitem" testID="fab-add-group" icon="users" label={copy().sidebar.addGroup} onPress={choose(action())} />}
            </If>
            <If when={props.onNewProject}>
              {(action) => <SheetItem role="menuitem" testID="project-add-new" icon="folder" label={copy().project.newInFolder} onPress={choose(action())} />}
            </If>
            <If when={props.onImportProject}>
              {(action) => <SheetItem role="menuitem" testID="project-add-import" icon="file-down" label={copy().project.importSession} onPress={choose(action())} />}
            </If>
          </View>
        </BottomSheet>
      </If>
      <Overlay class="right-[16px] items-end" style={{ bottom: safeArea().bottom + 60 + 16 }}>
        <View
          role="button"
          testID="create-fab"
          tooltip={tip(copy().sidebar.createMenu)}
          accessibilityLabel={copy().sidebar.createMenu}
          accessibilityState={{ expanded: props.createMenuOpen }}
          onPress={() => props.onCreateMenuOpenChange(!props.createMenuOpen)}
          class={`w-[52px] h-[52px] rounded-full items-center justify-center bg-brand active:bg-accent-hover active:scale-[0.94] transition-transform duration-[160ms] ${props.createMenuOpen ? "rotate-45" : ""}`}
          style={{ boxShadow: shadow("lg") }}
        >
          <Icon name="plus" size={24} class="tint-on-accent" />
        </View>
      </Overlay>
    </>
  );
}
