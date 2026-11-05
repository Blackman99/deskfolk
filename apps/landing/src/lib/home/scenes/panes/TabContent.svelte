<script lang="ts">
  import { base } from '$app/paths';

  /**
   * A miniature of what a tab shows, drawn with bars and lines rather than words: a chat, a
   * poster, a terminal, a flow, a bar list. It fills the pane and clips what does not fit.
   */
  let { tab }: { tab: number } = $props();
</script>

<div class="mini" aria-hidden="true">
  {#if tab === 0}
    <div class="chat">
      <div class="bubble them" style:width="66%"><i style:width="88%"></i><i style:width="56%"></i></div>
      <div class="bubble me" style:width="44%"><i style:width="80%"></i></div>
      <div class="bubble them" style:width="58%"><i style:width="72%"></i><i style:width="42%"></i></div>
    </div>
  {:else if tab === 1}
    <div class="poster">
      <img src="{base}/media/sample-poster.jpg" alt="" draggable="false" />
      <div class="meta"><i style:width="60%"></i><i style:width="36%"></i></div>
    </div>
  {:else if tab === 2}
    <div class="term">
      <p><b>$</b> bun test</p>
      <p class="dim">12 pass · 0 fail</p>
      <p><b>$</b> git status</p>
      <p class="dim">nothing to commit</p>
      <p><b>$</b> <span class="caret"></span></p>
    </div>
  {:else if tab === 3}
    <svg class="flow" viewBox="0 0 120 84" preserveAspectRatio="xMidYMid meet">
      <path d="M32 22 H52 Q60 22 60 30 V34" class="edge" />
      <path d="M88 22 H72 Q60 22 60 30" class="edge" />
      <path d="M60 50 V58" class="edge" />
      <rect x="6" y="12" width="30" height="20" rx="5" class="node" />
      <rect x="84" y="12" width="30" height="20" rx="5" class="node" />
      <rect x="40" y="36" width="40" height="18" rx="5" class="node on" />
      <rect x="40" y="60" width="40" height="18" rx="5" class="node" />
    </svg>
  {:else}
    <div class="bars">
      {#each [86, 58, 40, 24] as w}
        <div class="row"><i class="lab"></i><i class="bar" style:width="{w}%"></i></div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mini {
    width: 100%;
    height: 100%;
    padding: 10px;
    overflow: hidden;
    box-sizing: border-box;
    color: var(--ink-3);
  }

  i {
    display: block;
    height: 5px;
    border-radius: 3px;
    background: var(--line);
  }

  .chat {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .bubble {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 10px;
    border-radius: 10px;
    box-sizing: border-box;
    border: 1px solid var(--line-2);
    background: var(--ground);
  }

  .bubble.me {
    align-self: flex-end;
    background: var(--teal-tint);
    border-color: var(--teal-line);
  }

  .bubble.me i {
    background: var(--teal-line);
  }

  .poster {
    display: flex;
    flex-direction: column;
    gap: 7px;
    height: 100%;
  }

  .poster img {
    flex: 1;
    min-height: 0;
    width: 100%;
    object-fit: cover;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: linear-gradient(135deg, var(--teal-tint), var(--ground-2));
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .term {
    height: calc(100% + 20px);
    margin: -10px;
    padding: 10px;
    background: var(--ground-2);
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1.6;
    color: var(--ink-2);
    white-space: nowrap;
  }

  .term p {
    margin: 0;
  }

  .term b {
    color: var(--teal);
    font-weight: 600;
  }

  .term .dim {
    color: var(--ink-3);
  }

  .caret {
    display: inline-block;
    width: 6px;
    height: 11px;
    vertical-align: -2px;
    background: var(--teal);
  }

  .flow {
    width: 100%;
    height: 100%;
  }

  .edge {
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1.2;
    opacity: 0.6;
  }

  .node {
    fill: var(--paper);
    stroke: var(--line);
    stroke-width: 1.2;
  }

  .node.on {
    fill: var(--teal-tint);
    stroke: var(--teal);
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding-top: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .lab {
    width: 22px;
    flex: none;
  }

  .bar {
    height: 9px;
    background: var(--teal);
    opacity: 0.75;
    border-radius: 2px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .caret {
      animation: blink 1.1s steps(2, jump-none) infinite;
    }
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
</style>
