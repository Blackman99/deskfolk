<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { MASCOT_GEOMETRY } from '../mascot-assets';
  import { lerp, type PoseName } from '../motion';
  import { createRope, ropePath, setRopeLength, staticCable, stepRope, type Rope, type Vec } from '../rope';
  import type { SceneProps } from '../scene';
  import { useStage } from '../stage.svelte';
  import Stand from '../Stand.svelte';
  import Board from './models/Board.svelte';
  import { ALL_IDS, EXAMPLE_URL, NAMES, autoState, isAgent, parseEndpoint, type Auto, type SocketId } from './models/beats';
  import Ladder from './models/Ladder.svelte';

  /**
   * "Plug the cable": Pudding holds a cable whose plug you drag into a socket on the board (a local
   * agent you are signed in to, or an endpoint), and a verlet rope follows the plug. From `p` the
   * plug visits sockets on its own until the reader touches anything; the sockets are also one
   * radiogroup, so a click or Enter flies the plug there. Reduced motion shows the finished state.
   */

  let { copy, p, active, lang }: SceneProps<'models'> = $props();
  const stage = useStage();
  const names = $derived(NAMES[lang]);

  const HAND = MASCOT_GEOMETRY.pudding.handR;
  const GRAVITY = 2400;
  const SNAP = 40;

  // What the reader sees.
  let plugId = $state<SocketId | null>(null);
  let connected = $state<SocketId | null>(null);
  let host = $state('');
  let editing = $state(false);
  let url = $state('');
  let kind = $state<0 | 1>(0);
  let error = $state('');
  let rung = $state(0);
  let pinned = $state(false);
  let user = $state(false);
  let dragging = $state(false);
  let ready = $state(false);
  let pPose = $state<PoseName>('idle');
  let pSay = $state<string | null>(null);

  let root: HTMLElement | undefined = $state();
  let spot: HTMLElement | undefined = $state();
  let cable: SVGPathElement | undefined = $state();
  let plug: HTMLElement | undefined = $state();
  let board: Board | undefined = $state();

  // Per-frame state lives in plain variables: nothing here needs to re-render the page.
  type Flight = { from: Vec; id: SocketId | null; t0: number; dur: number };
  let mode: 'dangle' | 'drag' | 'fly' | 'plugged' = 'dangle';
  let pos: Vec | null = null;
  let flight: Flight | null = null;
  let rope: Rope | null = null;
  let angle = 0;
  let grab: Vec = { x: 0, y: 0 };
  let looping = false;
  let focusPending = false;
  let poseTimer: ReturnType<typeof setTimeout> | undefined;

  const pudSize = $derived(stage.wide ? 104 : 88);
  const mocSize = $derived(stage.wide ? 92 : 76);
  const formOpen = $derived(plugId === 'custom' && (connected !== 'custom' || editing));
  const connectedName = $derived(
    connected === null ? null : connected === 'custom' ? host || copy.custom : names[connected]
  );

  function touch() {
    user = true;
  }

  /** Pudding takes a pose for a moment, then goes back to work. */
  function beat(pose: PoseName, ms: number) {
    pPose = pose;
    clearTimeout(poseTimer);
    poseTimer = setTimeout(() => (pPose = 'work'), ms);
  }

  function connect(id: SocketId) {
    connected = id;
    pSay = isAgent(id) ? copy.runsOn(names[id]) : copy.endpoint(id === 'custom' ? host : names[id]);
    beat('cheer', 1200);
  }

  function submitCustom() {
    const r = parseEndpoint(url);
    if (!r) {
      error = copy.customInvalid;
      return;
    }
    error = '';
    host = r.host;
    editing = false;
    connect('custom');
  }

  function stuck() {
    touch();
    if (rung < copy.rungs.length - 1) rung += 1;
    beat('think', 1000);
  }

  // --- Geometry: everything is measured against the scene's root, each time it is needed.

  function holeAt(id: SocketId): Vec | null {
    const el = root?.querySelector(`[data-hole="${id}"]`);
    if (!el || !root) return null;
    const r = el.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    return { x: r.left - o.left + r.width / 2, y: r.top - o.top + r.height / 2 };
  }

  function layout() {
    if (!root || !spot) return null;
    const o = root.getBoundingClientRect();
    const s = spot.getBoundingClientRect();
    const left = s.left - o.left;
    const top = s.top - o.top;
    return {
      width: o.width,
      height: o.height,
      hand: { x: left + s.width * HAND[0], y: top + s.height * HAND[1] },
      // Dropped, the plug lies on the ground just beside Pudding, clear of its body.
      rest: { x: left + s.width + 22, y: top + s.height - 9 },
      ground: top + s.height
    };
  }

  // --- The plug's movements.

  function flyTo(id: SocketId | null, dur: number) {
    plugId = id;
    connected = null;
    if (id !== 'custom') editing = false;
    if (id === null) {
      pPose = 'idle';
      pSay = null;
    }
    const from = pos ?? layout()?.rest ?? { x: 0, y: 0 };
    flight = { from: { ...from }, id, t0: performance.now(), dur: stage.reduced ? 0 : dur };
    mode = 'fly';
    if (flight.dur === 0) finish();
  }

  function finish() {
    const id = flight?.id ?? null;
    flight = null;
    mode = id ? 'plugged' : 'dangle';
    const here = id ? holeAt(id) : (layout()?.rest ?? null);
    if (here) pos = here;
    if (id) arrive(id);
    if (!looping) tick().then(() => draw(0, false));
  }

  function arrive(id: SocketId) {
    if (id !== 'custom') return connect(id);
    if (!user) applyAuto(autoState(p));
    else if (focusPending) tick().then(() => board?.focusInput());
    focusPending = false;
  }

  /** A click or Enter on a socket: the plug flies there. */
  function pick(id: SocketId) {
    touch();
    if (id === 'custom') {
      if (connected === 'custom') {
        editing = true;
        tick().then(() => board?.focusInput());
        return;
      }
      focusPending = true;
    } else if (connected === id) return;
    flyTo(id, 520);
  }

  function nearestHole(at: Vec): SocketId | null {
    let best: SocketId | null = null;
    let gap = SNAP;
    for (const id of ALL_IDS) {
      const h = holeAt(id);
      const d = h ? Math.hypot(h.x - at.x, h.y - at.y) : Infinity;
      if (d <= gap) {
        gap = d;
        best = id;
      }
    }
    return best;
  }

  function local(e: PointerEvent): Vec | null {
    if (!root) return null;
    const o = root.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - o.left, 0), o.width),
      y: Math.min(Math.max(e.clientY - o.top, 0), o.height)
    };
  }

  function dragStart(e: PointerEvent) {
    const at = local(e);
    if (!at || !pos) return;
    e.preventDefault();
    touch();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    grab = { x: pos.x - at.x, y: pos.y - at.y };
    flight = null;
    mode = 'drag';
    dragging = true;
    plugId = null;
    connected = null;
    editing = false;
    pPose = 'idle';
    pSay = null;
  }

  function dragMove(e: PointerEvent) {
    if (mode !== 'drag') return;
    const at = local(e);
    if (at) pos = { x: at.x + grab.x, y: at.y + grab.y };
    if (!looping) draw(0, false);
  }

  function dragEnd() {
    if (mode !== 'drag' || !pos) return;
    dragging = false;
    const near = nearestHole(pos);
    flyTo(near, near ? 240 : 520);
  }

  // --- The script: from `p` until the reader touches something.

  function applyAuto(st: Auto) {
    if (st.target !== plugId) flyTo(st.target, 700);
    if (st.target === 'custom') {
      url = EXAMPLE_URL.slice(0, st.typed);
      if (st.submit && connected !== 'custom' && mode === 'plugged') submitCustom();
      else if (!st.submit && connected === 'custom') {
        connected = null;
        editing = false;
      }
    } else {
      url = '';
      error = '';
    }
    if (st.rung !== rung) {
      const up = st.rung > rung;
      rung = st.rung;
      if (up) beat('think', 1000);
    }
  }

  $effect(() => {
    if (!(active || stage.reduced) || user) return;
    const st = autoState(p);
    untrack(() => applyAuto(st));
  });

  // Leaving the chapter hands the scene back to the script and stops its timers.
  $effect(() => {
    if (!active) return;
    return () => {
      user = false;
      clearTimeout(poseTimer);
    };
  });

  $effect(() => {
    if (!active) return;
    stage.act('mochi', { pose: 'point', say: null, held: null, away: false, mirror: true });
  });

  $effect(() => {
    if (!active) return;
    stage.act('pudding', { pose: pPose, say: pSay ?? copy.dragHint, held: null, away: false, mirror: false });
  });

  // --- Drawing.

  /** Put the plug and the cable where they belong; with `simulate`, run the rope on by `dt`. */
  function draw(dt: number, simulate: boolean, now = performance.now()) {
    const l = layout();
    if (!l || !cable || !plug) return;
    if (!pos) pos = { ...l.rest };

    if (mode === 'fly' && flight) {
      const to = (flight.id && holeAt(flight.id)) || (flight.id ? pos : l.rest);
      const k = flight.dur <= 0 ? 1 : (now - flight.t0) / flight.dur;
      if (k >= 1) {
        finish();
        return;
      }
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const lift = Math.min(80, Math.hypot(to.x - flight.from.x, to.y - flight.from.y) * 0.3);
      pos = { x: lerp(flight.from.x, to.x, e), y: lerp(flight.from.y, to.y, e) - 4 * lift * k * (1 - k) };
    } else if (mode === 'plugged' && plugId) {
      pos = holeAt(plugId) ?? pos;
    } else if (mode === 'dangle') {
      pos = { ...l.rest };
    }

    const end = pos;
    let facing = angle;
    if (simulate) {
      const len = Math.hypot(end.x - l.hand.x, end.y - l.hand.y) * 1.12 + 30;
      if (!rope) {
        rope = createRope(l.hand, end, 18, len);
        for (let i = 0; i < 40; i++) stepRope(rope, 1 / 60, GRAVITY, 18, { a: l.hand, b: end }, l.ground);
      }
      setRopeLength(rope, len);
      stepRope(rope, dt, GRAVITY, 18, { a: l.hand, b: end }, l.ground);
      cable.setAttribute('d', ropePath(rope));
      const a = rope.pts[rope.pts.length - 2];
      facing = Math.atan2(end.y - a.y, end.x - a.x);
    } else {
      const c = staticCable(l.hand, end);
      cable.setAttribute('d', c.d);
      facing = c.angle;
      rope = null;
    }
    let d = facing - angle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    angle = simulate ? angle + d * 0.35 : facing;
    plug.style.transform = `translate(${end.x.toFixed(1)}px, ${end.y.toFixed(1)}px) rotate(${angle.toFixed(3)}rad)`;
  }

  // The loop runs only while the reader is on the chapter and motion is allowed.
  $effect(() => {
    if (!active || stage.reduced) return;
    let raf = 0;
    let last = 0;
    looping = true;
    const frame = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      draw(dt, true, now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      looping = false;
    };
  });

  // Otherwise the picture is redrawn when something it depends on changes.
  $effect(() => {
    void [plugId, connected, formOpen, stage.reduced, stage.wide, lang];
    tick().then(() => {
      if (!looping) draw(0, false);
    });
  });

  onMount(() => {
    draw(0, false);
    ready = true;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      if (!looping) draw(0, false);
    });
    ro.observe(root);
    return () => {
      ro.disconnect();
      clearTimeout(poseTimer);
    };
  });
