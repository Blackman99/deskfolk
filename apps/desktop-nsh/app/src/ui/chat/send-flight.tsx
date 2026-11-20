/**
 * A line you send flies from the message box up into the conversation, as Telegram's does: the
 * words leave the box where you typed them, become your bubble on the way, and land where the line
 * now stands in the transcript.
 *
 * The transcript is a `List` above the composer, and a list clips its rows, so the row itself can't
 * travel down into the box. While the line is on its way the row is kept invisible in its place and
 * a stand-in (`SendFlightLayer`, an `Overlay` clipped to the conversation and deaf to the pointer)
 * flies instead: two copies of the row's bubble at the bubble's measured size, the words as the box
 * showed them fading out over the bubble fading in. It ends on the row's own pixels, and the row
 * takes over in the same commit.
 *
 * It moves by style transitions (two nested views, so across and up take their own curves), which
 * the platform runs on its own; the stand-in follows the bubble each frame, so a Bot's reply or a
 * failed turn's card pushing the transcript up on the way does not leave it landing beside the row.
 *
 * Not on the phone's page yet: the web's frames (`measure` against the overlay's), touches through
 * the overlay and its cost there have not been checked on a phone, and the line rises as before.
 *
 * Only a line of words alone flies (no files, no quote), sent while the reader was at the newest
 * line, with motion not reduced. Anything else, or anything that goes wrong on the way (the send
 * refused, the row never placed, the conversation switched, a frame not measured, the bubble not
 * whole in view), leaves the row to show as it would have: it is never left hidden.
 *
 * The composer arms it at the press (`arm`), measuring where its words are while they are still
 * there; the row claims it when it mounts (`claim`), hides while `hides` says so and reports its
 * bubble once laid out (`placed`). It sets off at the later of the send coming back and the row
 * being placed: what was staged stays in the box until the Mac has it, so the words leave the box
 * when the box empties, not at the press.
 */
import { batch, cleanup, context, Overlay, platform, View, signal, windowSize, type JSX, type ViewRef, type ViewStyle } from "nsh";
import { reduceMotion } from "../interface/motion";

/** A frame in the window (the root view), in points. */
export type Rect = { x: number; y: number; width: number; height: number };

/** Where the words of the box are: its editor's view, and the words' offset inside it (the editor's padding). */
export type WordsAt = { node: ViewRef; inset: { x: number; y: number } };

/**
 * The row's bubble drawn for the stand-in, filling the box it is given: `words` as the box showed
 * them (no ground, the box's ink), else the bubble as the row draws it.
 */
export type GhostBubble = (words: boolean) => JSX.Element;

/** Both bubbles keep their words this far in from their top left corner (`px-[14px] py-[10px]`). */
export const BUBBLE_INSET = { x: 14, y: 10 };

/**
 * Telegram's own send transition (iOS `ChatMessageTransitionNode`, its default `.bezier` parameters):
 * 0.3 s on both axes. Across goes most of the way at once and eases out; up eases in and out. So the
 * line swings across to its side first and rises into place, with nothing moving away from where it
 * is going (a dip below the box, tried first, read as slow and unnatural).
 */
const ACROSS_MS = 300;
const ACROSS_CURVE = "cubic-bezier(0.23, 1, 0.32, 1)";
const RISE_MS = 300;
const RISE_CURVE = "cubic-bezier(0.199, 0.011, 0.279, 0.910)";
/** The box's words give way to the bubble's while it leaves the box. */
const WORDS_OUT_MS = 150;
const BUBBLE_IN_MS = 180;
/** When the stand-in hands over to the row: after the longest of the above. */
const LAND_MS = Math.max(ACROSS_MS, RISE_MS) + 30;

/** How long a placed row waits, hidden, for the send to come back (the box still holding the words). */
const PLACED_WAIT_MS = 150;
/** How long a send that came back waits for its row to be placed. */
const SENT_WAIT_MS = 600;
/** Whatever happens, an armed flight is given up after this. */
const ARMED_MS = 6000;
/** A row shown without its flight fades in over this. */
const REVEAL_MS = 200;
/** Past its landing, a flight that has not landed (no display frames: the window hidden right after the press) gives its row back. */
const OVERDUE_MS = 1000;

