/**
 * The row of drafted next lines above the box (`ComposerSuggestions.svelte`): one chip each, picking
 * one drafts it into the box; with none, the note that nothing came out. The chips stay one row and
 * scroll sideways (a wheel over the row scrolls it that way). The Svelte one fades the edge that
 * has more behind it with a CSS mask; NSH has no mask, so a short gradient of the pane colour is
 * not drawn and the row simply ends at the edge.
 */
import { Scroll, Text, View } from "nsh";
import { copy } from "../../runtime";
import { tip } from "../tip";

export type ComposerSuggestion = { id: string; label: string; prompt: string };

export function ComposerSuggestions(props: { suggestions: readonly ComposerSuggestion[]; onPickPrompt: (prompt: string) => void }) {
  return (
    <Scroll testID="composer-suggestions" horizontal scrollbar={false} class="min-w-0 flex-1" contentStyle={{ paddingLeft: 4, paddingRight: 8, paddingTop: 4, paddingBottom: 10 }}>
      <View class="flex-row items-center gap-[6px]">
        <If
          when={props.suggestions.length > 0}
          else={<Text role="text" testID="suggest-note" class="px-[6px] py-1 text-[12px] text-ink-muted">{copy().composer.suggestNone}</Text>}
        >
          <Each of={props.suggestions} key={(s) => s.id}>
            {(suggestion) => (
              <View
                role="button"
                testID="suggest-chip"
                tooltip={tip(suggestion().prompt)}
                accessibilityLabel={suggestion().label}
                onPress={() => props.onPickPrompt(suggestion().prompt)}
                class="shrink-0 px-[10px] py-1 rounded-full bg-chip border border-line hover:bg-accent-tint hover:border-accent-border group"
              >
                <Text class="text-[12px] font-medium text-ink group-hover:text-brand">{suggestion().label}</Text>
              </View>
            )}
          </Each>
        </If>
      </View>
    </Scroll>
  );
}
