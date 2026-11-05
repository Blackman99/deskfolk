<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { SceneCopy } from './copy';
  import { isTap, panelPlacement, restAt, TOP_CLEAR } from './dock';
  import { spring } from './motion';

  /**
   * The usage widget, the page's own copy of the app's: a round ball that shows plan usage, starts
   * at the top right, can be dragged anywhere and stays where it is let go; let go at the left or
   * right edge it sticks there half tucked away and slides out under the pointer. A click opens a
   * small panel. Fixed to the window, so it stays put while the page scrolls. The numbers are samples.
   */
  let { copy, shown }: { copy: SceneCopy['spend']['usage']; shown: boolean } = $props();

  const PERCENT = 38;
  const MARGIN = 16;
  const RING = 2 * Math.PI * 23;
  /** Plan limits exist only for these; an API-key endpoint has none. */
  const PLANS = $derived([
    { key: 'five', label: `Claude · ${copy.windows.fiveHour}`, pct: 38, reset: true },
    { key: 'week', label: `Claude · ${copy.windows.week}`, pct: 61, reset: false },
    { key: 'codex', label: 'Codex', pct: 22, reset: false },
    { key: 'grok', label: 'Grok', pct: 9, reset: false },
    { key: 'anti', label: 'Antigravity', pct: 47, reset: false }
  ]);

  let wrap: HTMLElement | undefined = $state();
  let btn: HTMLButtonElement | undefined = $state();
  let open = $state(false);
  let hint = $state(false);
  let popped = $state(false);
  let side = $state<'left' | 'right' | null>(null);
  let place = $state<{ h: 'right' | 'left'; v: 'down' | 'up' }>({ h: 'left', v: 'down' });
  let dragging = $state(false);
  let reduced = $state(false);

  // The reset time is fixed when the page loads: now plus 2 h 14 min.
  const resetAt = Date.now() + (2 * 60 + 14) * 60_000;
  let now = $state(Date.now());
  const left = $derived(Math.max(0, Math.ceil((resetAt - now) / 60_000)));
  const wait = $derived(copy.resetsIn(copy.hoursMinutes(Math.floor(left / 60), left % 60)));

  // Where the ball is, in window pixels from its top-left; written straight to the element.
  let x = 0;
  let y = 0;
  let raf = 0;
  let placed = false;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  const size = () => wrap?.offsetWidth || 56;
  const viewport = () => ({ width: document.documentElement.clientWidth, height: innerHeight });

  function paint() {
    if (wrap) wrap.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function settle() {
    place = panelPlacement({ x, y, size: size() }, viewport());
  }

  /** Spring the ball to where it comes to rest (or jump there with reduced motion). */
  function dock(animate = true) {
    cancelAnimationFrame(raf);
    const t = restAt({ x, y, size: size() }, viewport(), MARGIN);
    side = t.side;
    if (!animate || reduced) {
      x = t.x;
      y = t.y;
      paint();
      settle();
      return;
    }
    let vx = 0;
    let vy = 0;
    let last = performance.now();
    const frame = (time: number) => {
      const dt = (time - last) / 1000;
      last = time;
      const sx = spring(x, vx, t.x, dt);
      const sy = spring(y, vy, t.y, dt);
      x = sx.value;
      vx = sx.velocity;
      y = sy.value;
      vy = sy.velocity;
      if (Math.abs(t.x - x) < 0.4 && Math.abs(t.y - y) < 0.4 && Math.abs(vx) < 4 && Math.abs(vy) < 4) {
        x = t.x;
        y = t.y;
        paint();
        settle();
        return;
      }
      paint();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  // The first time it is shown: pop in at the top right, as in the app, with a hint for a few seconds.
  $effect(() => {
    if (!shown || placed || !wrap) return;
    placed = true;
    const vp = viewport();
    x = vp.width - size() - MARGIN;
    y = TOP_CLEAR + 8;
    paint();
    settle();
    popped = true;
    hint = true;
    hintTimer = setTimeout(() => (hint = false), 4000);
  });

  onMount(() => {
    reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resize = () => {
      if (!placed || dragging) return;
      dock(false);
    };
    addEventListener('resize', resize);
    return () => {
      removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
      clearTimeout(hintTimer);
    };
  });

  // While the panel is open the countdown follows the clock, every 30 s.
  $effect(() => {
    if (!open) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  // Escape or a press elsewhere closes the panel; focus goes back to the ball.
  $effect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const press = (e: PointerEvent) => {
      if (wrap && !wrap.contains(e.target as Node)) close(false);
    };
    addEventListener('keydown', key);
    addEventListener('pointerdown', press);
    return () => {
      removeEventListener('keydown', key);
      removeEventListener('pointerdown', press);
    };
  });

  function close(refocus: boolean) {
    open = false;
    if (refocus) tick().then(() => btn?.focus());
  }

  // Dragging: Pointer Events with capture; under 4 px of travel the press is a click.
  let drag: { id: number; px: number; py: number; bx: number; by: number } | null = null;
  let suppressClick = false;

  function down(e: PointerEvent) {
    if (e.button !== 0 || !btn) return;
    cancelAnimationFrame(raf);
    btn.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, px: e.clientX, py: e.clientY, bx: x, by: y };
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    if (!dragging) {
      if (isTap(dx, dy)) return;
      dragging = true;
      open = false;
      hint = false;
    }
    const vp = viewport();
    x = Math.min(Math.max(0, drag.bx + dx), vp.width - size());
    y = Math.min(Math.max(0, drag.by + dy), vp.height - size());
    paint();
  }

  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = dragging;
    drag = null;
    if (moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      dragging = false;
      dock();
    }
  }

  function click() {
    if (suppressClick) return;
    hint = false;
    open = !open;
  }

  // Keyboard: arrows move the ball to a side or up and down.
  function keydown(e: KeyboardEvent) {
    const step = 48;
    if (e.key === 'ArrowLeft') x = side === 'right' ? viewport().width / 2 : 0;
    else if (e.key === 'ArrowRight') x = side === 'left' ? viewport().width / 2 : viewport().width;
    else if (e.key === 'ArrowUp') y -= step;
    else if (e.key === 'ArrowDown') y += step;
    else return;
    e.preventDefault();
    dock();
  }
</script>

{#if shown}
  <div
    class="wrap"
    class:pop={popped && !reduced}
    class:dragging
    class:left={side === 'left' || (side === null && place.h === 'right')}
    class:tucked-left={side === 'left' && !open && !dragging}
    class:tucked-right={side === 'right' && !open && !dragging}
    bind:this={wrap}
  >
    <button
      type="button"
      class="ball"
      bind:this={btn}
      aria-label="{copy.widget}: {copy.used(`${PERCENT}%`)}"
      aria-expanded={open}
      aria-controls="usage-panel"
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onclick={click}
      onkeydown={keydown}
    >
      <svg viewBox="0 0 56 56" aria-hidden="true">
        <circle class="track" cx="28" cy="28" r="23" />
        <circle
          class="gauge"
          cx="28"
          cy="28"
          r="23"
          stroke-dasharray="{(RING * PERCENT) / 100} {RING}"
          transform="rotate(-90 28 28)"
        />
      </svg>
      <span class="pct" aria-hidden="true">{PERCENT}%</span>
    </button>

    {#if hint && !open}
      <div class="hint" role="status">{copy.dragHint}</div>
    {/if}

    {#if open}
      <div
        id="usage-panel"
        class="panel"
        class:to-left={place.h === 'left'}
        class:to-up={place.v === 'up'}
        role="dialog"
        aria-label={copy.title}
      >
        <div class="head">
          <strong>{copy.title}</strong>
          <button type="button" class="x" onclick={() => close(true)} aria-label={copy.close}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
          </button>
        </div>
        <ul>
          {#each PLANS as row (row.key)}
            <li>
              <div class="line">
                <span class="name">{row.label}</span>
                <span class="used">{copy.used(`${row.pct}%`)}</span>
              </div>
              <div class="bar" aria-hidden="true"><i style:width="{row.pct}%"></i></div>
              {#if row.reset}<div class="reset">{wait}</div>{/if}
            </li>
          {/each}
          <li class="api">
            <div class="line"><span class="name">{copy.apiKey}</span></div>
            <div class="reset">{copy.noPlan}</div>
          </li>
        </ul>
      </div>
    {/if}
  </div>
{/if}

<style>
  .wrap {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 17;
    width: 56px;
    height: 56px;
    will-change: transform;
    transition: translate 200ms ease;
  }

  /* Stuck to a side, half of it is out of sight; under the pointer or focused it slides out. */
  .tucked-left:hover,
  .tucked-left:focus-within {
    translate: 50% 0;
  }

  .tucked-right:hover,
  .tucked-right:focus-within {
    translate: -50% 0;
  }

  .ball {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: var(--paper);
    box-shadow: var(--shadow-float);
    color: var(--ink);
    cursor: grab;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .dragging .ball {
    cursor: grabbing;
  }

  .ball:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .ball svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .track,
  .gauge {
    fill: none;
    stroke-width: 4;
  }

  .track {
    stroke: var(--line);
  }

  .gauge {
    stroke: var(--teal);
    stroke-linecap: round;
  }

  .pct {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font: 600 12px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .pop .ball {
    animation: pop 0.5s cubic-bezier(0.2, 1.5, 0.4, 1) both;
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.5);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .hint {
    position: absolute;
    top: 50%;
    right: calc(100% + 10px);
    width: max-content;
    max-width: 200px;
    padding: 7px 11px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--paper);
    box-shadow: var(--shadow-float);
    color: var(--ink);
    font-size: 12.5px;
    line-height: 1.4;
    transform: translateY(-50%);
    pointer-events: none;
    animation: fade 0.3s ease-out both;
  }

  .left .hint {
    right: auto;
    left: calc(100% + 10px);
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  .panel {
    position: absolute;
    top: calc(100% + 10px);
    left: 0;
    width: 252px;
    padding: 12px 14px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--paper);
    box-shadow: var(--shadow-float);
    color: var(--ink);
    animation: fade 0.18s ease-out both;
  }

  .panel.to-left {
    left: auto;
    right: 0;
  }

  .panel.to-up {
    top: auto;
    bottom: calc(100% + 10px);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 13px;
  }

  .x {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }

  .x:hover {
    background: var(--ground-2);
  }

  .x:focus-visible {
    outline: 2px solid var(--teal);
  }

  .x svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  ul {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .line {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
  }

  .used {
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }

  .bar {
    height: 4px;
    margin-top: 4px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--line-2);
  }

  .bar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--teal);
  }

  .reset {
    margin-top: 3px;
    color: var(--ink-3);
    font-size: 11px;
  }

  .api {
    padding-top: 8px;
    border-top: 1px dashed var(--line);
  }

  /* Phones get no widget in the app either (its usage is a page of its own there). */
  @media (max-width: 699px) {
    .wrap {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pop .ball,
    .hint,
    .panel {
      animation: none;
    }
  }
</style>
