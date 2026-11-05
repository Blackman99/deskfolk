<script lang="ts">
  import type { Held } from './stage.svelte';

  /** What a companion holds, drawn small and flat in the page's colours, centred on its hand. */
  let { item }: { item: Held } = $props();
</script>

<svg class="held-item is-{item}" viewBox="0 0 40 40" aria-hidden="true">
  {#if item === 'plug'}
    <rect x="11" y="14" width="18" height="16" rx="4" class="teal" />
    <rect x="15" y="6" width="3" height="9" rx="1" class="metal" />
    <rect x="22" y="6" width="3" height="9" rx="1" class="metal" />
    <path d="M20 30 v8" class="cord" />
  {:else if item === 'card'}
    <rect x="5" y="9" width="30" height="22" rx="4" class="paper" />
    <rect x="9" y="14" width="16" height="3" rx="1.5" class="ink" />
    <rect x="9" y="20" width="22" height="2.4" rx="1.2" class="soft" />
    <rect x="9" y="25" width="12" height="2.4" rx="1.2" class="soft" />
  {:else if item === 'phone'}
    <rect x="11" y="4" width="18" height="32" rx="4" class="dark" />
    <rect x="13" y="8" width="14" height="22" rx="2" class="screen" />
    <circle cx="20" cy="33" r="1.4" class="soft" />
  {:else if item === 'tab'}
    <path d="M6 30 V14 a4 4 0 0 1 4 -4 h20 a4 4 0 0 1 4 4 V30 z" class="paper" />
    <rect x="10" y="16" width="16" height="3" rx="1.5" class="teal" />
    <rect x="10" y="22" width="10" height="2.4" rx="1.2" class="soft" />
  {:else if item === 'receipt'}
    <path d="M10 4 h20 v32 l-3.3 -2.4 -3.3 2.4 -3.4 -2.4 -3.3 2.4 -3.3 -2.4 -3.4 2.4 z" class="paper" />
    <rect x="14" y="10" width="12" height="2.2" rx="1.1" class="ink" />
    <rect x="14" y="16" width="9" height="2" rx="1" class="soft" />
    <rect x="14" y="21" width="12" height="2" rx="1" class="soft" />
    <rect x="14" y="26" width="7" height="2" rx="1" class="teal" />
  {:else if item === 'file'}
    <path d="M10 4 h14 l7 7 v25 a2 2 0 0 1 -2 2 h-19 a2 2 0 0 1 -2 -2 v-30 a2 2 0 0 1 2 -2z" class="paper" />
    <path d="M24 4 v7 h7" class="fold" />
    <rect x="13" y="18" width="14" height="2.4" rx="1.2" class="soft" />
    <rect x="13" y="24" width="10" height="2.4" rx="1.2" class="soft" />
  {:else if item === 'mug'}
    <path d="M9 13 h18 v15 a6 6 0 0 1 -6 6 h-6 a6 6 0 0 1 -6 -6z" class="paper" />
    <path d="M27 17 h3 a4 4 0 0 1 0 8 h-3" class="handle" />
    <path d="M15 9 q2 -3 0 -6 M21 9 q2 -3 0 -6" class="steam" />
  {/if}
</svg>

<style>
  .held-item {
    position: absolute;
    width: 30cqw;
    height: 30cqw;
    left: -15cqw;
    top: -15cqw;
    overflow: visible;
    filter: drop-shadow(0 2px 3px rgba(18, 28, 32, 0.25));
  }

  .is-plug,
  .is-phone {
    width: 24cqw;
    height: 24cqw;
    left: -12cqw;
    top: -16cqw;
  }

  .teal {
    fill: var(--teal);
  }

  .metal {
    fill: #b8c2c6;
  }

  .cord {
    stroke: var(--ink-2);
    stroke-width: 3;
    stroke-linecap: round;
    fill: none;
  }

  .paper {
    fill: var(--paper);
    stroke: var(--line);
    stroke-width: 1.2;
  }

  .ink {
    fill: var(--ink);
  }

  .soft {
    fill: var(--ink-3);
    opacity: 0.55;
  }

  .dark {
    fill: #1d2529;
  }

  .screen {
    fill: var(--teal);
    opacity: 0.85;
  }

  .fold {
    fill: none;
    stroke: var(--line);
    stroke-width: 1.2;
  }

  .handle {
    fill: none;
    stroke: var(--line);
    stroke-width: 2.4;
  }

  .steam {
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1.6;
    stroke-linecap: round;
    opacity: 0.6;
  }
</style>