</script>

<div
  class="models"
  class:is-wide={stage.wide}
  class:is-dragging={dragging}
  bind:this={root}
  onpointerdowncapture={touch}
  onkeydowncapture={touch}
>
  <Board
    bind:this={board}
    {copy}
    {names}
    connectedText={copy.connected}
    {plugId}
    {connected}
    {host}
    {formOpen}
    bind:url
    bind:kind
    {error}
    onpick={pick}
    onsubmit={submitCustom}
  />

  <div class="bottom">
    <div class="pud" bind:this={spot}><Stand who="pudding" size={pudSize} /></div>
    <div class="lad"><Ladder {copy} {rung} name={connectedName} bind:pinned onstuck={stuck} /></div>
    <div class="moc"><Stand who="mochi" size={mocSize} /></div>
  </div>

  <svg class="cable" class:is-on={connected !== null} class:is-ready={ready} aria-hidden="true">
    <path bind:this={cable} d="" />
  </svg>
  <div
    class="plug"
    class:is-on={connected !== null}
    class:is-drag={dragging}
    class:is-ready={ready}
    bind:this={plug}
    aria-hidden="true"
    onpointerdown={dragStart}
    onpointermove={dragMove}
    onpointerup={dragEnd}
    onpointercancel={dragEnd}
  >
    <i></i>
  </div>
