/**
 * Where `createStageScroll`'s jump to the bottom lands, on an inverted `List` set up as the chat
 * stage's is (`ChatStage.tsx`: 20pt at both ends, a 16pt gap, 96pt estimates). Rows are
 * plain blocks of a height of their own, the newest (index 0) as tall as the story says, so a newest
 * line taller than the window can be told from a short one. `distance` is the stage's own reading,
 * how far the view is from the newest line, from the list's last scroll event.
 */
import { List, signal, Text, View } from "nsh";
import { createStageScroll } from "../src/ui/chat/stage-scroll";

type Row = { id: string; height: number };

const newestHeight = signal(900);
const rows = (): Row[] => Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}`, height: i === 0 ? newestHeight() : 60 }));

export default function StageScrollStory() {
  const scroll = createStageScroll({
    sessionId: () => "story",
    highlightedId: () => null,
    highlightToken: () => 0,
    indexOf: () => -1,
    activeFor: () => null,
    hasOlder: () => false,
    olderLoading: () => false,
    loadOlder: () => {},
  });
  const button = (testID: string, label: string, onPress: () => void) => (
    <View role="button" testID={testID} onPress={onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{label}</Text>
    </View>
  );
  return (
    <View class="flex-1 bg-pane">
      <View class="flex-row items-center gap-3 p-2">
        {button("story-animated", "to bottom (animated)", () => scroll.scrollToBottom(true))}
        {button("story-instant", "to bottom (instant)", () => scroll.scrollToBottom(false))}
        {button("story-short", "newest 60", () => newestHeight.set(60))}
        <Text testID="story-distance" class="text-[12px] text-ink-muted">{`distance:${Math.round(scroll.distance())}`}</Text>
        <Text testID="story-button" class="text-[12px] text-ink-muted">{`button:${scroll.showBottom() ? "yes" : "no"}`}</Text>
      </View>
      <List
        testID="transcript"
        ref={scroll.ref}
        each={rows()}
        inverted
        keyExtractor={(row: Row) => row.id}
        class="flex-1 bg-pane"
        contentStyle={{ paddingLeft: 24, paddingRight: 24, paddingTop: 20, paddingBottom: 20, gap: 16 }}
        estimatedItemSize={96}
        onScroll={scroll.onScroll}
      >
        {(row: () => Row) => (
          <View style={{ height: row().height }} class="rounded-(--radius-md) border border-line bg-input-bg p-2">
            <Text class="text-[12px] text-ink">{row().id}</Text>
          </View>
        )}
      </List>
    </View>
  );
}
