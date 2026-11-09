/**
 * The @ list above the box (`MentionPopup.svelte`): the Bots whose name or duties fit what follows
 * the `@`, with `everyone` first in a group. The composer keeps the keys (↑↓ move, Enter or Tab
 * pick, Esc close); pointing at a row moves the highlight and pressing one picks it. The Svelte
 * one took the whole `ComposerMentions` object (bound to the editor's DOM); this takes what it
 * shows: the candidates, the highlighted row, and what pointing and picking do. The editor places
 * it (an `Overlay` over the caret).
 */
import { Scroll, Text, View, effect, type ScrollRef } from "nsh";
import { botAvatarColor, avatarSrc } from "../../m/avatar";
import type { MentionCandidate } from "../../m/chat/composer-mentions.svelte";
import { rosterLetter } from "../../m/sidebar/roster-letter";
import { copy } from "../../runtime";
import { AvatarPicture } from "../AvatarPicture";
import { shadow, cssColor } from "../styles";
import { KeyHints } from "./KeyHints";

const MAX_HEIGHT = 240;

export function MentionPopup(props: {
  candidates: readonly MentionCandidate[];
  /** The highlighted row. */
  highlight: number;
  onHover: (index: number) => void;
  onPick: (candidate: MentionCandidate) => void;
  /** The popup's width (the Svelte's `min(380px, 100% - 48px)`, given by the editor from its own width). */
  width?: number;
}) {
  const scroller: { ref: ScrollRef | null } = { ref: null };
  const bounds = new Map<number, { y: number; height: number }>();
  const viewport = { y: 0, height: 0 };
  // The row the keys are on stays in view (`scrollTopToRevealRect`).
  effect(() => {
    const at = bounds.get(props.highlight);
    if (!at || !scroller.ref || viewport.height === 0) return;
    if (at.y < viewport.y) scroller.ref.scrollTo({ y: at.y });
    else if (at.y + at.height > viewport.y + viewport.height) scroller.ref.scrollTo({ y: at.y + at.height - viewport.height });
  });
  return (
    <View
      testID="mention-popup"
      role="list"
      class="bg-pane border border-line rounded-(--radius-lg) p-[6px] gap-[2px]"
      style={{ width: props.width ?? 380, boxShadow: shadow("menu") }}
    >
      <Text testID="mention-header" class="pt-3 px-5 pb-2 text-[12px] font-semibold text-ink-muted">{copy().chat.mentionTooltip}</Text>
      <Scroll
        style={{ maxHeight: MAX_HEIGHT }}
        ref={(node: ScrollRef | null) => (scroller.ref = node)}
        onLayout={(e) => (viewport.height = e.bounds.size.height)}
        onScroll={(e) => (viewport.y = e.offset.y)}
      >
        <Each of={props.candidates} key={(cand) => cand.id}>
          {(cand, idx) => (
            <View
              role="button"
              testID={`mention-${cand().id}`}
              accessibilityLabel={`@${cand().name}`}
              accessibilityState={{ selected: idx() === props.highlight }}
              onMouseEnter={() => props.onHover(idx())}
              onPress={() => props.onPick(cand())}
              onLayout={(e) => bounds.set(idx(), { y: e.bounds.origin.y, height: e.bounds.size.height })}
              class={`cursor-pointer select-none flex-row items-center gap-[10px] px-[10px] py-2 rounded-(--radius-md) ${idx() === props.highlight ? "bg-accent-tint" : ""}`}
            >
              <Avatar cand={cand()} />
              <View class="flex-1 min-w-0">
                <Text class="text-[13px] font-semibold text-ink">{`@${cand().name}`}</Text>
                <If when={cand().duties}>{(duties) => <Text class="text-[11px] text-ink-muted line-clamp-1">{duties()}</Text>}</If>
              </View>
            </View>
          )}
        </Each>
      </Scroll>
      <KeyHints hints={[["↑↓", copy().chat.mentionKeys.move], ["Enter", copy().chat.mentionKeys.pick], ["Esc", copy().chat.mentionKeys.close]]} />
    </View>
  );
}

function Avatar(props: { cand: MentionCandidate }) {
  const palette = () => botAvatarColor(props.cand.id);
  return (
    <If
      when={!props.cand.isEveryone}
      else={
        <View class="shrink-0 w-[26px] h-[26px] rounded-[8px] items-center justify-center bg-chip border border-line">
          <Text class="text-[14px]">👥</Text>
        </View>
      }
    >
      <If
        when={Boolean(props.cand.avatar && avatarSrc(props.cand.avatar))}
        else={
          <View
            class="shrink-0 w-[26px] h-[26px] rounded-[8px] items-center justify-center border"
            style={{ backgroundColor: cssColor(palette().bg), borderColor: cssColor(palette().border) }}
          >
            <Text class="text-[12px] font-bold" style={{ color: cssColor(palette().text) }}>{rosterLetter(props.cand.name)}</Text>
          </View>
        }
      >
        <View class="shrink-0 w-[26px] h-[26px] rounded-full overflow-hidden">
          <AvatarPicture avatar={props.cand.avatar} />
        </View>
      </If>
    </If>
  );
}
