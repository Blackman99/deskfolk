<script lang="ts">
  import type { SceneCopy } from '../../copy';
  import { useStage } from '../../stage.svelte';

  /**
   * The scene's small chat: the messages you sent your Bots, each one the reason for some of the
   * ledger's calls. The one a receipt row points at is flashed and scrolled into view inside this box.
   */
  let {
    copy,
    shown,
    targets,
    selected
  }: {
    copy: SceneCopy['spend'];
    /** Per message: whether it has been sent yet. */
    shown: boolean[];
    /** Per message: the Bot it was sent to. */
    targets: ('producer' | 'reviewer')[];
    /** The message to point out, or -1. */
    selected: number;
  } = $props();

  const stage = useStage();
  let box: HTMLElement | undefined = $state();

  $effect(() => {
    const m = selected;
    if (m < 0 || !box) return;
    const el = box.querySelector<HTMLElement>(`[data-msg="${m}"]`);
    if (!el || box.scrollHeight <= box.clientHeight) return;
    const top = Math.max(0, el.offsetTop - (box.clientHeight - el.offsetHeight) / 2);
    box.scrollTo({ top, behavior: stage.reduced ? 'auto' : 'smooth' });
  });
</script>

<div class="chat" data-chat bind:this={box} role="log" aria-label={copy.title}>
  {#each copy.messages as text, i (i)}
    <div class="msg" class:shown={shown[i]} class:sel={selected === i} data-msg={i} aria-hidden={!shown[i]}>
      <span class="to">→ {copy.bots[targets[i]]}</span>
      <p>{text}</p>
    </div>
  {/each}
</div>

<style>
  .chat {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    max-height: 100%;
    overflow-y: auto;
    padding: 4px 6px 4px 2px;
    scrollbar-width: thin;
  }

  .msg {
    position: relative;
    align-self: flex-end;
    max-width: 100%;
    padding: 7px 11px 8px;
    border: 1px solid var(--teal-line);
    border-radius: var(--radius-lg) var(--radius-lg) var(--radius-xs) var(--radius-lg);
    background: var(--teal-tint);
    color: var(--ink);
    font-size: 12.5px;
    line-height: 1.45;
    opacity: 0;
    transform: translateY(6px);
    transition:
      opacity 0.3s,
      transform 0.3s,
      border-color 0.2s;
  }

  .msg.shown {
    opacity: 1;
    transform: none;
  }

  .msg.sel {
    border-color: var(--teal);
  }

  /* A ring that grows out of the message and fades: the flash when a row points at it. */
  .msg.sel::after {
    content: '';
    position: absolute;
    inset: -3px;
    border: 2px solid var(--teal);
    border-radius: inherit;
    pointer-events: none;
    animation: flash 0.9s ease-out forwards;
  }

  @keyframes flash {
    from {
      opacity: 0.85;
      transform: scale(0.97);
    }
    to {
      opacity: 0;
      transform: scale(1.06);
    }
  }

  .to {
    display: block;
    margin-bottom: 1px;
    color: var(--teal-2);
    font-size: 10.5px;
    font-weight: 600;
  }

  p {
    margin: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .msg {
      transition: none;
    }

    .msg.sel::after {
      animation: none;
      opacity: 0;
    }
  }
</style>
