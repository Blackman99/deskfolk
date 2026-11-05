<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { lerp, span } from '../motion';
  import {
    actorsAt,
    edgeAt,
    floatOut,
    FLOAT_AT,
    keycapOn,
    layoutRects,
    leaves,
    nextTab,
    paneAt,
    remove,
    resize,
    retab,
    split,
    structureKey,
    treeAt,
    treeStep,
    zoneRect,
    type Edge,
    type Rect,
    type Tree
  } from '../pane-layout';
  import type { SceneProps } from '../scene';
  import Stand from '../Stand.svelte';
  import { useStage, type Who } from '../stage.svelte';
  import FloatWin from './panes/FloatWin.svelte';
  import PaneNode from './panes/PaneNode.svelte';
  import { providePanes } from './panes/context';

  let { copy, p, active, lang }: SceneProps<'panes'> = $props();
  const stage = useStage();

  type Float = { id: string; tab: number; x: number; y: number; z: number };
  const MENU_EDGES: Edge[] = ['top', 'bottom', 'left', 'right'];

  /* Measured boxes, in px: the scene, and the pane area inside the window (relative to the scene). */
  let root: HTMLElement | undefined = $state();
  let areaEl: HTMLElement | undefined = $state();
  let box = $state({ rw: 0, rh: 0, ax: 0, ay: 0, aw: 0, ah: 0 });
  // The app has no panes on narrow windows or phones. The pinned scene itself is only about 540 to
  // 690 px wide on a desktop, so the scene goes static below 480 px (a phone), not at the app's 680.
  const narrow = $derived(box.rw > 0 && box.rw < 480);

  /* The layout: scripted from `p`, until the reader takes it over. */
  let mode = $state<'auto' | 'user'>('auto');
  let userTree = $state.raw<Tree>(treeAt(0));
  let userFloats = $state.raw<Float[]>([]);
  let focusId = $state('a');
  let zTop = 2;
  let seq = 0;

  const pp = $derived(narrow ? 1 : p);
  const autoTree = $derived(treeAt(treeStep(pp)));
  const floatShown = $derived(floatOut(pp));
  const tree = $derived(mode === 'user' ? userTree : autoTree);
  // The panes sit inside the area's 6 px padding.
  const PAD = 6;
  const inner = $derived({ x: PAD, y: PAD, w: Math.max(0, box.aw - PAD * 2), h: Math.max(0, box.ah - PAD * 2) });
  const fw = $derived(Math.min(220, box.aw * 0.5));
  const fh = $derived(Math.min(150, box.ah * 0.5));
  const clampFloat = (x: number, y: number) => ({
    x: Math.max(0, Math.min(box.aw - fw, x)),
    y: Math.max(0, Math.min(box.ah - fh, y))
  });

  const autoFloats = $derived<Float[]>(
    floatShown ? [{ id: 'f4', tab: 4, z: 2, ...clampFloat(box.aw * FLOAT_AT.fx, box.ah * FLOAT_AT.fy) }] : []
  );
  const floats = $derived(mode === 'user' ? userFloats : autoFloats);
  const actors = $derived(mode === 'auto' ? actorsAt(pp) : {});
  const carried = $derived(Object.values(actors).filter((a) => a.phase === 'out').map((a) => a.tab));
  const paneList = $derived(leaves(tree));
  const openTabs = $derived([...paneList.map((l) => l.tab), ...floats.map((f) => f.tab)]);
  const tray = $derived([0, 1, 2, 3, 4].filter((t) => !openTabs.includes(t) && !carried.includes(t)));
  const lastPane = $derived(paneList.some((l) => l.id === focusId) ? focusId : paneList[0].id);
  const rects = $derived(layoutRects(tree, inner));

  /* Taking over: the reader's first touch freezes what the script has built so far. */
  function takeOver() {
    if (mode === 'user') return;
    userTree = autoTree;
    userFloats = autoFloats;
    mode = 'user';
  }

  let cheering = $state(false);
  let cheerTimer: ReturnType<typeof setTimeout> | undefined;
  function cheer() {
    cheering = true;
    clearTimeout(cheerTimer);
    cheerTimer = setTimeout(() => (cheering = false), 1400);
  }

  const newId = () => `u${seq++}`;

  function doSplit(leafId: string, edge: Edge, tab: number) {
    takeOver();
    const id = newId();
    userTree = split(userTree, leafId, edge, tab, id);
    focusId = id;
    cheer();
  }

  function doReplace(leafId: string, tab: number) {
    takeOver();
    userTree = retab(userTree, leafId, tab);
    cheer();
  }

  function doFloat(tab: number, cx: number, cy: number) {
    takeOver();
    const at = clampFloat(cx - fw / 2, cy - 13);
    userFloats = [...userFloats.filter((f) => f.tab !== tab), { id: `f${tab}`, tab, ...at, z: ++zTop }];
    cheer();
  }

  function floatPane(leafId: string) {
    takeOver();
    const pane = leaves(userTree).find((l) => l.id === leafId);
    const rest = pane && leaves(userTree).length > 1 ? remove(userTree, leafId) : null;
    if (!pane || !rest) return;
    const n = userFloats.length;
    userTree = rest;
    const at = clampFloat(box.aw * 0.4 + n * 18, box.ah * 0.12 + n * 18);
    userFloats = [...userFloats, { id: `f${pane.tab}`, tab: pane.tab, ...at, z: ++zTop }];
    cheer();
  }

  function closePane(leafId: string) {
    takeOver();
    const rest = remove(userTree, leafId);
    if (rest) userTree = rest;
  }

  function moveFloat(id: string, x: number, y: number) {
    userFloats = userFloats.map((f) => (f.id === id ? { ...f, ...clampFloat(x, y) } : f));
  }

  function reset() {
    mode = 'auto';
    menu = null;
    drag = null;
    cheering = false;
  }

  // Coming back to the chapter plays it again from the top.
  $effect(() => {
    if (!active) reset();
  });

  const ctx = {
    get interactive() {
      return !narrow;
    },
    get focusId() {
      return lastPane;
    },
    get closable() {
      return paneList.length > 1;
    },
    get closeLabel() {
      return copy.close;
    },
    get resizeLabel() {
      return copy.resize;
    },
    tabName: (tab: number) => copy.tabs[tab],
    focus: (id: string) => (focusId = id),
    close: closePane,
    resize(splitId: string, ratio: number) {
      takeOver();
      userTree = resize(userTree, splitId, ratio);
    },
    openMenu
  };
  providePanes(ctx);

  /* Dragging a tab out of the tray. */
  let drag = $state<{ tab: number; x: number; y: number; alt: boolean; moved: boolean } | null>(null);
  let suppressClick = false;
  let start = { x: 0, y: 0 };

  const dragPoint = $derived(drag ? { x: drag.x - box.ax, y: drag.y - box.ay } : null);
  const over = $derived.by(() => {
    if (!drag?.moved || !dragPoint) return null;
    const id = paneAt(rects, dragPoint);
    const r = id ? rects.get(id) : null;
    const edge = r ? edgeAt(r, dragPoint) : null;
    return id && edge ? { id, edge } : null;
  });
  const inArea = $derived(
    !!dragPoint && dragPoint.x >= 0 && dragPoint.y >= 0 && dragPoint.x <= box.aw && dragPoint.y <= box.ah
  );

  function chipDown(e: PointerEvent, tab: number) {
    if (e.button !== 0 || narrow) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    drag = { tab, ...rel(e), alt: e.altKey, moved: false };
  }

  function rel(e: PointerEvent) {
    const r = root!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function chipMove(e: PointerEvent) {
    if (!drag) return;
    const moved = drag.moved || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4;
    if (moved && !drag.moved) takeOver();
    drag = { ...drag, ...rel(e), alt: e.altKey, moved };
  }

  function chipUp(e: PointerEvent) {
    const d = drag;
    drag = null;
    if (!d?.moved) return;
    // The click that follows a drag is not a request to split; the chip may be gone before it comes.
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const pt = { x: e.clientX - root!.getBoundingClientRect().left - box.ax, y: e.clientY - root!.getBoundingClientRect().top - box.ay };
    if (!(pt.x >= 0 && pt.y >= 0 && pt.x <= box.aw && pt.y <= box.ah)) return;
    if (e.altKey) {
      doFloat(d.tab, pt.x, pt.y);
      return;
    }
    const id = paneAt(rects, pt);
    const r = id ? rects.get(id) : null;
    const edge = id && r ? edgeAt(r, pt) : null;
    if (!id || !edge) return;
    if (edge === 'center') doReplace(id, d.tab);
    else doSplit(id, edge, d.tab);
  }

  // A plain click or Enter on a chip: split the last pane you were in, to the right.
  function chipClick(tab: number) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    doSplit(lastPane, 'right', tab);
  }

  /* The right-click menu. */
  let menu = $state<{ leafId: string; x: number; y: number } | null>(null);
  let menuEl: HTMLElement | undefined = $state();
  const spare = $derived(nextTab(openTabs, copy.tabs.length));

  function openMenu(leafId: string, e: MouseEvent) {
    e.preventDefault();
    const r = root!.getBoundingClientRect();
    let x = e.clientX - r.left;
    let y = e.clientY - r.top;
    if (e.clientX === 0 && e.clientY === 0) {
      // From the keyboard: open at the pane's corner.
      const pane = (e.currentTarget as HTMLElement).getBoundingClientRect();
      x = pane.left - r.left + 16;
      y = pane.top - r.top + 30;
    }
    focusId = leafId;
    menu = { leafId, x: Math.max(4, Math.min(x, r.width - 176)), y: Math.max(4, Math.min(y, r.height - 168)) };
    tick().then(() => menuEl?.querySelector<HTMLElement>('button:not(:disabled)')?.focus());
  }

  function closeMenu(refocus = false) {
    const id = menu?.leafId;
    menu = null;
    if (refocus && id) root?.querySelector<HTMLElement>(`[data-leaf="${id}"]`)?.focus();
  }

  function menuPick(i: number) {
    if (!menu) return;
    const id = menu.leafId;
    closeMenu(true);
    if (i < 4) {
      if (spare !== null) doSplit(id, MENU_EDGES[i], spare);
    } else floatPane(id);
  }

  function menuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
      return;
    }
    if (e.key === 'Tab') {
      closeMenu();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(menuEl?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }

  $effect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!menuEl?.contains(e.target as Node)) menu = null;
    };
    addEventListener('pointerdown', away, true);
    return () => removeEventListener('pointerdown', away, true);
  });

  /* The drop zone: under the pointer while dragging, or where the script's carrier is aiming. */
  const zone = $derived.by((): { r: Rect; kind: 'drop' | 'float' } | null => {
    if (drag?.moved) {
      if (!inArea) return null;
      if (drag.alt) {
        const at = clampFloat(dragPoint!.x - fw / 2, dragPoint!.y - 13);
        return { r: { ...at, w: fw, h: fh }, kind: 'float' };
      }
      if (!over) return null;
      return { r: zoneRect(rects.get(over.id)!, over.edge), kind: 'drop' };
    }
    for (const a of Object.values(actors)) {
      if (a.phase !== 'out' || !a.at || a.t < 0.45) continue;
      const r = layoutRects(a.before, inner).get(a.at.leafId);
      if (r) return { r: zoneRect(r, a.at.edge), kind: 'drop' };
    }
    return null;
  });

  /* The companions: at home by the tray, or carrying a tab to where it goes. */
  const S = $derived(narrow ? 76 : 92);
  const home = $derived({
    mochi: { x: 6, y: box.rh - S },
    pudding: { x: box.rw - S - 6, y: box.rh - S }
  });

  function target(a: NonNullable<ReturnType<typeof actorsAt>[Who]>) {
    const mid = a.at
      ? (() => {
          const r = layoutRects(a.before, inner).get(a.at.leafId);
          const z = r ? zoneRect(r, a.at.edge) : inner;
          return { x: z.x + z.w / 2, y: z.y + z.h / 2 };
        })()
      : { x: box.aw * 0.5, y: box.ah * 0.5 };
    return {
      x: Math.max(0, Math.min(box.rw - S, box.ax + mid.x - S / 2)),
      y: Math.max(0, Math.min(box.rh - S, box.ay + mid.y + 14 - S))
    };
  }

  const spots = $derived.by(() => {
    const out = {} as Record<Who, { x: number; y: number; pose: 'idle' | 'carry' | 'cheer' | 'look'; held: 'tab' | null; mirror: boolean }>;
    for (const who of ['mochi', 'pudding'] as const) {
      const h = home[who];
      const a = actors[who];
      const facesLeft = who === 'pudding';
      if (!a) {
        out[who] = {
          ...h,
          pose: cheering && who === 'mochi' ? 'cheer' : drag?.moved && who === 'pudding' ? 'look' : 'idle',
          held: null,
          mirror: facesLeft
        };
        continue;
      }
      const to = target(a);
      const k = a.phase === 'out' ? span(a.t, 0, 0.6) : span(a.t, 0, 1);
      const from = a.phase === 'out' ? h : to;
      const goal = a.phase === 'out' ? to : h;
      out[who] = {
        x: lerp(from.x, goal.x, k),
        y: lerp(from.y, goal.y, k),
        pose: a.phase === 'out' ? 'carry' : a.t < 0.7 ? 'cheer' : 'idle',
        held: a.phase === 'out' ? 'tab' : null,
        mirror: to.x < h.x
      };
    }
    return out;
  });

  $effect(() => {
    if (!active) return;
    for (const who of ['mochi', 'pudding'] as const) {
      const s = spots[who];
      stage.act(who, { pose: s.pose, held: s.held, mirror: s.mirror, say: null, away: false });
    }
  });

  const keycap = $derived(mode === 'auto' && !narrow && keycapOn(pp));

  /* Measuring, and animating a layout change (FLIP: first, last, invert, play). */
  let prev = new Map<string, Rect>();
  let prevKey = '';

  function measure() {
    if (!root || !areaEl) return;
    const r = root.getBoundingClientRect();
    const a = areaEl.getBoundingClientRect();
    const next = { rw: r.width, rh: r.height, ax: a.left - r.left, ay: a.top - r.top, aw: a.width, ah: a.height };
    if (Object.keys(next).some((k) => Math.abs(next[k as keyof typeof next] - box[k as keyof typeof box]) > 0.4)) box = next;
  }

  function leafRects(): Map<string, Rect> {
    const out = new Map<string, Rect>();
    if (!areaEl) return out;
    const a = areaEl.getBoundingClientRect();
    for (const el of areaEl.querySelectorAll<HTMLElement>('[data-leaf]')) {
      el.getAnimations().forEach((an) => an.cancel());
      const r = el.getBoundingClientRect();
      out.set(el.dataset.leaf!, { x: r.left - a.left, y: r.top - a.top, w: r.width, h: r.height });
    }
    return out;
  }

  function flip(before: Map<string, Rect>, after: Map<string, Rect>) {
    for (const el of areaEl!.querySelectorAll<HTMLElement>('[data-leaf]')) {
      const id = el.dataset.leaf!;
      const was = before.get(id);
      const now = after.get(id);
      if (!now) continue;
      const easing = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
      if (!was) {
        el.animate([{ opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1 }], { duration: 260, easing });
        continue;
      }
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      const sx = was.w / now.w;
      const sy = was.h / now.h;
      if (Math.abs(dx) + Math.abs(dy) < 1 && Math.abs(sx - 1) + Math.abs(sy - 1) < 0.01) continue;
      el.animate(
        [
          { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transformOrigin: '0 0', transform: 'none' }
        ],
        { duration: 260, easing }
      );
    }
  }

  $effect(() => {
    const key = structureKey(tree) + (narrow ? 'n' : '');
    void tree;
    if (!areaEl) return;
    const next = leafRects();
    if (key !== prevKey && prev.size && !stage.reduced && !narrow) flip(prev, next);
    prev = next;
    prevKey = key;
  });

  onMount(() => {
    measure();
    const ro = new ResizeObserver(() => {
      measure();
      prev = leafRects();
    });
    if (root) ro.observe(root);
    if (areaEl) ro.observe(areaEl);
    return () => {
      ro.disconnect();
      clearTimeout(cheerTimer);
    };
  });
