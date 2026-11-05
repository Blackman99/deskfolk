import { getContext, setContext, untrack } from 'svelte';
import { HOME, type HomeCopy } from './copy';
import { activeSection, sectionProgress, type PoseName } from './motion';

/**
 * The home page's shared state: how far each section has been scrolled through, which one the
 * reader is on, whether the page plays wide (pinned chapters, the companions travelling on their
 * own layer) or inline (narrow screens and reduced motion: everything in the flow, scenes shown
 * finished), and what Mochi and Pudding are doing. One rAF loop reads the sections' boxes and
 * writes only what changed.
 */

export type Who = 'mochi' | 'pudding';

/** What a companion holds in its right hand. */
export type Held = 'plug' | 'card' | 'phone' | 'tab' | 'receipt' | 'file' | 'mug';

export type MascotState = {
  pose: PoseName;
  /** A speech bubble over its head, or nothing. */
  say: string | null;
  held: Held | null;
  /** Facing left instead of right. */
  mirror: boolean;
  /** Off stage: faded out where it stands. */
  away: boolean;
};

const REST: MascotState = { pose: 'idle', say: null, held: null, mirror: false, away: false };

/** The width the page plays wide from; below it, and with reduced motion, it plays inline. */
export const WIDE_FROM = 1000;

type Section = { el: HTMLElement; mode: 'sticky' | 'flow' };

export class Stage {
  /** The page's words, in the reader's language; the page sets it as the language changes. */
  copy = $state.raw<HomeCopy>(HOME.zh);
  /** Progress through each registered section, 0 to 1. */
  progress = $state<Record<string, number>>({});
  /** The section the reader is on. */
  active = $state<string>('hero');
  wide = $state(false);
  reduced = $state(false);
  /** Pixels scrolled per second, signed; the companions lean against it. */
  velocity = $state(0);
  /** Each companion's state, written by the scene on screen (see `act`). */
  mascots = $state<Record<Who, MascotState>>({ mochi: { ...REST }, pudding: { ...REST, mirror: true } });
  /** A poke's line, shown for a moment over the one poked. */
  poked = $state.raw<{ who: Who; line: string; at: number } | null>(null);

  #sections = new Map<string, Section>();
  #raf = 0;

  #lastY = 0;
  #lastT = 0;

  register(id: string, el: HTMLElement, mode: 'sticky' | 'flow') {
    this.#sections.set(id, { el, mode });
    return () => {
      if (this.#sections.get(id)?.el === el) this.#sections.delete(id);
    };
  }

  /** The element a section was registered with, for its anchors and for jumping to it. */
  section(id: string): HTMLElement | null {
    return this.#sections.get(id)?.el ?? null;
  }

  /** Where `who` should stand: the `[data-stand]` anchor in the section the reader is on. */
  anchor(who: Who): HTMLElement | null {
    const el = this.section(this.active);
    return el?.querySelector<HTMLElement>(`[data-stand="${who}"]`) ?? null;
  }

  /** Set what a companion is doing; only the fields given change. */
  act(who: Who, next: Partial<MascotState>) {
    // Scenes call this from effects: reading the state here must not make them depend on it.
    untrack(() => {
      const cur = this.mascots[who];
      let changed = false;
      for (const k of Object.keys(next) as (keyof MascotState)[]) {
        if (cur[k] !== next[k]) changed = true;
      }
      if (changed) this.mascots[who] = { ...cur, ...next };
    });
  }

  /** Both companions back to standing still, as a chapter they were acting in is left. */
  rest() {
    this.mascots.mochi = { ...REST };
    this.mascots.pudding = { ...REST, mirror: true };
  }

  poke(who: Who, lines: string[]) {
    const prev = this.poked?.who === who ? this.poked.line : null;
    const pool = lines.filter((l) => l !== prev);
    const line = pool[Math.floor(Math.random() * pool.length)] ?? lines[0];
    const poked = { who, line, at: performance.now() };
    this.poked = poked;
    setTimeout(() => {
      if (this.poked === poked) this.poked = null;
    }, 2600);
  }

  /** The line over a companion's head: a poke's answer for a moment, else what the scene has it say. */
  bubble(who: Who): string | null {
    if (this.poked?.who === who) return this.poked.line;
    const m = this.mascots[who];
    return m.away ? null : m.say;
  }

  /** Start reading the page; returns the cleanup. */
  start(): () => void {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const widthQuery = matchMedia(`(min-width: ${WIDE_FROM}px)`);
    const readModes = () => {
      this.reduced = motion.matches;
      this.wide = widthQuery.matches && !motion.matches;
    };
    readModes();
    motion.addEventListener('change', readModes);
    widthQuery.addEventListener('change', readModes);

    this.#lastY = scrollY;
    this.#lastT = performance.now();
    const frame = (now: number) => {
      this.#raf = requestAnimationFrame(frame);
      this.#read(now);
    };
    const visibility = () => {
      cancelAnimationFrame(this.#raf);
      if (!document.hidden) {
        this.#lastT = performance.now();
        this.#raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', visibility);
    this.#raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(this.#raf);
      motion.removeEventListener('change', readModes);
      widthQuery.removeEventListener('change', readModes);
      document.removeEventListener('visibilitychange', visibility);
    };
  }

  #read(now: number) {
    const vh = innerHeight;
    const nav = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 60;
    const rects: { id: string; top: number; bottom: number }[] = [];
    for (const [id, s] of this.#sections) {
      const r = s.el.getBoundingClientRect();
      rects.push({ id, top: r.top, bottom: r.bottom });
      const p = this.reduced ? 1 : sectionProgress(r, vh, nav, this.wide ? s.mode : 'flow');
      const old = this.progress[id];
      if (old === undefined || Math.abs(old - p) > 0.0004 || (p !== old && (p === 0 || p === 1))) {
        this.progress[id] = p;
      }
    }
    const on = activeSection(rects, vh * 0.45);
    if (on && on !== this.active) this.active = on;

    const dt = Math.max(1, now - this.#lastT) / 1000;
    const v = (scrollY - this.#lastY) / dt;
    this.#lastY = scrollY;
    this.#lastT = now;
    const smooth = this.velocity + (v - this.velocity) * 0.25;
    if (Math.abs(smooth - this.velocity) > 2 || (smooth === 0) !== (this.velocity === 0)) {
      this.velocity = Math.abs(smooth) < 4 ? 0 : smooth;
    }
  }
}

const KEY = Symbol('home-stage');

export function provideStage(stage: Stage) {
  setContext(KEY, stage);
}

export function useStage(): Stage {
  return getContext<Stage>(KEY);
}
