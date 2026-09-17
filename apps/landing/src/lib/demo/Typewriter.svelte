<script lang="ts">
  /**
   * Reveals `text` character by character over roughly `duration` ms.
   * With `instant`, shows the full text immediately (reduced motion).
   */
  let {
    text,
    duration = 1800,
    instant = false,
    caret = false
  }: { text: string; duration?: number; instant?: boolean; caret?: boolean } = $props();

  let shown = $state('');

  $effect(() => {
    const full = text;
    if (instant || full.length === 0) {
      shown = full;
      return;
    }
    shown = '';
    const step = Math.max(12, Math.min(48, duration / Math.max(1, full.length)));
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      shown = full.slice(0, i);
      if (i >= full.length) clearInterval(id);
    }, step);
    return () => clearInterval(id);
  });

  const done = $derived(shown.length >= text.length);
</script>

<span class="tw">{shown}{#if caret && !done}<span class="caret" aria-hidden="true"></span>{/if}</span>

<style>
  .tw {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .caret {
    display: inline-block;
    width: 2px;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.15em;
    background: currentColor;
    animation: blink 0.9s steps(2, end) infinite;
  }

  @keyframes blink {
    to {
      opacity: 0;
    }
  }
</style>
