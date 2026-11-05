<script lang="ts">
  import { onMount } from 'svelte';
  import Mascot from './Mascot.svelte';
  import { clamp, hopAt, hopHeight, lerp, lookToward, spring, type Point } from './motion';
  import { useStage, type Who } from './stage.svelte';

  /**
   * Mochi and Pudding as the page's companions, on a fixed layer over the page when it plays wide.
   * Each stands on the `[data-stand]` spot of the section the reader is on (Stand.svelte) and stays
   * on it as the page scrolls or the scene moves the spot; when the reader moves on to another
   * section, it hops across to that section's spot. Both lean back when the page is scrolled fast,
   * and look toward the pointer. Only the figures take the pointer: a press pokes them.
   */
  const stage = useStage();
  const WHO: Who[] = ['mochi', 'pudding'];
  const HOP_MS = 720;

  type Track = {
    el?: HTMLElement;
    anchor: HTMLElement | null;
    pos: Point;
    size: number;
    shown: boolean;
    hop: { from: Point; fromSize: number; start: number } | null;
  };

  const tracks: Record<Who, Track> = {
    mochi: { anchor: null, pos: { x: 0, y: 0 }, size: 0, shown: false, hop: null },
    pudding: { anchor: null, pos: { x: 0, y: 0 }, size: 0, shown: false, hop: null }
  };
  const els: Record<Who, HTMLElement | undefined> = $state({ mochi: undefined, pudding: undefined });
  let hopping = $state<Record<Who, boolean>>({ mochi: false, pudding: false });

  onMount(() => {
    let raf = 0;
    let pointer: Point | null = null;
    let lean = { value: 0, velocity: 0 };
    let last = performance.now();

    const move = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
    };
    const leave = () => (pointer = null);
    addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = (now - last) / 1000;
      last = now;
      lean = spring(lean.value, lean.velocity, clamp(-stage.velocity / 160, -11, 11), dt, 120, 14);

      for (const who of WHO) {
        const t = tracks[who];
        const el = els[who];
        if (!el) continue;
        const anchor = stage.anchor(who);
        if (!anchor) {
          if (t.shown) {
            t.shown = false;
            el.style.opacity = '0';
          }
          continue;
        }
        const r = anchor.getBoundingClientRect();
        const target = { x: r.left + r.width / 2, y: r.bottom };
        const size = r.width;

        if (anchor !== t.anchor) {
          // The first spot is taken at once; later ones are hopped to.
          if (t.anchor && t.shown) {
            t.hop = { from: { ...t.pos }, fromSize: t.size, start: now };
            hopping[who] = true;
          }
          t.anchor = anchor;
        }
        if (t.hop) {
          const k = (now - t.hop.start) / HOP_MS;
          if (k >= 1) {
            t.hop = null;
            hopping[who] = false;
            t.pos = target;
            t.size = size;
          } else {
            t.pos = hopAt(t.hop.from, target, k, hopHeight(t.hop.from, target));
            t.size = lerp(t.hop.fromSize, size, k);
          }
        } else {
          t.pos = target;
          t.size = size;
        }
        if (!t.shown) {
          t.shown = true;
          el.style.opacity = '';
        }

        el.style.width = `${t.size}px`;
        el.style.height = `${t.size}px`;
        el.style.transform = `translate3d(${(t.pos.x - t.size / 2).toFixed(1)}px, ${(t.pos.y - t.size).toFixed(1)}px, 0)`;
        el.style.setProperty('--lean', lean.value.toFixed(2));
        const look = lookToward({ x: t.pos.x, y: t.pos.y - t.size * 0.45 }, pointer);
        el.style.setProperty('--look-x', look.x.toFixed(3));
        el.style.setProperty('--look-y', look.y.toFixed(3));
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  });
</script>

<div class="companions">
  {#each WHO as who (who)}
    <div class="companion" bind:this={els[who]} style:opacity="0">
      <Mascot
        {who}
        state={stage.mascots[who]}
        label={stage.copy.names[who]}
        bubble={hopping[who] ? null : stage.bubble(who)}
        hopping={hopping[who]}
        poke={() => stage.poke(who, stage.copy.pokes[who])}
      />
    </div>
  {/each}
</div>

<style>
  .companions {
    position: fixed;
    inset: 0;
    z-index: 15;
    pointer-events: none;
    overflow: hidden;
    contain: strict;
  }

  .companion {
    position: absolute;
    left: 0;
    top: 0;
    will-change: transform;
    pointer-events: auto;
    transition: opacity 260ms ease;
  }
</style>
