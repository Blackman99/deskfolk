/**
 * A styled tip for one rail control (`RailTooltip.svelte`). The tip is an `Overlay` to the right of
 * its button (the other side when there is no room, which the overlay decides), so the rail's
 * clipping cannot cut it. Hover waits 200ms, keyboard focus does not. The pointer can move from the
 * button into the tip (a 140ms grace) and rest there. Escape dismisses it and stops there. A press, a
 * right click, a scroll of the rail (`dismissRailTips`) and a resize close it.
 *
 * The button is a `View`: `onAnchor` hands its ref over for a menu that hangs off it. `onArrow` is the
 * Svelte `onkeydown` the tools button used for ArrowUp / ArrowDown; it hears the two keys only while
 * the button has the focus.
 */
import { cleanup, effect, keymap, Overlay, signal, Text, untracked, View, windowSize, type ContextMenuEvent, type JSX, type PressEvent, type ViewRef } from "nsh";
import { shadow } from "../styles";

/** Long enough that a pass across the rail does not light every tip; short enough to feel waiting. */
export const HOVER_DELAY_MS = 200;
/** How long the way from the button onto the tip may take. */
export const LEAVE_GRACE_MS = 140;
const MARGIN = 8;
const GAP = 8;

const scrolled = signal(0);
/** The rail scrolled: every tip showing goes, as the Svelte one's capture-phase scroll listener did. */
export function dismissRailTips(): void {
  scrolled.set(scrolled() + 1);
}

export function RailTooltip(props: {
  /** What the tip says. A string is one line; lines stack, the first as the title. */
  label: string | readonly string[];
  /** Accessible name of the control. Defaults to the tip's first line. */
  name?: string;
  /** Names the tip (its test id). */
  describedBy: string;
  /** When false the control is disabled for readers and its press is swallowed; the tip still explains. */
  enabled?: boolean;
  class?: string;
  testID?: string;
  /** `aria-current` / `aria-expanded` / `aria-pressed` of the button. */
  current?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  onPress?: () => void;
  onContextMenu?: (e: ContextMenuEvent) => void;
  /** A press that may become a drag (the Svelte `onpointerdown`). */
  onPressDown?: (e: PressEvent) => void;
  /** ArrowUp / ArrowDown while the button has the focus. */
  onArrow?: (key: "up" | "down") => void;
  onAnchor?: (node: ViewRef) => void;
  children?: JSX.Element;
}) {
  const open = signal(false);
  const focusedKey = signal(false);
  let button: ViewRef | null = null;
  const anchor = signal<ViewRef | null>(null);
  /** Hover is pending the delay; focus and a move into the tip are not. */
  let hovering = false;
  let focusing = false;
  let overTip = false;
  let isOpen = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const lines = () => (Array.isArray(props.label) ? (props.label as readonly string[]) : [props.label as string]).map((line) => line.trim()).filter((line) => line.length > 0);
  const accessibleName = () => props.name ?? lines()[0] ?? "";
  const enabled = () => props.enabled !== false;

  function setOpen(value: boolean): void {
    isOpen = value;
    open.set(value);
  }

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }
  cleanup(clearTimer);

  function show(): void {
    clearTimer();
    setOpen(true);
  }

  function hide(): void {
    clearTimer();
    hovering = false;
    focusing = false;
    overTip = false;
    setOpen(false);
  }

  function onMouseEnter(): void {
    hovering = true;
    if (isOpen || focusing) {
      show();
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (hovering) setOpen(true);
    }, HOVER_DELAY_MS);
  }

  function onMouseLeave(): void {
    hovering = false;
    clearTimer();
    // The way onto the tip is a leave of the button and then an enter of the tip: the grace bridges it.
    if (focusing || overTip) return;
    timer = setTimeout(() => {
      timer = null;
      if (!hovering && !overTip && !focusing) setOpen(false);
    }, LEAVE_GRACE_MS);
  }

  function onTipEnter(): void {
    overTip = true;
    clearTimer();
  }

  async function onTipLeave(e: { pagePosition: { x: number; y: number } }): Promise<void> {
    overTip = false;
    clearTimer();
    const box = await button?.measure();
    if (box) {
      const { x, y } = e.pagePosition;
      const inside = x >= box.pagePosition.x && x <= box.pagePosition.x + box.bounds.size.width && y >= box.pagePosition.y && y <= box.pagePosition.y + box.bounds.size.height;
      if (inside) {
        hovering = true;
        return;
      }
    }
    if (!hovering && !focusing && !overTip) setOpen(false);
  }

  function onFocus(): void {
    focusedKey.set(true);
    focusing = true;
    show();
  }

  function onBlur(): void {
    focusedKey.set(false);
    focusing = false;
    if (!hovering && !overTip) setOpen(false);
  }

  function onPress(): void {
    hide();
    if (!enabled()) return;
    props.onPress?.();
  }

  // The arrows are the button's only while it has the focus.
  effect(() => {
    if (!focusedKey() || !props.onArrow) return;
    const off = [
      keymap.bind("down", () => props.onArrow?.("down"), { when: "always" }),
      keymap.bind("up", () => props.onArrow?.("up"), { when: "always" }),
    ];
    return () => off.forEach((f) => f());
  });

  // A resize or a scroll of the rail takes the tip away.
  let lastSize = untracked(() => windowSize());
  effect(() => {
    const size = windowSize();
    if (size.width === lastSize.width && size.height === lastSize.height) return;
    lastSize = size;
    if (isOpen) hide();
  });
  let lastScroll = untracked(() => scrolled());
  effect(() => {
    const now = scrolled();
    if (now === lastScroll) return;
    lastScroll = now;
    if (isOpen) hide();
  });

  return (
    <>
      <View
        role="button"
        testID={props.testID}
        ref={(node: ViewRef) => {
          button = node;
          anchor.set(node);
          props.onAnchor?.(node);
        }}
        accessibilityLabel={accessibleName()}
        accessibilityState={{ disabled: !enabled(), current: props.current, expanded: props.expanded, pressed: props.pressed }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onPressDown={(e) => {
          hide();
          props.onPressDown?.(e);
        }}
        onPress={onPress}
        onContextMenu={(e) => {
          hide();
          props.onContextMenu?.(e);
        }}
        class={`${props.class ?? ""} ${enabled() ? "" : "opacity-[0.35]"}`}
      >
        {props.children}
      </View>
      <If when={open() && lines().length > 0 ? anchor() : null}>
        {(target) => (
          <Overlay
            anchor={target()}
            placement="right"
            align="center"
            offset={GAP}
            margin={MARGIN}
            onCancel={() => {
              // Dismissed, not a blur: keyboard focus stays, and the tip stays gone until the pointer
              // or focus comes back.
              hide();
            }}
          >
            <View
              testID={props.describedBy}
              accessibilityLabel={lines().join(" · ")}
              onMouseEnter={onTipEnter}
              onMouseLeave={onTipLeave}
              class="gap-[2px] max-w-[280px] px-2 py-[6px] bg-pane border border-line rounded-(--radius-sm)"
              style={{ boxShadow: shadow("md") }}
            >
              {() =>
                lines().map((line, index) => (
                  <Text class={`text-[12px] leading-[16px] ${index > 0 ? "font-normal text-ink-muted" : "font-medium text-ink"}`}>{line}</Text>
                ))
              }
            </View>
          </Overlay>
        )}
      </If>
    </>
  );
}
