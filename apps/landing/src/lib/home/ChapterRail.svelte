<script lang="ts">
  import { CHAPTER_IDS } from './copy';
  import { useStage } from './stage.svelte';

  /** The six chapters down the left edge while the page plays wide: where you are, and a jump to any. */
  const stage = useStage();
  const shown = $derived((CHAPTER_IDS as readonly string[]).includes(stage.active));
</script>

<nav class="rail" class:is-shown={shown} aria-label={stage.copy.rail}>
  <ol>
    {#each CHAPTER_IDS as id, i}
      <li>
        <a href="#{id}" class:is-on={stage.active === id} aria-current={stage.active === id ? 'step' : undefined}>
          <span class="dot" style:--p={stage.progress[id] ?? 0}></span>
          <span class="label"><span class="num">{String(i + 1).padStart(2, '0')}</span>{stage.copy.chapters[id].kicker}</span>
        </a>
      </li>
    {/each}
  </ol>
</nav>

<style>
  .rail {
    position: fixed;
    left: 18px;
    top: 50%;
    z-index: 16;
    translate: -8px -50%;
    opacity: 0;
    pointer-events: none;
    transition: opacity 240ms ease, translate 240ms ease;
  }

  .rail.is-shown {
    opacity: 1;
    translate: 0 -50%;
    pointer-events: auto;
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 6px;
  }

  a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    color: var(--ink-3);
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
  }

  .dot {
    position: relative;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--line);
    flex: none;
  }

  .is-on .dot {
    background: conic-gradient(var(--teal) calc(var(--p) * 1turn), var(--teal-line) 0);
    scale: 1.5;
  }

  .label {
    display: inline-flex;
    gap: 6px;
    opacity: 0;
    translate: -4px 0;
    transition: opacity 160ms ease, translate 160ms ease;
    white-space: nowrap;
    background: color-mix(in srgb, var(--ground) 88%, transparent);
    padding: 2px 6px;
    border-radius: var(--radius-xs);
  }

  .num {
    font-family: var(--font-mono);
    font-size: 10.5px;
  }

  .rail:hover .label,
  .rail:focus-within .label {
    opacity: 1;
    translate: 0 0;
  }

  /* The current chapter's name shows on its own only where the gutter has room for it. */
  @media (min-width: 1680px) {
    .is-on .label {
      opacity: 1;
      translate: 0 0;
    }
  }

  .is-on {
    color: var(--teal);
  }

</style>