</div>

<style>
  .models {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .models.is-wide {
    height: 100%;
  }

  /* Pudding, the ladder and Mochi: in a row when there is room, else Pudding and Mochi over the ladder. */
  .bottom {
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas:
      'pud . moc'
      'lad lad lad';
    align-items: end;
    gap: 10px 10px;
    margin-top: auto;
    /* Room for Pudding's speech bubble above its head. */
    padding: 48px 4px 0;
  }

  .pud {
    grid-area: pud;
    position: relative;
    z-index: 5;
    margin: 0 26px 0 56px;
  }

  .moc {
    grid-area: moc;
  }

  .lad {
    grid-area: lad;
    position: relative;
    z-index: 4;
  }

  .is-dragging {
    -webkit-user-select: none;
    user-select: none;
  }

  @container (min-width: 520px) {
    .bottom {
      grid-template-areas: 'pud lad moc';
      gap: 10px;
    }

    .pud {
      margin: 0 38px 0 52px;
    }

    .lad {
      max-width: 280px;
      justify-self: center;
      width: 100%;
      margin-bottom: 6px;
    }
  }

  .cable {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    opacity: 0;
    z-index: 3;
    transition: opacity 0.3s;
  }

  .cable.is-ready,
  .plug.is-ready {
    opacity: 1;
  }

  .cable path {
    fill: none;
    stroke: var(--ink-2);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: stroke 0.25s;
  }

  .cable.is-on path {
    stroke: var(--teal);
  }

  /* The plug head: a small dark block with two prongs at its front, centred on its position. */
  .plug {
    position: absolute;
    left: -12px;
    top: -8px;
    width: 24px;
    height: 16px;
    z-index: 4;
    opacity: 0;
    cursor: grab;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    will-change: transform;
  }

  .plug.is-drag {
    cursor: grabbing;
  }

  .plug i {
    position: absolute;
    inset: 0;
    border-radius: 5px;
    background: var(--ink);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    transition: background-color 0.25s;
  }

  .plug i::before {
    content: '';
    position: absolute;
    right: -6px;
    top: 3px;
    width: 8px;
    height: 10px;
    border-radius: 2px;
    background: var(--ink-3);
    clip-path: polygon(0 0, 100% 22%, 100% 78%, 0 100%);
  }

  .plug.is-on i {
    background: var(--teal);
  }

  .plug.is-on i::before {
    background: var(--teal-2);
  }

  .plug.is-drag i {
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3);
  }

  @media (prefers-reduced-motion: reduce) {
    .cable,
    .cable path,
    .plug i {
      transition: none;
    }
  }
</style>
