<script lang="ts">
  import { onMount } from 'svelte';
  import Mascot from './Mascot.svelte';
  import { lookToward } from './motion';
  import { useStage, type Who } from './stage.svelte';

  /**
   * Where Mochi or Pudding stands in a scene: a square spot `size` px wide whose bottom edge is the
   * ground. When the page plays wide the spot stays empty and the companion layer (Companion.svelte)
   * puts the travelling figure on it; inline (narrow screens, reduced motion) the figure stands here
   * itself. Scenes move a spot to move the companion.
   */
  let { who, size = 112 }: { who: Who; size?: number } = $props();

  const stage = useStage();
  let el: HTMLElement | undefined = $state();

  onMount(() => {
    if (!el) return;
    const spot = el;
    // Inline, the figure still looks toward the pointer; wide, the companion layer does that.
    const look = (e: PointerEvent) => {
      if (stage.wide || stage.reduced) return;
      const r = spot.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      const l = lookToward({ x: r.left + r.width / 2, y: r.top + r.height * 0.55 }, { x: e.clientX, y: e.clientY });
      spot.style.setProperty('--look-x', l.x.toFixed(3));
      spot.style.setProperty('--look-y', l.y.toFixed(3));
    };
    addEventListener('pointermove', look, { passive: true });
    return () => removeEventListener('pointermove', look);
  });
</script>

<div class="stand" data-stand={who} bind:this={el} style:--size="{size}px">
  {#if !stage.wide}
    <Mascot
      {who}
      state={stage.mascots[who]}
      label={stage.copy.names[who]}
      bubble={stage.bubble(who)}
      poke={() => stage.poke(who, stage.copy.pokes[who])}
    />
  {/if}
</div>

<style>
  .stand {
    position: relative;
    width: var(--size);
    height: var(--size);
    flex: none;
  }
</style>
