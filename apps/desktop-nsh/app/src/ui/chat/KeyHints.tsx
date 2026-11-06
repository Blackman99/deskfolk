/** The line of key caps under the composer's pop-up lists (`↑↓ Move  Enter Pick  Esc Close`); a touch screen has no keys to point at. */
import { platform, Text, View } from "nsh";

export function KeyHints(props: { hints: readonly (readonly [key: string, label: string])[] }) {
  return (
    <If when={platform.desktop}>
      <View accessible={false} testID="key-hints" class="flex-row items-center gap-[6px] mt-1 px-[10px] pt-[6px] pb-1 border-t border-line-subtle">
        <Each of={props.hints} key={(hint) => hint[0]}>
          {(hint, i) => (
            <>
              <View class={`px-[5px] rounded-(--radius-xs) bg-pane border border-line ${i() > 0 ? "ml-[6px]" : ""}`}>
                <Text class="font-mono text-[11px] leading-[17px] text-ink-muted">{hint()[0]}</Text>
              </View>
              <Text class="text-[11px] text-ink-muted">{hint()[1]}</Text>
            </>
          )}
        </Each>
      </View>
    </If>
  );
}
