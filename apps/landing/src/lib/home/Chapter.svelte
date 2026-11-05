<script lang="ts">
  import { base } from '$app/paths';
  import { docsPath } from '$lib/docs';
  import type { Lang } from '$lib/i18n';
  import type { Snippet } from 'svelte';
  import type { ChapterCopy, ChapterId } from './copy';
  import { useStage } from './stage.svelte';

  /**
   * One feature of the home page: its words on the left and its scene on the right. Played wide,
   * the section is `screens` screens tall and its stage stays pinned under the nav while the reader
   * scrolls through it; the scene gets how far that is (`p`, 0 to 1) and whether the reader is on
   * this chapter. Inline, the section is as tall as its content and the scene plays as it passes.
   */
  let {
    id,
    index,
    copy,
    lang,
    screens = 2.4,
    scene
  }: {
    id: ChapterId;
    index: number;
    copy: ChapterCopy;
    lang: Lang;
    screens?: number;
    scene: Snippet<[{ p: number; active: boolean }]>;
  } = $props();

  const stage = useStage();
  let el: HTMLElement | undefined = $state();

  $effect(() => {
    if (el) return stage.register(id, el, 'sticky');
  });

  const p = $derived(stage.progress[id] ?? 0);
  const active = $derived(stage.active === id);
  const number = $derived(String(index + 1).padStart(2, '0'));
</script>

<section
  class="chapter"
  class:is-active={active}
  {id}
  bind:this={el}
  style:--screens={screens}
  aria-labelledby="{id}-title"
>
  <div class="stage">
    <div class="page grid">
      <div class="copy">
        <p class="kicker"><span class="num">{number}</span>{copy.kicker}</p>
        <h2 class="display title" id="{id}-title">{copy.title}</h2>
        <p class="body">{copy.body}</p>
        <ul class="facts">
          {#each copy.facts as fact}
            <li>{fact}</li>
          {/each}
        </ul>
        <a class="text-link more" href="{base}/{lang}{docsPath(copy.link.page)}">{copy.link.label}</a>
        <span class="progress" aria-hidden="true"><i style:transform="scaleX({p})"></i></span>
      </div>
      <div class="scene">
        {@render scene({ p, active })}
      </div>
    </div>
  </div>
</section>

<style>
  .chapter {
    position: relative;
    padding-block: clamp(56px, 9vh, 96px);
    scroll-margin-top: var(--nav-h);
  }

  .chapter + :global(.chapter) {
    border-top: 1px solid var(--line-2);
  }

  .grid {
    display: grid;
    gap: 36px;
    grid-template-columns: minmax(0, 1fr);
  }

  .kicker {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0 0 12px;
    font-size: 14px;
    font-weight: 650;
    color: var(--teal);
    letter-spacing: 0.02em;
  }

  .num {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-3);
  }

  .title {
    margin: 0;
    font-size: clamp(1.7rem, 2.6vw, 2.5rem);
    font-weight: 750;
    line-height: 1.18;
    text-wrap: balance;
  }

  .body {
    margin: 16px 0 0;
    font-size: 16.5px;
    color: var(--ink-2);
    line-height: 1.7;
  }

  .facts {
    margin: 18px 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 8px;
  }

  .facts li {
    position: relative;
    padding-left: 18px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ink-3);
  }

  .facts li::before {
    content: '';
    position: absolute;
    left: 2px;
    top: 0.62em;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--teal-line);
  }

  .more {
    display: inline-block;
    margin-top: 18px;
    font-size: 14px;
  }

  .progress {
    display: none;
  }

  .progress i {
    display: block;
    height: 100%;
    background: var(--teal);
    transform-origin: left;
  }

  .scene {
    position: relative;
    min-width: 0;
    container-type: inline-size;
  }

  /* Wide, the section is several screens tall and its stage stays pinned under the nav. A media query
     rather than the stage's own flag, so the prerendered page is laid out the same before it starts. */
  @media (min-width: 1000px) and (prefers-reduced-motion: no-preference) {
    .chapter {
      height: calc(var(--screens) * 100svh);
      padding-block: 0;
    }

    .stage {
      position: sticky;
      top: var(--nav-h);
      height: calc(100svh - var(--nav-h));
      display: flex;
      align-items: center;
    }

    .grid {
      grid-template-columns: minmax(300px, 0.78fr) minmax(0, 1.22fr);
      gap: clamp(36px, 4vw, 72px);
      align-items: center;
    }

    .progress {
      display: block;
      margin-top: 26px;
      width: 120px;
      height: 3px;
      border-radius: 2px;
      background: var(--line);
      overflow: hidden;
    }

    .scene {
      height: min(620px, calc(100svh - var(--nav-h) - 80px));
    }
  }

  /* Short laptop screens: the facts fold into the body's rhythm. */
  @media (min-width: 1000px) and (prefers-reduced-motion: no-preference) and (max-height: 760px) {
    .facts li {
      font-size: 13px;
    }

    .body {
      font-size: 15.5px;
    }
  }
</style>
