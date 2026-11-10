/**
 * Where a transcript message's hover pill is drawn, and when (`.msg-toolbar` of the Svelte groups).
 *
 * The pill stands on the message's top edge, so it reaches into the row above. The transcript is a
 * virtualised, inverted `List`: its cells are stacked in the order they were made, and the core
 * never restacks a list's cells, so a row above often drew over the pill (your bubble hid a Bot
 * reply's pill). The pill is therefore an `Overlay` anchored to the message: it draws above every
 * row, follows the message as the list scrolls, and stays the message's child for events.
 *
 * An overlay is not clipped by the list, so it is shown only while it sits on top of the message
 * and inside the transcript's band (`TranscriptClip`, the list's frame): a message whose top has
 * scrolled under the chat's header takes no pill there, as the Svelte list clipped it away.
 *
 * As in the Svelte, the pill stays a moment (`GRACE_MS`) after the pointer leaves the message or the
 * pill, fading, and still answers the pointer: a slanted path from the words to the pill leaves the
 * message first. Reduced motion keeps it whole for that moment.
 */
import { batch, cleanup, context, Overlay, signal, View, type JSX, type OverlayPosition, type ViewRef } from "nsh";
import { reduceMotion } from "../interface/motion";

/** The transcript list whose frame bounds where a pill may show; none (the default) bounds nothing. */
export const TranscriptClip = context<() => ViewRef | null>(() => null);

/** How long the pill lingers, fading, after the pointer left the message and the pill. */
const GRACE_MS = 200;

export type MessageHover = ReturnType<typeof messageHover>;

/**
 * The pointer on a message and on its pill. `hot`: on either (a Bot reply's ground). `shown`: the
 * pill is drawn, `hot` or lingering. Spread `message` on the message's view and `pill` on the pill.
 */
export function messageHover() {
  const over = signal(false);
  const onPill = signal(false);
  const lingering = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stay = () => {
    clearTimeout(timer);
    lingering.set(false);
  };
  const linger = () => {
    clearTimeout(timer);
    lingering.set(true);
    timer = setTimeout(() => lingering.set(false), GRACE_MS);
  };
  cleanup(() => clearTimeout(timer));
  const hot = () => over() || onPill();
  // Each step lands at once: one write after the other would pass through "not shown" and make the
  // pill again under the pointer, which then never hears it come in.
  return {
    hot,
    shown: () => hot() || lingering(),
    /** Going: shown only for the grace. */
    fading: () => !hot() && lingering(),
    message: {
      onMouseEnter: () =>
        batch(() => {
          stay();
          over.set(true);
        }),
      onMouseLeave: () =>
        batch(() => {
          over.set(false);
          if (!onPill()) linger();
        }),
    },
    pill: {
      onMouseEnter: () =>
        batch(() => {
          stay();
          onPill.set(true);
        }),
      onMouseLeave: () =>
        batch(() => {
          onPill.set(false);
          if (!over()) linger();
        }),
    },
  };
}

/**
 * The pill over `anchor`'s top edge, its end 8 pt in from the anchor's (the Svelte strip's
 * `left: 8px; width: calc(100% - 16px)`, the pill at its far end). Mount it while `hover.shown()`.
 */
export function MessagePill(props: { anchor: ViewRef; hover: MessageHover; children: JSX.Element }) {
  const list = TranscriptClip();
  const placed = signal<OverlayPosition | null>(null);
  const band = signal<{ top: number; bottom: number } | null>(null);
  const bounded = Boolean(list());
  // Read now, not once: the list may have moved since the last pill (a pane resized above it).
  void list()
    ?.measure()
    .then((found) => {
      if (found) band.set({ top: found.pagePosition.y, bottom: found.pagePosition.y + found.bounds.size.height });
    });
  /** On top of the message, and (in a transcript) inside its band. */
  const inView = () => {
    const at = placed();
    if (!at || at.placement !== "top") return false;
    if (!bounded) return true;
    const b = band();
    if (!b) return false;
    const top = at.bounds.origin.y;
    return top >= b.top - 0.5 && top + at.bounds.size.height <= b.bottom + 0.5;
  };
  const visible = () => inView() && (!props.hover.fading() || reduceMotion());
  return (
    <Overlay anchor={props.anchor} placement="top" align="end" offset={0} onPosition={(e) => placed.set(e)}>
      <View
        testID="msg-toolbar"
        onMouseEnter={props.hover.pill.onMouseEnter}
        onMouseLeave={props.hover.pill.onMouseLeave}
        class={`pr-[8px] ${reduceMotion() ? "" : props.hover.fading() ? "transition-opacity duration-200" : "transition-opacity duration-150"} ${visible() ? "opacity-100" : "opacity-0"}`}
        style={{ pointerEvents: inView() ? "auto" : "none" }}
      >
        {props.children}
      </View>
    </Overlay>
  );
}
