/**
 * Which of a Mac's screens the page shows (`m/overlays/screen-displays.ts`): the header's title,
 * which on a Mac that listed more than one screen names the screen on show and opens the sheet that
 * lists them. The header has no room for another button on a phone.
 */
import { Text, View } from "nsh";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Icon } from "../Icon";
import { copy } from "../../runtime";
import { choiceOf, displayEntries, type DisplayEntry } from "../../m/overlays/screen-displays.ts";
import type { ScreenController } from "./remote-screen-controller.ts";

function name(screen: ScreenController, entry: DisplayEntry | undefined): string {
  const words = screen.words;
  if (!entry) return words.displayAll;
  return entry.number === null ? words.displayMain : words.displayNumbered(entry.number);
}

const TITLE = "shrink text-[15px] font-semibold text-ink";

/** The page's title, or with several screens the screen on show and a way to change it. */
export function ScreenTitle(props: { screen: ScreenController }) {
  const screen = props.screen;
  const shown = () => {
    const current = screen.currentDisplay();
    return current === null ? undefined : displayEntries(screen.displays()).find((e) => e.display.id === current);
  };
  return (
    <If when={screen.displays().length > 1} else={<Text class={TITLE} style={{ numberOfLines: 1 }}>{screen.words.title}</Text>}>
      <View
        role="button"
        testID="screen-display"
        accessibilityLabel={`${screen.words.displayTitle}: ${name(screen, shown())}`}
        accessibilityState={{ expanded: screen.displayMenu() }}
        tooltip={screen.words.displayTip}
        onPress={() => screen.displayMenu.set(true)}
        class="cursor-pointer select-none shrink min-w-0 flex-row items-center gap-1 px-1 py-[2px] rounded-(--radius-sm) hover:bg-row-hover active:bg-row-hover"
      >
        <Text class={TITLE} style={{ numberOfLines: 1 }}>{name(screen, shown())}</Text>
        <Icon name="chevron-down" size={12} class="shrink-0 tint-ink-muted" />
      </View>
    </If>
  );
}

export function DisplayMenu(props: { screen: ScreenController }) {
  const screen = props.screen;
  const words = () => screen.words;
  const close = () => screen.displayMenu.set(false);
  return (
    <If when={screen.displayMenu() && screen.displays().length > 1}>
      <BottomSheet title={words().displayTitle} closeLabel={copy().common.close} onClose={close}>
        <View role="menu" testID="screen-display-menu" accessibilityLabel={words().displayTitle}>
          <Each of={displayEntries(screen.displays())} key={(e: DisplayEntry) => String(e.display.id)}>
            {(entry: () => DisplayEntry) => {
              const where = () => words().displayWhere(entry().side.h, entry().side.v);
              const size = () => `${entry().display.width} × ${entry().display.height}`;
              return (
                <SheetItem
                  role="menuitem"
                  testID={`screen-display-${entry().display.id}`}
                  label={name(screen, entry())}
                  detail={where() ? `${where()} · ${size()}` : size()}
                  active={screen.currentDisplay() === entry().display.id}
                  onPress={() => screen.chooseDisplay(choiceOf(entry().display))}
                />
              );
            }}
          </Each>
          <SheetItem
            role="menuitem"
            testID="screen-display-all"
            label={words().displayAll}
            detail={words().displayAllDetail}
            active={screen.currentDisplay() === null}
            onPress={() => screen.chooseDisplay("all")}
          />
        </View>
      </BottomSheet>
    </If>
  );
}
