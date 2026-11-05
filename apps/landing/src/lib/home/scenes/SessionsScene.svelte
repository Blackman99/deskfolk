<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { SceneProps } from '../scene';
  import { useStage } from '../stage.svelte';
  import Stand from '../Stand.svelte';
  import { clamp, lerp, span } from '../motion';
  import Terminal from './sessions/Terminal.svelte';
  import Fork from './sessions/Fork.svelte';
  import {
    MARK,
    NEXT_AT,
    beats,
    beside,
    cardAt,
    foldTranscript,
    forkPath,
    itemShown,
    typedPerLine,
    type Rect
  } from './sessions/logic';


  let { copy, p, active, lang }: SceneProps<'sessions'> = $props();
  const stage = useStage();

  /**
   * "Drag the session in": a terminal that types out a Claude Code session, the Deskfolk window
   * offering to import it, the session card flying into the sidebar and the window turning into the
   * conversation, with a fork drawn from the terminal's last line. The scroll position plays it
   * (`p`); the reader can take over by dragging the card onto the sidebar or pressing the button,
   * and then it plays from their own progress until the chapter is left or Replay is pressed.
   */

  type Geom = {
    w: number;
    h: number;
    side: boolean;
    card: Rect;
    slot: Rect;
    aside: Rect;
    term: Rect;
    last: Rect;
    app: Rect;
    mochi: Rect;
    pudding: Rect;
  };

  let mode = $state<'auto' | 'user'>('auto');
  let uep = $state(0);
  /** The conversation is on screen at once (set when the reader imports it themselves). */
  let snap = $state(false);
  let drag = $state<{ dx: number; dy: number } | null>(null);
  let dragging = $state(false);
  let over = $state(false);
  let busy = $state(false);
  let geom = $state.raw<Geom | null>(null);

  let root: HTMLElement | undefined = $state();
  let termEl: HTMLElement | undefined = $state();
  let lineEls: HTMLElement[] = $state([]);
  let appEl: HTMLElement | undefined = $state();
  let asideEl: HTMLElement | undefined = $state();
  let slotEl: HTMLElement | undefined = $state();
  let cardEl: HTMLElement | undefined = $state();
  let mochiHome: HTMLElement | undefined = $state();
  let puddingHome: HTMLElement | undefined = $state();
  let chatEl: HTMLElement | undefined = $state();

  const ep = $derived(mode === 'user' ? uep : p);
  const b = $derived(beats(ep));
  const items = $derived(foldTranscript(copy.transcript));
  const typedLines = $derived(typedPerLine(copy.transcript, b.typed));
  const project = $derived(copy.sessionMeta.split(' · ')[0].replace(/^~\//, ''));
  const landed = $derived(b.fly >= 1 || snap);
  const size = $derived(geom?.side === false ? 80 : 96);
  const grabbable = $derived(b.sheet > 0.6 && b.fly === 0 && !busy && !snap);
  const sheetOpacity = $derived(snap ? 0 : b.sheet * (1 - b.sheetOut));
  const nextShown = $derived(NEXT_AT.map((a) => span(ep, a, a + 0.04)));

  const shown = (i: number) => (snap && i < items.length ? 1 : itemShown(ep, i));

  /** Where things are, relative to the scene's own box. */
  function measure() {
    if (!root || !termEl || !appEl || !asideEl || !slotEl || !cardEl || !mochiHome || !puddingHome) return;
    const r = root.getBoundingClientRect();
    const rel = (el: Element): Rect => {
      const q = el.getBoundingClientRect();
      return { x: q.left - r.left, y: q.top - r.top, w: q.width, h: q.height };
    };
    const lastLine = lineEls[lineEls.length - 1];
    geom = {
      w: r.width,
      h: r.height,
      side: r.width >= 560,
      card: rel(cardEl),
      slot: rel(slotEl),
      aside: rel(asideEl),
      term: rel(termEl),
      last: lastLine ? rel(lastLine) : rel(termEl),
      app: rel(appEl),
      mochi: rel(mochiHome),
      pudding: rel(puddingHome)
    };
  }

  onMount(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (root) ro.observe(root);
    document.fonts?.ready.then(measure);
    return () => {
      ro.disconnect();
      gen++;
    };
  });

  $effect(() => {
    void copy;
    void stage.wide;
    void lang;
    tick().then(measure);
  });

  // ---- the reader taking over ------------------------------------------------------------

  /** Bumped to cancel whatever the reader's own play is in the middle of. */
  let gen = 0;

  function tween(from: number, to: number, ms: number, set: (v: number) => void): Promise<boolean> {
    const mine = gen;
    return new Promise((done) => {
      const t0 = performance.now();
      const step = (now: number) => {
        if (mine !== gen) return done(false);
        const k = clamp((now - t0) / ms);
        set(lerp(from, to, k * k * (3 - 2 * k)));
        if (k < 1) requestAnimationFrame(step);
        else done(true);
      };
      requestAnimationFrame(step);
    });
  }

  function takeOver() {
    if (mode === 'user') return;
    uep = p < MARK.sheet ? MARK.sheet : Math.min(p, MARK.fly);
    mode = 'user';
  }

  /** The conversation replaces the sheet, each terminal line turning into its chat bubble. */
  async function swap() {
    const mine = gen;
    const pairs = () =>
      items.map((it, i) => ({ term: lineEls[it.src], bubble: chatEl?.querySelector<HTMLElement>(`[data-item="${i}"]`) }));
    const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => { finished: Promise<unknown> } };
    if (!doc.startViewTransition) {
      const from = items.map((it) => lineEls[it.src]?.getBoundingClientRect());
      snap = true;
      await tick();
      pairs().forEach(({ bubble }, i) => {
        const a = from[i];
        const z = bubble?.getBoundingClientRect();
        if (!a || !z || !bubble) return;
        bubble.animate(
          [
            { transform: `translate(${a.left - z.left}px, ${a.top - z.top}px) scale(0.96)`, opacity: 0.2 },
            { transform: 'none', opacity: 1 }
          ],
          { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' }
        );
      });
      return;
    }
    const html = document.documentElement;
    html.classList.add('sess-vt');
    pairs().forEach(({ term }, i) => term && (term.style.viewTransitionName = `sess-${i}`));
    const vt = doc.startViewTransition(async () => {
      if (mine === gen) snap = true;
      await tick();
      pairs().forEach(({ term, bubble }, i) => {
        if (term) term.style.viewTransitionName = '';
        if (bubble) bubble.style.viewTransitionName = `sess-${i}`;
      });
    });
    try {
      await vt.finished;
    } catch {
      // A skipped transition still leaves the conversation in place.
    }
    html.classList.remove('sess-vt');
    pairs().forEach(({ term, bubble }) => {
      if (term) term.style.viewTransitionName = '';
      if (bubble) bubble.style.viewTransitionName = '';
    });
  }

  async function carryOn() {
    if (busy || snap) return;
    busy = true;
    takeOver();
    const mine = gen;
    if (stage.reduced) {
      snap = true;
      uep = 1;
      drag = null;
      busy = false;
      return;
    }
    const ok = await tween(uep, MARK.fly, 140 + 460 * (1 - (uep - MARK.sheet) / (MARK.fly - MARK.sheet)), (v) => (uep = v));
    if (!ok || mine !== gen) return;
    await swap();
    drag = null;
    if (mine !== gen) return;
    await tween(uep, 1, 1100, (v) => (uep = v));
    if (mine === gen) busy = false;
  }

  /** Back to the scroll playing the scene (or, with reduced motion, to the sheet waiting to be imported). */
  function reset() {
    gen++;
    busy = false;
    snap = false;
    drag = null;
    dragging = false;
    over = false;
    if (stage.reduced) {
      uep = MARK.sheet;
      mode = 'user';
    } else mode = 'auto';
  }

  $effect(() => {
    if (active) return;
    untrack(() => {
      if (mode === 'user' && !stage.reduced) reset();
    });
  });

  let grab: { x: number; y: number; id: number } | null = null;

  function inDrop(x: number, y: number) {
    if (!asideEl) return false;
    const a = asideEl.getBoundingClientRect();
    const pad = 28;
    return x >= a.left - pad && x <= a.right + pad && y >= a.top - pad && y <= a.bottom + pad;
  }

  function down(e: PointerEvent) {
    if (!grabbable || e.button > 0) return;
    grab = { x: e.clientX, y: e.clientY, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!grab || e.pointerId !== grab.id) return;
    const dx = e.clientX - grab.x;
    const dy = e.clientY - grab.y;
    if (!dragging && Math.hypot(dx, dy) < 4) return;
    if (!dragging) {
      takeOver();
      dragging = true;
    }
    drag = { dx, dy };
    over = inDrop(e.clientX, e.clientY);
  }

  function up(e: PointerEvent) {
    if (!grab || e.pointerId !== grab.id) return;
    grab = null;
    const wasDragging = dragging;
    dragging = false;
    const dropped = wasDragging && inDrop(e.clientX, e.clientY);
    over = false;
    if (dropped) carryOn();
    else if (drag) {
      const from = drag;
      tween(1, 0, 220, (k) => (drag = { dx: from.dx * k, dy: from.dy * k })).then((ok) => ok && (drag = null));
    }
  }

  // ---- the two companions ---------------------------------------------------------------

  /** Mochi's spot: at its place, then walking beside the card, then home again. */
  const mochiAt = $derived.by(() => {
    const g = geom;
    if (!g) return { x: 0, y: 0 };
    const home = { x: g.mochi.x, y: g.mochi.y };
    const carry = beside(cardAt(g.card, g.slot, b.fly), size);
    if (ep > MARK.fly) {
      const end = beside(cardAt(g.card, g.slot, 1), size);
      const back = span(ep, 0.66, 0.82);
      return { x: lerp(end.x, home.x, back), y: lerp(end.y, home.y, back) };
    }
    const out = span(ep, 0.4, 0.46);
    return { x: lerp(home.x, carry.x, out), y: lerp(home.y, carry.y, out) };
  });

  $effect(() => {
    if (!active) return;
    const e = ep;
    const mochi =
      e < 0.4
        ? { pose: 'point' as const, held: null, mirror: false }
        : e < 0.46
          ? { pose: 'walk' as const, held: null, mirror: false }
          : e < 0.65
            ? { pose: 'carry' as const, held: 'card' as const, mirror: true }
            : e < 0.82
              ? { pose: 'walk' as const, held: null, mirror: true }
              : { pose: 'idle' as const, held: null, mirror: false };
    stage.act('mochi', { ...mochi, say: null, away: false });
    stage.act('pudding', {
      pose: e < 0.65 ? 'look' : 'work',
      say: e >= 0.88 ? copy.next.claude : null,
      held: null,
      mirror: true,
      away: false
    });
  });

  const forkEnds = $derived.by(() => {
    const g = geom;
    if (!g) return null;
    return g.side
      ? { s: { x: g.term.x + g.term.w, y: g.last.y + g.last.h / 2 }, t: { x: g.app.x, y: g.slot.y + g.slot.h / 2 } }
      : { s: { x: g.term.x + 36, y: g.term.y + g.term.h }, t: { x: g.app.x + 36, y: g.app.y } };
  });
  const fork = $derived(forkEnds ? forkPath(forkEnds.s, forkEnds.t) : null);

  const card = $derived(geom ? cardAt(geom.card, geom.slot, b.fly) : null);
  const cardPos = $derived(
    card && {
      x: card.x + (drag ? drag.dx * (1 - b.fly) : 0),
      y: card.y + (drag ? drag.dy * (1 - b.fly) : 0)
    }
  );
</script>

<div class="sess" class:fill={stage.wide} bind:this={root} style:--spot="{size}px">
  <div class="wins">
    <div class="left">
      <Terminal
        title={copy.terminalTitle}
        lines={copy.transcript}
        shown={typedLines}
        typing={b.typed > 0 && b.typed < 1}
        kept={copy.kept}
        badge={span(ep, 0.62, 0.7)}
        bind:el={termEl}
        bind:lineEls
      />
    </div>

    <div class="app" bind:this={appEl}>
      <div class="tb">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="ttl">{copy.appTitle}</span>
        {#if mode === 'user' || stage.reduced}
          <button class="replay" type="button" aria-label={copy.replayLabel} onclick={reset}>
            <svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true"
              ><path d="M2.5 7a4.5 4.5 0 1 0 1.4-3.2M2.2 1.6v2.4h2.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg
            >
            {copy.replay}
          </button>
        {/if}
      </div>
      <div class="cols">
        <aside bind:this={asideEl} class:hot={dragging} class:over>
          <h4>{copy.projects}</h4>
          <div class="proj">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
              ><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.3 1.5H13c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg
            >
            <span>{project}</span>
          </div>
          <div
            class="slot"
            class:wait={b.sheet > 0 && !landed}
            class:filled={landed}
            bind:this={slotEl}
          >
            {#if landed}
              <span class="tag" aria-hidden="true">&gt;_</span><span class="name">{copy.sessionTitle}</span>
            {/if}
          </div>
        </aside>

        <section class="main">
          <div class="sheet" style:opacity={sheetOpacity} style:pointer-events={sheetOpacity > 0.5 ? 'auto' : 'none'}>
            <div class="sh-title">{copy.importTitle}</div>
            <div class="row">
              <div class="cardslot" bind:this={cardEl}></div>
              <button class="go" type="button" onclick={carryOn} tabindex={sheetOpacity > 0.5 ? 0 : -1}>{copy.carryOn}</button>
            </div>
            <p class="hint">{copy.dragHint}</p>
          </div>

          <div class="chat" bind:this={chatEl}>
            {#each items as it, i (i)}
              <div
                class="item {it.kind}"
                data-item={i}
                style:opacity={shown(i)}
                style:transform="translateY({(1 - shown(i)) * 8}px)"
              >
                {#if it.kind === 'fold'}
                  <span>{copy.toolsFolded(it.n)}</span>
                {:else}
                  <span class="bub">{it.text}</span>
                {/if}
              </div>
            {/each}
            <div class="item you" style:opacity={nextShown[0]} style:transform="translateY({(1 - nextShown[0]) * 8}px)">
              <span class="bub">{copy.next.you}</span>
            </div>
            <div class="item claude" style:opacity={nextShown[1]} style:transform="translateY({(1 - nextShown[1]) * 8}px)">
              <span class="bub">{copy.next.claude}</span>
            </div>
          </div>

          <div class="composer" aria-hidden="true" style:opacity={snap ? 1 : span(ep, 0.65, 0.72)}>
            <span>{copy.composer}</span>
            <i></i>
          </div>
        </section>
      </div>
    </div>
  </div>

  <div class="strip">
    <div class="home mochi" bind:this={mochiHome}></div>
    <p class="codex">{copy.codex}</p>
    <div class="home pudding" bind:this={puddingHome}></div>
  </div>

  {#if fork && geom}
    <Fork {fork} w={geom.w} h={geom.h} t={b.fork} label={copy.branch} />
  {/if}

  {#if card && cardPos && b.sheet > 0 && !landed}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flycard"
      class:grab={grabbable}
      class:dragging
      style:width="{card.w}px"
      style:height="{card.h}px"
      style:opacity={b.sheet}
      style:transform="translate3d({cardPos.x}px, {cardPos.y}px, 0)"
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
    >
      <span class="tag" aria-hidden="true">&gt;_</span>
      <span class="who">
        <span class="name">{copy.sessionTitle}</span>
        <span class="meta" style:opacity={1 - b.fly * 1.6}>{copy.sessionMeta}</span>
      </span>
    </div>
  {/if}

  <div class="spot" class:ready={!!geom} style:transform="translate3d({mochiAt.x}px, {mochiAt.y}px, 0)">
    <Stand who="mochi" size={size} />
  </div>
  <div class="spot" class:ready={!!geom} style:transform="translate3d({geom?.pudding.x ?? 0}px, {geom?.pudding.y ?? 0}px, 0)">
    <Stand who="pudding" size={size} />
  </div>
</div>

<style>
  .sess {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    color: var(--ink);
    font-size: 12px;
    line-height: 1.5;
  }

  .sess.fill {
    height: 100%;
    justify-content: center;
  }

  .wins {
    display: flex;
    flex-direction: column;
    gap: 44px;
  }

  .left {
    min-width: 0;
  }

  /* ---- the Deskfolk window ---- */
  .app {
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-window);
    overflow: hidden;
  }

  .tb {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 28px;
    padding: 0 11px;
    background: var(--ground);
    border-bottom: 1px solid var(--line);
  }

  .dots {
    display: flex;
    gap: 6px;
  }

  .dots i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--line);
  }

  .ttl {
    font-size: 11px;
    color: var(--ink-3);
    font-weight: 600;
  }

  .replay {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
    background: var(--paper);
    color: var(--ink-2);
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
  }

  .replay:hover {
    color: var(--teal);
    border-color: var(--teal-line);
  }

  .replay:focus-visible,
  .go:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .cols {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
  }

  aside {
    padding: 10px 7px;
    background: var(--ground);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition:
      background-color 0.2s,
      box-shadow 0.2s;
  }

  aside.hot {
    box-shadow: inset 0 0 0 1.5px var(--teal-line);
  }

  aside.over {
    background: var(--teal-tint);
    box-shadow: inset 0 0 0 1.5px var(--teal);
  }

  h4 {
    margin: 0 0 2px 3px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .proj {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 4px;
    font-size: 11px;
    color: var(--ink-2);
  }

  .proj span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .slot {
    margin-left: 6px;
    height: 38px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    border: 1px dashed transparent;
    font-size: 11px;
  }

  .slot.wait {
    border-color: var(--teal-line);
  }

  aside.over .slot.wait {
    border-color: var(--teal);
  }

  .slot.filled {
    border: 1px solid var(--teal-line);
    background: var(--teal-tint);
    color: var(--ink);
  }

  .tag {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--teal);
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .slot .name {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    font-size: 10.5px;
    line-height: 1.3;
  }

  /* ---- the main area: the sheet, then the conversation ---- */
  .main {
    position: relative;
    min-width: 0;
    min-height: 238px;
    display: flex;
    flex-direction: column;
    background: var(--ground);
  }

  .sheet {
    position: absolute;
    inset: 0 0 auto 0;
    margin: 14px 12px 0;
    padding: 12px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-float);
    z-index: 2;
  }

  .sh-title {
    font-size: 12.5px;
    font-weight: 600;
    margin-bottom: 9px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .cardslot {
    flex: 1;
    min-width: 0;
    height: 44px;
    border-radius: var(--radius-md);
    background: var(--ground);
    border: 1px solid var(--line-2);
  }

  .go {
    flex: none;
    padding: 6px 11px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--teal);
    color: var(--on-teal);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .go:hover {
    background: var(--teal-2);
  }

  .hint {
    margin: 9px 0 0;
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .flycard {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 9px;
    overflow: hidden;
    background: var(--paper);
    border: 1px solid var(--teal-line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-float);
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    will-change: transform;
  }

  .flycard.grab {
    cursor: grab;
  }

  .flycard.dragging {
    cursor: grabbing;
    border-color: var(--teal);
  }

  .who {
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.35;
  }

  .who .name {
    font-size: 11.5px;
    font-weight: 600;
  }

  .meta {
    font-size: 10px;
    color: var(--ink-3);
    white-space: nowrap;
  }

  .chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 12px 10px 8px;
    overflow: hidden;
  }

  .item {
    display: flex;
    flex-direction: column;
    will-change: transform, opacity;
  }

  .item.you {
    align-items: flex-end;
  }

  .item.claude {
    align-items: flex-start;
  }

  .bub {
    max-width: 88%;
    padding: 5px 9px;
    border-radius: var(--radius-md);
    border: 1px solid var(--line);
    background: var(--paper);
    font-size: 11.5px;
    line-height: 1.45;
  }

  .you .bub {
    background: var(--teal-tint);
    border-color: var(--teal-line);
    border-bottom-right-radius: var(--radius-xs);
  }

  .claude .bub {
    border-bottom-left-radius: var(--radius-xs);
  }

  .item.fold {
    align-items: center;
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .item.fold span {
    padding: 0 9px;
    border-radius: var(--radius-full);
    background: var(--ground-2);
    font-family: var(--font-mono);
  }

  .composer {
    margin: 0 10px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 5px 5px 11px;
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
    background: var(--paper);
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .composer i {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--teal);
  }

  /* ---- the strip under the windows: the companions' places and the footnote ---- */
  .strip {
    flex: none;
    display: grid;
    grid-template-columns: var(--spot) minmax(0, 1fr) var(--spot);
    align-items: end;
    gap: 8px;
  }

  .home {
    width: var(--spot);
    height: var(--spot);
  }

  .codex {
    margin: 0;
    padding-bottom: 6px;
    text-align: center;
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .spot {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--spot);
    height: var(--spot);
    z-index: 5;
    opacity: 0;
    pointer-events: none;
  }

  .spot.ready {
    opacity: 1;
  }

  .spot :global(.stand) {
    pointer-events: auto;
  }

  /* Narrow: the windows stack and the companions stand over the window edges, not under them. */
  .sess:not(.fill) .wins {
    gap: 40px;
  }

  @container (max-width: 559px) {
    .home {
      margin-top: calc(var(--spot) * -0.5);
    }

    .cols {
      grid-template-columns: 74px minmax(0, 1fr);
    }

    .main {
      min-height: 262px;
    }

    .chat {
      justify-content: flex-end;
      gap: 5px;
      padding-top: 8px;
    }

    .bub {
      padding: 3px 8px;
    }

    .composer {
      margin-right: calc(var(--spot) + 14px);
    }

    .bub {
      font-size: 11px;
    }
  }

  @container (min-width: 560px) {
    .wins {
      flex-direction: row;
      align-items: stretch;
      gap: 56px;
    }

    .left {
      flex: 1 1 0;
      align-self: flex-start;
    }

    .app {
      flex: 1.35 1 0;
      align-self: flex-start;
    }

    .main {
      min-height: 350px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    aside {
      transition: none;
    }
  }

  :global(html.sess-vt::view-transition-group(*)) {
    animation-duration: 0.55s;
    animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  :global(html.sess-vt::view-transition-old(*)),
  :global(html.sess-vt::view-transition-new(*)) {
    mix-blend-mode: normal;
  }
</style>
