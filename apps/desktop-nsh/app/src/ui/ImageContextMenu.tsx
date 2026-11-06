/**
 * The menu of a right-click (a long press on a phone) on a picture the app drew itself
 * (`ImageContextMenu.svelte`): one entry, Copy image. On a desktop it is a small menu at the
 * pointer (`x`, `y` in the window); on a phone a sheet from the bottom. Mount it while it is open.
 */
import { Clipboard, Overlay, platform, signal, Text, View } from "nsh";
import { copy } from "../runtime";
import { BottomSheet, SheetItem } from "./BottomSheet";
import { shadow } from "./styles";

export function ImageContextMenu(props: { src: string; x: number; y: number; onClose: () => void }) {
  const failed = signal(false);
  const copying = signal(false);
  const label = () => (failed() ? copy().common.copyImageFailed : copy().common.copyImage);

  function run(): void {
    if (copying()) return;
    copying.set(true);
    failed.set(false);
    Clipboard.writeImage(props.src).then(
      () => props.onClose(),
      () => {
        copying.set(false);
        failed.set(true);
      },
    );
  }

  return (
    <If
      when={platform.desktop}
      else={
        <BottomSheet label={copy().common.copyImage} closeLabel={copy().common.close} onClose={props.onClose}>
          <View role="menu" accessibilityLabel={copy().common.copyImage} testID="image-context-menu">
            <SheetItem role="menuitem" label={label()} disabled={copying()} onPress={run} testID="image-context-copy" />
          </View>
        </BottomSheet>
      }
    >
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
          accessibilityLabel={copy().common.copyImage}
          testID="image-context-menu"
          class="min-w-[148px] p-[5px] bg-pane border border-line rounded-(--radius-md)"
          style={{ boxShadow: shadow("menu") }}
        >
          <View
            role="menuitem"
            testID="image-context-copy"
            disabled={copying()}
            onPress={run}
            class="w-full min-h-[32px] px-[10px] py-[6px] rounded-(--radius-sm) justify-center hover:bg-line-subtle focus-visible:bg-line-subtle group disabled:opacity-[0.7]"
          >
            <Text class="text-[13px] font-medium text-ink group-hover:text-brand">{label()}</Text>
          </View>
        </View>
      </Overlay>
    </If>
  );
}
