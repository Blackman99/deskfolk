<script lang="ts">
  import PaneNode from './PaneNode.svelte';
  import TabContent from './TabContent.svelte';
  import { usePanes } from './context';
  import { DIVIDER, type Tree } from '../../pane-layout';

  /**
   * A node of the pane tree, drawn recursively: a pane (tab header and its content) or a split
   * (two nodes with a draggable divider between them). Sizes come from each split's ratio.
   */
  let { node }: { node: Tree } = $props();

  const ctx = usePanes();
  let box: HTMLElement | undefined = $state();

  function down(e: PointerEvent, id: string, row: boolean) {
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!box) return;
      const r = box.getBoundingClientRect();
      const span = (row ? r.width : r.height) - DIVIDER;
      const at = (row ? ev.clientX - r.left : ev.clientY - r.top) - DIVIDER / 2;
      if (span > 0) ctx.resize(id, at / span);
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  function key(e: KeyboardEvent, id: string, ratio: number, row: boolean) {
    const back = row ? 'ArrowLeft' : 'ArrowUp';
    const fwd = row ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    ctx.resize(id, ratio + (e.key === fwd ? 0.05 : -0.05));
  }
</script>

{#if node.kind === 'leaf'}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div
    class="pane"
    class:focused={ctx.focusId === node.id}
    data-leaf={node.id}
    role="group"
    aria-label={ctx.tabName(node.tab)}
    tabindex={ctx.interactive ? 0 : undefined}
    onpointerdown={ctx.interactive ? () => ctx.focus(node.id) : undefined}
    onfocus={ctx.interactive ? () => ctx.focus(node.id) : undefined}
    oncontextmenu={ctx.interactive ? (e) => ctx.openMenu(node.id, e) : undefined}
  >
    <div class="head">
      <span class="tab">{ctx.tabName(node.tab)}</span>
      {#if ctx.interactive && ctx.closable}
        <button class="x" type="button" aria-label="{ctx.closeLabel}: {ctx.tabName(node.tab)}" onclick={() => ctx.close(node.id)}>×</button>
      {/if}
    </div>
    <div class="content"><TabContent tab={node.tab} /></div>
  </div>
{:else}
  <div class="split {node.dir}" bind:this={box}>
    <div class="slot" style:flex="{node.ratio} 1 0"><PaneNode node={node.a} /></div>
    {#if ctx.interactive}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="divider {node.dir}"
        role="separator"
        tabindex="0"
        aria-label={ctx.resizeLabel}
        aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(node.ratio * 100)}
        onpointerdown={(e) => down(e, node.id, node.dir === 'row')}
        onkeydown={(e) => key(e, node.id, node.ratio, node.dir === 'row')}
      ></div>
    {:else}
      <div class="divider {node.dir} still"></div>
    {/if}
    <div class="slot" style:flex="{1 - node.ratio} 1 0"><PaneNode node={node.b} /></div>
  </div>
{/if}

<style>
  .split {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .split.col {
    flex-direction: column;
  }

  .slot {
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
    outline: none;
  }

  .pane:focus-visible {
    box-shadow: inset 0 0 0 2px var(--teal);
  }

  .head {
    flex: none;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    height: 26px;
    border-bottom: 1px solid var(--line);
    background: var(--ground);
  }

  .tab {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-size: 11px;
    font-weight: 500;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .tab::after {
    content: '';
    position: absolute;
    left: 6px;
    right: 6px;
    bottom: -1px;
    height: 2px;
    border-radius: 2px;
    background: var(--teal);
    opacity: 0.4;
  }

  .pane.focused .tab {
    color: var(--ink);
  }

  .pane.focused .tab::after {
    opacity: 1;
  }

  .x {
    flex: none;
    width: 24px;
    border: 0;
    background: transparent;
    color: var(--ink-3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .x:hover,
  .x:focus-visible {
    color: var(--ink);
  }

  .x:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: -2px;
  }

  .content {
    flex: 1;
    min-height: 0;
  }

  .divider {
    position: relative;
    flex: none;
    touch-action: none;
    outline: none;
  }

  .divider.row {
    width: 6px;
    cursor: col-resize;
  }

  .divider.col {
    height: 6px;
    cursor: row-resize;
  }

  .divider:not(.still)::after {
    content: '';
    position: absolute;
    border-radius: 2px;
    background: var(--teal);
    opacity: 0;
    transition: opacity 0.12s;
  }

  .divider.row::after {
    left: 2px;
    right: 2px;
    top: 38%;
    bottom: 38%;
  }

  .divider.col::after {
    top: 2px;
    bottom: 2px;
    left: 38%;
    right: 38%;
  }

  .divider:hover::after,
  .divider:focus-visible::after,
  .divider:active::after {
    opacity: 0.85;
  }
</style>
