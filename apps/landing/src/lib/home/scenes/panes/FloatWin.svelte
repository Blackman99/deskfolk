<script lang="ts">
  import TabContent from './TabContent.svelte';

  /**
   * A tab floated out of the layout: a small window over the panes, moved by its title and closed
   * with ×. It reports where it is dragged to and leaves the clamping to the scene.
   */
  let {
    name,
    tab,
    x,
    y,
    w,
    h,
    z,
    interactive,
    closeLabel,
    move,
    close,
    front
  }: {
    name: string;
    tab: number;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    interactive: boolean;
    closeLabel: string;
    move: (x: number, y: number) => void;
    close: () => void;
    front: () => void;
  } = $props();

  function down(e: PointerEvent) {
    if (!interactive || e.button !== 0) return;
    front();
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    const ox = e.clientX - x;
    const oy = e.clientY - y;
    const onMove = (ev: PointerEvent) => move(ev.clientX - ox, ev.clientY - oy);
    const end = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }
</script>

<div
  class="float"
  role="group"
  aria-label={name}
  style:transform="translate({x}px, {y}px)"
  style:width="{w}px"
  style:height="{h}px"
  style:z-index={z}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="title" class:grab={interactive} onpointerdown={down}>
    <span>{name}</span>
    {#if interactive}
      <button type="button" aria-label="{closeLabel}: {name}" onpointerdown={(e) => e.stopPropagation()} onclick={close}>×</button>
    {/if}
  </div>
  <div class="body"><TabContent {tab} /></div>
</div>

<style>
  .float {
    position: absolute;
    left: 0;
    top: 0;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-float), 0 0 0 1px var(--line-2);
    overflow: hidden;
  }

  .title {
    flex: none;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    height: 26px;
    border-bottom: 1px solid var(--line);
    background: var(--ground);
    font-size: 11px;
    font-weight: 500;
    color: var(--ink);
    -webkit-user-select: none;
    user-select: none;
    touch-action: none;
  }

  .title.grab {
    cursor: grab;
  }

  .title span {
    display: flex;
    align-items: center;
    padding: 0 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  button {
    flex: none;
    width: 26px;
    border: 0;
    background: transparent;
    color: var(--ink-3);
    font-size: 14px;
    cursor: pointer;
  }

  button:hover,
  button:focus-visible {
    color: var(--ink);
  }

  button:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: -2px;
  }

  .body {
    flex: 1;
    min-height: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .float {
      animation: pop 0.26s cubic-bezier(0.2, 0.7, 0.2, 1) backwards;
    }
  }

  @keyframes pop {
    from {
      opacity: 0;
      scale: 0.92;
    }
  }
</style>