const HIDDEN: ViewStyle = { opacity: 0 };
const REVEAL: ViewStyle = { opacity: 1, transitionProperty: "opacity", transitionDuration: REVEAL_MS, transitionTimingFunction: "ease-out" };

/** One flight under way: what the layer draws. */
export type Flying = {
  id: number;
  messageId: string;
  /** Where the box's words started (their top left corner). */
  words: { x: number; y: number };
  /** The bubble in the transcript, when it set off. */
  to: Rect;
  /** The bubble's view: the stand-in follows it should the transcript move under it on the way. */
  node: ViewRef;
  /** The conversation's frame: the stand-in never draws outside it. */
  clip: Rect;
  ghost: GhostBubble;
};

type Armed = {
  text: string;
  /** The newest line when it was armed: only a line after it is the one sent. */
  after: string | null;
  words: Promise<{ x: number; y: number } | null>;
  sent: boolean;
  messageId: string | null;
  row: { node: ViewRef; ghost: GhostBubble } | null;
  wait: ReturnType<typeof setTimeout> | undefined;
  expiry: ReturnType<typeof setTimeout>;
};

export type SendFlight = ReturnType<typeof createSendFlight>;

/** The flight of the conversation the row is in; none (the default) flies nothing. */
export const SendFlightOf = context<SendFlight | null>(null);

function rectOf(measured: { bounds: { size: { width: number; height: number } }; pagePosition: { x: number; y: number } } | null): Rect | null {
  if (!measured) return null;
  return { x: measured.pagePosition.x, y: measured.pagePosition.y, width: measured.bounds.size.width, height: measured.bounds.size.height };
}

/**
 * One conversation's flights (one at a time). `frame` is the conversation (the stand-in's clip),
 * `list` the transcript (the bubble must sit whole inside it), `atLatest` whether the reader is at
 * the newest line, `session` the conversation shown: a switch gives up what is on its way.
 * `newest` is the id of the conversation's newest line (ids are ULIDs, in the order they were made):
 * a line older than the press never takes the flight, even saying the same and made anew meanwhile.
 * `nextFrame` is when the box has emptied and the list moved for it (the next display frame; a test
 * without a display brings its own).
 */
