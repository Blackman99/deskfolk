/**
 * A strip of ticks, one per message (`MessageIndex.svelte`): yours in the accent, a Bot's in grey, so
 * the rhythm of who spoke reads at a glance. Under the pointer the strip lifts onto a surface of its
 * own; pointing at or focusing a tick opens a card with the line, who said it and when; a press jumps
 * there. Arrow keys, Home and End move between ticks, Escape closes the card. A conversation as
 * narrow as a phone's has no strip.
 */
import { cleanup, effect, keymap, Overlay, Scroll, signal, Text, token, View, windowSize, type ViewRef } from "nsh";
import { USER_MEMBER } from "@real-bot/protocol";
import { formatDateDivider, formatMessageTime } from "../../m/chat/chat-view";
import type { IndexMark } from "../../m/chat/message-index";
import { shadow } from "../styles";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

const ROW = 10;

export function MessageIndex(props: {
  marks: readonly IndexMark[];
  activeId: string | null;
  locale: "zh" | "en";
  label: string;
  emptyLabel: string;
  sender: (mark: IndexMark) => string;
  hasEarlier?: boolean;
  loading?: boolean;
  earlierLabel?: string;
  onLoadEarlier?: () => void;
  onJump: (mark: IndexMark) => void;
  /** The tallest the strip grows (the stage's height less the composer's and some room). */
  maxHeight?: number;
}) {
  const previewId = signal<string | null>(null);
  const anchorY = signal(0);
  const anchorX = signal(0);
  const hovered = signal(false);
  const focusedId = signal<string | null>(null);
  const viewport = signal(0);
  const scroll = signal<{ scrollTo(o: { y: number; animated?: boolean }): void } | null>(null);
  const nodes = new Map<string, ViewRef>();
  let root: ViewRef | null = null;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const preview = () => props.marks.find((m) => m.id === previewId());
  const previewIndex = () => props.marks.findIndex((m) => m.id === previewId());
  const lifted = () => hovered() || focusedId() !== null;

  function close(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    previewId.set(null);
  }
  cleanup(close);

  // The active tick stays in view while the stripe scrolls.
  effect(() => {
    const id = props.activeId;
    const area = scroll();
    if (!id || !area || previewId()) return;
    const top = props.marks.findIndex((m) => m.id === id) * ROW;
    if (top < 0) return;
    area.scrollTo({ y: Math.max(0, top - viewport() / 2 + ROW), animated: false });
  });

  function show(mark: IndexMark, immediate = false): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    const reveal = async () => {
      const node = nodes.get(mark.id);
      const box = await node?.measure();
      if (!node || !box) return;
      anchorX.set(box.pagePosition.x + box.bounds.size.width + 4);
      anchorY.set(box.pagePosition.y + box.bounds.size.height / 2);
      previewId.set(mark.id);
    };
    if (immediate || previewId()) void reveal();
    else openTimer = setTimeout(() => void reveal(), 120);
  }

  function leave(): void {
    clearTimeout(openTimer);
    closeTimer = setTimeout(close, 160);
  }

  function jump(mark: IndexMark): void {
    props.onJump(mark);
    close();
  }

  function move(to: (index: number) => number): void {
    const at = props.marks.findIndex((m) => m.id === focusedId());
    if (at < 0) return;
    const next = props.marks[Math.max(0, Math.min(props.marks.length - 1, to(at)))];
    if (next) nodes.get(next.id)?.focus();
  }

  // The keys are the strip's only while a tick has the focus (or a card is open).
  effect(() => {
    if (focusedId() === null && previewId() === null) return;
    const off = [
      keymap.bind("escape", () => close(), { when: "always" }),
      keymap.bind("up", () => move((i) => i - 1), { when: "always", repeat: true }),
      keymap.bind("down", () => move((i) => i + 1), { when: "always", repeat: true }),
      keymap.bind("home", () => move(() => 0), { when: "always" }),
      keymap.bind("end", () => move(() => props.marks.length - 1), { when: "always" }),
    ];
    return () => off.forEach((f) => f());
  });

  const tick = (mark: IndexMark, index: () => number) => {
    const you = mark.author === USER_MEMBER;
    const active = () => mark.id === props.activeId;
    const previewing = () => mark.id === previewId() || focusedId() === mark.id;
    const proximity = () => (previewIndex() < 0 ? 0 : Math.max(0, 3 - Math.abs(index() - previewIndex())));
    const width = () => (previewing() ? 18 : active() ? 12 : 8 + proximity() * 3);
    return (
      <View
        role="button"
        testID={`index-${mark.id}`}
        accessibilityLabel={`${props.sender(mark)} · ${mark.preview || props.emptyLabel}`}
        accessibilityState={{ selected: active() }}
        ref={(node: ViewRef) => nodes.set(mark.id, node)}
        onMouseEnter={() => show(mark)}
        onMouseLeave={leave}
        onFocus={() => {
          focusedId.set(mark.id);
          show(mark, true);
        }}
        onBlur={() => {
          if (focusedId() === mark.id) focusedId.set(null);
          leave();
        }}
        onPress={() => jump(mark)}
        class="cursor-pointer select-none w-[28px] items-center justify-center"
        style={{ height: ROW }}
      >
        <View
          accessible={false}
          style={{
            width: width(),
            height: previewing() ? 4 : 2,
            borderRadius: 2,
            backgroundColor: token(previewing() || active() ? (you ? "brand" : previewing() ? "ink" : "ink-secondary") : you ? "brand" : "muted-light"),
            opacity: (lifted() || active() || previewing() ? 1 : 0.4) * (you && !active() && !previewing() ? 0.55 : 1),
          }}
        />
      </View>
    );
  };

  return (
    <If when={!narrowWindow()}>
      <View
        testID="message-index"
        accessibilityLabel={props.label}
        role="navigation"
        class="absolute left-[6px] top-0 bottom-0 w-[28px] justify-center z-[6]"
        style={{ pointerEvents: "box-none" }}
      >
        <View
          ref={(node: ViewRef) => (root = node)}
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          class={`w-[28px] rounded-(--radius-md) ${lifted() ? "bg-row-hover" : ""}`}
          style={{ maxHeight: props.maxHeight ?? 360 }}
        >
          <If when={props.hasEarlier}>
            <View
              role="button"
              testID="index-earlier"
              accessibilityLabel={props.earlierLabel}
              tooltip={tip(props.earlierLabel ?? "")}
              disabled={props.loading}
              onPress={() => props.onLoadEarlier?.()}
              class="cursor-pointer select-none disabled:cursor-default w-[28px] h-[24px] items-center justify-center shrink-0"
            >
              <Text class="text-[12px] text-ink-muted">{props.loading ? "⋯" : "↑"}</Text>
            </View>
          </If>
          <Scroll
            ref={(node: { scrollTo(o: { y: number; animated?: boolean }): void }) => scroll.set(node)}
            scrollbar={false}
            class="shrink min-h-0 py-[4px]"
            onLayout={(e) => viewport.set(e.bounds.size.height)}
            onScroll={() => {
              if (previewId() !== null) close();
            }}
          >
            <Each of={props.marks} key={(m) => m.id}>{(mark, index) => tick(mark(), index)}</Each>
          </Scroll>
        </View>
        <If when={preview()}>
          {(mark) => (
            <Overlay
              anchor={{ x: anchorX(), y: anchorY() }}
              placement="right"
              align="center"
              margin={8}
              onCancel={close}
            >
              <View
                role="button"
                testID="message-index-card"
                onPress={() => jump(mark())}
                onMouseEnter={() => clearTimeout(closeTimer)}
                onMouseLeave={leave}
                class="cursor-pointer select-none px-[14px] py-[12px] bg-pane border border-line rounded-(--radius-md) hover:border-line-hover"
                style={{ width: Math.min(320, windowSize().width - 80), boxShadow: shadow("md") }}
              >
                <Text testID="message-index-preview" class="text-[13px] text-ink line-clamp-4">{mark().preview || props.emptyLabel}</Text>
                <View class="flex-row items-center gap-[8px] mt-[10px]">
                  <Text class="max-w-[100px] text-[10px] text-ink-muted line-clamp-1">{props.sender(mark())}</Text>
                  <Text class="text-[10px] text-ink-muted">{`${formatDateDivider(mark().created_at, props.locale)} ${formatMessageTime(mark().created_at)}`}</Text>
                  <Text class="ml-auto text-[10px] text-ink-muted">{`${previewIndex() + 1} / ${props.marks.length}`}</Text>
                </View>
              </View>
            </Overlay>
          )}
        </If>
      </View>
    </If>
  );
}