</script>

<div class="scene-panes" class:wide={stage.wide} class:narrow class:smooth={mode === 'user' && !stage.reduced} bind:this={root}>
  <div class="window" role={narrow ? 'img' : 'group'} aria-label={copy.window}>
    <div class="titlebar" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="body">
      <div class="side" aria-hidden="true"><b class="on"></b><b></b><b></b><b></b></div>
      <div class="area" bind:this={areaEl}>
        <div class="tree"><PaneNode node={tree} /></div>
        {#each floats as f (f.id)}
          <FloatWin
            name={copy.tabs[f.tab]}
            tab={f.tab}
            x={f.x}
            y={f.y}
            w={fw}
            h={fh}
            z={f.z}
            interactive={!narrow}
            closeLabel={copy.close}
            move={(x, y) => moveFloat(f.id, x, y)}
            close={() => {
              takeOver();
              userFloats = userFloats.filter((g) => g.id !== f.id);
            }}
            front={() => (userFloats = userFloats.map((g) => (g.id === f.id ? { ...g, z: ++zTop } : g)))}
          />
        {/each}
        {#if zone}
          <div
            class="zone {zone.kind}"
            style:transform="translate({zone.r.x}px, {zone.r.y}px)"
            style:width="{zone.r.w}px"
            style:height="{zone.r.h}px"
            aria-hidden="true"
          ></div>
        {/if}
      </div>
    </div>
  </div>

  <div class="foot">
    {#if narrow}
      <p class="caption">{copy.narrow}</p>
    {:else}
      <div class="hints">
        <span>{copy.dropHint}</span><span class="sep" aria-hidden="true">·</span><span>{copy.floatHint}</span>
        <button class="reset" type="button" disabled={mode === 'auto'} onclick={reset}>{copy.reset}</button>
      </div>
      <div class="tray" role="group" aria-label={copy.tray}>
        {#each tray as tab (tab)}
          <button
            class="chip"
            class:lifted={drag?.tab === tab && drag.moved}
            type="button"
            onpointerdown={(e) => chipDown(e, tab)}
            onpointermove={chipMove}
            onpointerup={chipUp}
            onpointercancel={() => (drag = null)}
            onclick={() => chipClick(tab)}
          >
            <span class="grip" aria-hidden="true"></span>{copy.tabs[tab]}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="mascots">
    {#each ['mochi', 'pudding'] as const as who}
      <div class="spot" style:transform="translate({spots[who].x}px, {spots[who].y}px)" style:width="{S}px">
        <Stand {who} size={S} />
        {#if who === 'mochi' && keycap}<kbd class="keycap" aria-hidden="true">⌥</kbd>{/if}
      </div>
    {/each}
  </div>

  {#if drag?.moved}
    <div class="ghost" class:float={drag.alt} style:transform="translate({drag.x + 10}px, {drag.y + 10}px)" aria-hidden="true">
      {copy.tabs[drag.tab]}{#if drag.alt}<kbd>⌥</kbd>{/if}
    </div>
  {/if}

  {#if menu}
    <div
      class="menu"
      role="menu"
      tabindex="-1"
      aria-label={copy.paneMenu}
      bind:this={menuEl}
      style:left="{menu.x}px"
      style:top="{menu.y}px"
      onkeydown={menuKey}
    >
      {#each copy.menu as label, i}
        <button
          type="button"
          role="menuitem"
          class:sepbefore={i === 4}
          disabled={i < 4 ? spare === null : paneList.length < 2}
          onclick={() => menuPick(i)}>{label}</button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .scene-panes {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    height: 100%;
    min-height: 0;
    --foot: 98px;
  }

  .window {
    flex: none;
    height: 380px;
    display: flex;
    flex-direction: column;
    background: var(--ground);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-float);
    overflow: hidden;
  }

  .scene-panes.wide .window {
    flex: 1;
    height: auto;
    min-height: 0;
  }

  .scene-panes.narrow .window {
    height: 300px;
  }

  .titlebar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    border-bottom: 1px solid var(--line);
    background: var(--ground-2);
  }

  .titlebar i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ink-3);
    opacity: 0.4;
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .side {
    flex: none;
    width: 38px;
    padding: 10px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    border-right: 1px solid var(--line);
    background: var(--ground-2);
  }

  .side b {
    width: 16px;
    height: 16px;
    border-radius: 5px;
    background: var(--line);
  }

  .side b.on {
    background: var(--teal);
    opacity: 0.85;
  }

  .area {
    position: relative;
    flex: 1;
    min-width: 0;
    padding: 6px; /* PAD */
    overflow: hidden;
    background: var(--ground);
  }

  .tree {
    display: flex;
    width: 100%;
    height: 100%;
  }

  .zone {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 30;
    pointer-events: none;
    box-sizing: border-box;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--teal) 22%, transparent);
    border: 1.5px solid var(--teal);
  }

  .zone.float {
    background: color-mix(in srgb, var(--teal) 10%, transparent);
    border-style: dashed;
  }

  .foot {
    flex: none;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    gap: 7px;
    min-height: var(--foot);
    padding: 0 calc(var(--spot, 92px) + 14px);
    padding-inline: 112px;
  }

  .scene-panes.narrow .foot {
    padding-inline: 88px;
    min-height: 84px;
    justify-content: center;
  }

  .caption {
    margin: 0;
    text-align: center;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  .hints {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ink-3);
  }

  .reset {
    margin-left: 6px;
    height: 22px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
    background: var(--paper);
    color: var(--ink-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .reset:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .reset:not(:disabled):hover {
    border-color: var(--teal-line);
    color: var(--teal);
  }

  .tray {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
    min-height: 28px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 12px 0 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: grab;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .chip:hover {
    border-color: var(--teal-line);
  }

  .chip:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .chip.lifted {
    opacity: 0.45;
    cursor: grabbing;
  }

  .grip {
    width: 8px;
    height: 12px;
    background:
      radial-gradient(circle, var(--ink-3) 1px, transparent 1.4px) 0 0 / 4px 4px;
    opacity: 0.7;
  }

  .mascots {
    position: absolute;
    inset: 0;
    z-index: 40;
    pointer-events: none;
  }

  .spot {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: auto;
    will-change: transform;
  }

  .scene-panes.smooth .spot {
    transition: transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .keycap {
    position: absolute;
    right: -2px;
    top: 4px;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: var(--radius-xs);
    background: var(--paper);
    color: var(--teal);
    font: 600 13px var(--font-mono);
    box-shadow: var(--shadow-float);
  }

  .ghost {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 60;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--teal);
    border-radius: var(--radius-sm);
    background: var(--paper);
    color: var(--ink);
    font-size: 12px;
    box-shadow: var(--shadow-float);
    pointer-events: none;
    white-space: nowrap;
  }

  .ghost kbd {
    font: 600 11px var(--font-mono);
    color: var(--teal);
  }

  .menu {
    position: absolute;
    z-index: 70;
    width: 168px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--paper);
    box-shadow: var(--shadow-float);
    outline: none;
  }

  .menu button {
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .menu button.sepbefore {
    margin-top: 5px;
    position: relative;
  }

  .menu button.sepbefore::before {
    content: '';
    position: absolute;
    left: 6px;
    right: 6px;
    top: -3px;
    height: 1px;
    background: var(--line);
  }

  .menu button:hover:not(:disabled),
  .menu button:focus-visible {
    background: var(--teal-tint);
    color: var(--teal);
    outline: none;
  }

  .menu button:disabled {
    color: var(--ink-3);
    opacity: 0.55;
    cursor: default;
  }

  @media (prefers-reduced-motion: no-preference) {
    .zone {
      animation: fade 0.16s ease-out backwards;
    }

    .keycap {
      animation: flash 0.7s ease-in-out infinite alternate;
    }
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes flash {
    from {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .scene-panes.smooth .spot {
      transition: none;
    }
  }
</style>