export function createSendFlight(deps: {
  frame: () => ViewRef | null;
  list: () => ViewRef | null;
  atLatest: () => boolean;
  session: () => string | null;
  newest?: () => string | null;
  nextFrame?: (fn: () => void) => void;
}) {
  const nextFrame = deps.nextFrame ?? ((fn: () => void) => void requestAnimationFrame(() => fn()));
  let armed: Armed | null = null;
  let count = 0;
  let session = deps.session();
  const hidden = signal<ReadonlySet<string>>(new Set());
  const revealing = signal<ReadonlySet<string>>(new Set());
  const flying = signal<Flying | null>(null);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const without = (set: ReadonlySet<string>, id: string) => new Set([...set].filter((x) => x !== id));

  /** The row shows again, fading in: it did not fly. */
  function reveal(id: string): void {
    batch(() => {
      hidden.set(without(hidden(), id));
      revealing.set(new Set([...revealing(), id]));
    });
    later(() => revealing.set(without(revealing(), id)), REVEAL_MS + 50);
  }

  /** Gives up what is armed; its row, if one claimed it, shows as it would have. */
  function disarm(): void {
    const was = armed;
    if (!was) return;
    armed = null;
    clearTimeout(was.wait);
    clearTimeout(was.expiry);
    if (was.messageId) reveal(was.messageId);
  }

  /** The stand-in hands over to the row, in one commit. */
  function finish(): void {
    const was = flying();
    if (!was) return;
    batch(() => {
      hidden.set(without(hidden(), was.messageId));
      flying.set(null);
    });
  }

  /** Sets off: both ends measured once the box has emptied and the list moved for it. */
  function go(): void {
    const was = armed;
    if (!was || !was.row || !was.messageId) return;
    armed = null;
    clearTimeout(was.wait);
    clearTimeout(was.expiry);
    const messageId = was.messageId;
    const row = was.row;
    const from = session;
    // Frames may stop (the window hidden right after the press): the row is given back all the same.
    later(() => {
      if (flying()?.messageId === messageId) finish();
      else if (hidden().has(messageId)) reveal(messageId);
    }, LAND_MS + OVERDUE_MS);
    nextFrame(() => {
      void Promise.all([was.words, row.node.measure(), deps.frame()?.measure() ?? null, deps.list()?.measure() ?? null])
        .then(([words, bubble, frame, list]) => {
          const to = rectOf(bubble);
          const clip = rectOf(frame);
          const band = rectOf(list);
          const whole = to && band && to.height > 0 && to.y >= band.y - 1 && to.y + to.height <= band.y + band.height + 1;
          if (!hidden().has(messageId)) return;
          if (session !== from || !words || !to || !clip || !whole || reduceMotion()) {
            reveal(messageId);
            return;
          }
          finish();
          flying.set({ id: ++count, messageId, words, to, node: row.node, clip, ghost: row.ghost });
        })
        .catch(() => reveal(messageId));
    });
  }

  return {
    hidden,
    flying,
    finish,

    /**
     * At the press, before the send: where the words are, what they say, and whether they go alone
     * (no files, no quote). Returns what to call once the send came back, with whether the Mac took it.
     */
    arm(at: WordsAt | null, text: string, alone: boolean): (sent: boolean) => void {
      disarm();
      finish();
      const words = text.trim();
      if (!at || !alone || !words || platform.os === "web" || !deps.atLatest() || reduceMotion()) return () => {};
      const mine: Armed = {
        text: words,
        after: deps.newest?.() ?? null,
        words: at.node
          .measure()
          .then((m) => {
            const box = rectOf(m);
            return box ? { x: box.x + at.inset.x, y: box.y + at.inset.y } : null;
          })
          .catch(() => null),
        sent: false,
        messageId: null,
        row: null,
        wait: undefined,
        expiry: setTimeout(() => armed === mine && disarm(), ARMED_MS),
      };
      armed = mine;
      return (sent) => {
        if (armed !== mine) return;
        if (!sent) return disarm();
        mine.sent = true;
        clearTimeout(mine.wait);
        if (mine.row) go();
        else mine.wait = setTimeout(() => armed === mine && disarm(), SENT_WAIT_MS);
      };
    },

    /**
     * A row mounting: whether it is the line on its way (yours, saying what was sent), and so takes
     * the flight instead of its own entrance. Asked again by a row made anew, it says the same.
     */
    claim(messageId: string, body: string, mine: boolean): boolean {
      if (!armed) return false;
      if (armed.messageId === messageId) return true;
      if (armed.messageId || !mine || body.trim() !== armed.text) return false;
      if (armed.after !== null && messageId <= armed.after) return false;
      armed.messageId = messageId;
      hidden.set(new Set([...hidden(), messageId]));
      return true;
    },

    /** The row's style while its line is on its way: hidden, or fading in when it did not fly. */
    hides(messageId: string): ViewStyle | undefined {
      if (hidden().has(messageId)) return HIDDEN;
      if (revealing().has(messageId)) return REVEAL;
      return undefined;
    },

    /** The claiming row's bubble is laid out: what to measure, and how to draw it on the way. */
    placed(messageId: string, node: ViewRef, ghost: GhostBubble): void {
      const mine = armed;
      if (!mine || mine.messageId !== messageId) return;
      const first = !mine.row;
      mine.row = { node, ghost };
      if (mine.sent) return go();
      if (first) mine.wait = setTimeout(() => armed === mine && disarm(), PLACED_WAIT_MS);
    },

    /** The conversation shown changed, or went: nothing on its way is still wanted. */
    switched(next: string | null): void {
      if (next === session) return;
      session = next;
      disarm();
      finish();
    },

    dispose(): void {
      disarm();
      finish();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Draws the flight under way, above the conversation and clipped to it. Put it last in the conversation's view. */
export function SendFlightLayer(props: { flight: SendFlight }) {
  const shown = () => {
    const now = props.flight.flying();
    return now ? [now] : [];
  };
  return (
    <Each of={shown()} key={(f: Flying) => f.id}>
      {(f: () => Flying) => <Ghost flight={f()} onLanded={props.flight.finish} />}
    </Each>
  );
}

const ACROSS: ViewStyle = { transitionProperty: "transform", transitionDuration: ACROSS_MS, transitionTimingFunction: ACROSS_CURVE };
const RISE: ViewStyle = { transitionProperty: "transform", transitionDuration: RISE_MS, transitionTimingFunction: RISE_CURVE };
const WORDS_OUT: ViewStyle = { transitionProperty: "opacity", transitionDuration: WORDS_OUT_MS, transitionTimingFunction: "ease-out" };
const BUBBLE_IN: ViewStyle = { transitionProperty: "opacity", transitionDuration: BUBBLE_IN_MS, transitionTimingFunction: "ease-out" };

/**
 * The stand-in. It is made where it starts with no transition on it (a view made with one would
 * first move from the style's default to its start), and set going on the frame after it was laid
 * out; then it lands, and the row takes over.
 *
 * Its way is an offset from the bubble, easing to none, so where it lands is wherever the bubble is
 * then: a Bot's reply starting or a failed turn's card under your line moves the transcript while
 * the line is on its way, and the stand-in is moved with it each frame (`to`, untransitioned).
 */
function Ghost(props: { flight: Flying; onLanded: () => void }) {
  const f = props.flight;
  const going = signal(false);
  const to = signal<Rect>(f.to);
  // The bubble's words start where the box's were.
  const dx = f.words.x - (f.to.x + BUBBLE_INSET.x);
  const dy = f.words.y - (f.to.y + BUBBLE_INSET.y);
  let started = false;
  let landing: ReturnType<typeof setTimeout> | undefined;
  let following = true;
  const follow = () => {
    if (!following) return;
    void f.node
      .measure()
      .then((m) => {
        const now = rectOf(m);
        const was = to();
        if (following && now && (now.x !== was.x || now.y !== was.y)) to.set({ ...was, x: now.x, y: now.y });
      })
      .catch(() => {})
      .finally(() => {
        if (following) requestAnimationFrame(follow);
      });
  };
  requestAnimationFrame(follow);
  const start = () => {
    if (started) return;
    started = true;
    requestAnimationFrame(() => {
      going.set(true);
      landing = setTimeout(props.onLanded, LAND_MS);
    });
  };
  // Should the first layout never be told, it still sets off.
  const late = setTimeout(start, 50);
  cleanup(() => {
    following = false;
    clearTimeout(late);
    clearTimeout(landing);
  });
  return (
    <Overlay style={{ width: windowSize().width, height: windowSize().height, pointerEvents: "none" }}>
      <View
        testID="send-flight"
        style={{ position: "absolute", left: f.clip.x, top: f.clip.y, width: f.clip.width, height: f.clip.height, overflow: "hidden", pointerEvents: "none" }}
      >
        <View
          onLayout={start}
          style={{
            position: "absolute",
            left: to().x - f.clip.x,
            top: to().y - f.clip.y,
            width: f.to.width,
            height: f.to.height,
            ...(going() ? { translate: [0, 0], ...ACROSS } : { translate: [dx, 0] }),
          }}
        >
          <View class="w-full h-full" style={going() ? { translate: [0, 0], ...RISE } : { translate: [0, dy] }}>
            <View class="absolute inset-0" style={going() ? { opacity: 1, ...BUBBLE_IN } : { opacity: 0 }}>
              {f.ghost(false)}
            </View>
            <View class="absolute inset-0" style={going() ? { opacity: 0, ...WORDS_OUT } : { opacity: 1 }}>
              {f.ghost(true)}
            </View>
          </View>
        </View>
      </View>
    </Overlay>
  );
}
