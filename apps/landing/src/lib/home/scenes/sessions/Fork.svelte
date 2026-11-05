<script lang="ts">
  import { clamp } from '../../motion';
  import type { Fork } from './logic';

  /**
   * The branch drawn between the terminal's last line and the app's conversation: one stem that
   * splits in two, the branch into the app in teal and the stub that stops short in grey. It draws
   * itself in as `t` (0..1) grows and labels itself once it has.
   */
  let { fork, w, h, t, label }: { fork: Fork; w: number; h: number; t: number; label: string } = $props();

  const stem = $derived(1 - clamp(t / 0.3));
  const rest = $derived(1 - clamp((t - 0.3) / 0.7));
</script>

<div class="fork" aria-hidden="true">
  <svg width={w} height={h} viewBox="0 0 {w} {h}">
    <path class="grey" d={fork.stem} pathLength="1" stroke-dasharray="1" stroke-dashoffset={stem} />
    <path class="grey dash" d={fork.kept} pathLength="1" stroke-dasharray="1" stroke-dashoffset={rest} />
    <path class="teal" d={fork.into} pathLength="1" stroke-dasharray="1" stroke-dashoffset={rest} />
    {#if t > 0.02}
      <circle class="dot" cx={fork.dot.x} cy={fork.dot.y} r="3" style:opacity={clamp(t * 4)} />
    {/if}
  </svg>
  <span class="label" style:left="{fork.label.x}px" style:top="{fork.label.y}px" style:opacity={clamp((t - 0.7) / 0.3)}
    >{label}</span
  >
</div>

<style>
  .fork {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 3;
  }

  svg {
    display: block;
    overflow: visible;
  }

  path {
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
  }

  .teal {
    stroke: var(--teal);
  }

  .grey {
    stroke: var(--ink-3);
    opacity: 0.8;
  }

  .dot {
    fill: var(--teal);
  }

  .label {
    position: absolute;
    transform: translate(-50%, -50%);
    padding: 1px 8px;
    border-radius: var(--radius-full);
    background: var(--paper);
    border: 1px solid var(--teal-line);
    color: var(--teal);
    font-size: 10.5px;
    line-height: 1.6;
    white-space: nowrap;
    box-shadow: var(--shadow-float);
  }
</style>
