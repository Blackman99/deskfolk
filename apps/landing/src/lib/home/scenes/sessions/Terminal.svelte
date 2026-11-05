<script lang="ts">
  import type { Line } from './logic';

  /**
   * The terminal on the left: dark body, a transcript that types itself out as far as `shown` says,
   * a cursor that blinks while it types, and, once the app has forked the session, a badge saying
   * the original stays as it was. Every line is laid out in full from the start (the untyped rest
   * is invisible), so typing never moves anything.
   */
  let {
    title,
    lines,
    shown,
    typing,
    kept,
    badge,
    el = $bindable(),
    lineEls = $bindable([])
  }: {
    title: string;
    lines: Line[];
    shown: number[];
    typing: boolean;
    kept: string;
    /** 0..1: the badge showing. */
    badge: number;
    el?: HTMLElement;
    lineEls?: HTMLElement[];
  } = $props();

  /** The line the cursor is on: the first not fully typed, else none. */
  const cursorAt = $derived(typing ? lines.findIndex((l, i) => shown[i] < l.text.length) : -1);
</script>

<div class="term" bind:this={el}>
  <div class="bar" aria-hidden="true">
    <i></i><i></i><i></i>
    <span>{title}</span>
  </div>
  <div class="body">
    {#each lines as l, i (i)}
      <div
        class="ln {l.who}"
        data-line={i}
        bind:this={lineEls[i]}
        aria-hidden={shown[i] === 0 ? 'true' : undefined}
      >
        <span class="mk" class:on={shown[i] > 0}>{l.who === 'you' ? '> ' : '⏺ '}</span>
        <span class="tx">
          {l.text.slice(0, shown[i])}{#if cursorAt === i}<b class="cur"></b>{/if}<span class="rest"
            >{l.text.slice(shown[i])}</span
          >
        </span>
      </div>
    {/each}
    <div class="kept" style:opacity={badge} style:transform="translateY({(1 - badge) * 4}px)">
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"
        ><path d="M2.5 6.4l2.4 2.4 4.6-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg
      >
      {kept}
    </div>
  </div>
</div>

<style>
  /* Fixed dark colours: a terminal is dark in both themes. */
  .term {
    background: #14191c;
    color: #d6dde0;
    border: 1px solid #2a343a;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-window);
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.55;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 11px;
    background: #1d2428;
    border-bottom: 1px solid #2a343a;
  }

  .bar i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #3a464c;
  }

  .bar i:nth-child(1) {
    background: #e0675f;
  }

  .bar i:nth-child(2) {
    background: #e2b04e;
  }

  .bar i:nth-child(3) {
    background: #5fbf6a;
  }

  .bar span {
    margin-left: 6px;
    color: #8d9ba1;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .body {
    padding: 11px 13px 12px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .ln {
    display: grid;
    grid-template-columns: 2ch minmax(0, 1fr);
    word-break: break-word;
  }

  .mk {
    opacity: 0;
  }

  .mk.on {
    opacity: 1;
  }

  .you .mk {
    color: #5cc6d8;
    font-weight: 600;
  }

  .you {
    color: #eef3f4;
  }

  .claude .mk {
    color: #e8eef0;
  }

  .tool {
    color: #7d8b91;
  }

  .tool .mk {
    color: #5d6a70;
  }

  .tx {
    min-width: 0;
  }

  .rest {
    opacity: 0;
  }

  .cur {
    display: inline-block;
    width: 0.55em;
    height: 1.05em;
    margin-bottom: -0.17em;
    background: #5cc6d8;
    animation: blink 1s steps(1) infinite;
  }

  .kept {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 6px;
    padding: 2px 8px 2px 6px;
    border-radius: var(--radius-full);
    border: 1px solid #2f5a63;
    background: rgba(92, 198, 216, 0.1);
    color: #8fd6e2;
    font-family: var(--font-sans);
    font-size: 11px;
    line-height: 1.5;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cur {
      animation: none;
    }
  }
</style>
