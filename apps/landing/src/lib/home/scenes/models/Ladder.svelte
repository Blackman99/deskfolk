<script lang="ts">
  import type { SceneCopy } from '../../copy';

  /**
   * The model ladder: three rungs with a marker on the one a Bot is on, a button that climbs one
   * rung when it is stuck, and a chip that pins the connected model (the chip only shows the idea).
   */
  let {
    copy,
    rung,
    name,
    pinned = $bindable(),
    onstuck
  }: {
    copy: SceneCopy['models'];
    rung: number;
    name: string | null;
    pinned: boolean;
    onstuck: () => void;
  } = $props();
</script>

<div class="ladder">
  <div class="head">
    <p class="title">{copy.ladderTitle}</p>
    {#if name}
      <button type="button" class="pin" aria-pressed={pinned} onclick={() => (pinned = !pinned)}>
        <span class="dot" aria-hidden="true"></span>
        <span class="pname">{name}</span>
        <span class="ptag">{copy.pinned}</span>
      </button>
    {/if}
  </div>
  <div class="body">
    <div class="track" style:--rung={rung}>
    <ol class="rungs" aria-label={copy.ladderTitle}>
      {#each copy.rungs as r, i}
        <li class:is-here={i === rung} aria-current={i === rung ? 'true' : undefined}>
          <span class="bar" aria-hidden="true"></span>
          <span class="label">{r}</span>
        </li>
      {/each}
    </ol>
    <span class="marker" aria-hidden="true"></span>
    </div>
    <button type="button" class="stuck" onclick={onstuck}>{copy.stuck}</button>
  </div>
</div>

<style>
  .ladder {
    display: grid;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--paper);
    min-width: 0;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .title {
    margin: 0;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--ink-3);
  }

  .pin {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    height: 22px;
    padding: 0 8px;
    font: inherit;
    font-size: 11px;
    color: var(--ink-2);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      color 0.15s;
  }

  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.5px solid var(--ink-3);
  }

  .pin[aria-pressed='true'] .dot {
    background: var(--teal);
    border-color: var(--teal);
  }

  .pname {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--ink);
  }

  .ptag {
    color: var(--ink-3);
  }

  .pin[aria-pressed='true'] {
    background: var(--teal-tint);
    border-color: var(--teal-line);
  }

  .pin[aria-pressed='true'] .ptag {
    color: var(--teal);
  }

  .pin:focus-visible,
  .stuck:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .body {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 10px;
  }

  .track {
    position: relative;
  }

  .rungs {
    display: flex;
    flex-direction: column-reverse;
    margin: 0;
    padding: 0 0 0 16px;
    list-style: none;
  }

  .rungs li {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 18px;
    font-size: 12px;
    color: var(--ink-3);
  }

  .rungs li.is-here {
    color: var(--ink);
    font-weight: 600;
  }

  .bar {
    width: 14px;
    height: 2px;
    border-radius: 2px;
    background: var(--line);
  }

  .marker {
    position: absolute;
    left: 0;
    bottom: 4px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--teal);
    box-shadow: 0 0 0 3px var(--teal-tint);
    transform: translateY(calc(var(--rung) * -18px));
    transition: transform 0.55s cubic-bezier(0.3, 1.4, 0.5, 1);
  }

  .stuck {
    height: 28px;
    white-space: nowrap;
    padding: 0 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 560;
    color: var(--teal);
    background: var(--teal-tint);
    border: 1px solid var(--teal-line);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .stuck:hover {
    border-color: var(--teal);
  }

  @media (prefers-reduced-motion: reduce) {
    .marker,
    .pin {
      transition: none;
    }
  }
</style>
