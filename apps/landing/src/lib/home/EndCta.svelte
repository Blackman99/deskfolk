<script lang="ts">
  import { base } from '$app/paths';
  import { docsPath } from '$lib/docs';
  import type { Lang } from '$lib/i18n';
  import { LATEST_RELEASE_URL } from '$lib/site';
  import { useStage } from './stage.svelte';
  import Stand from './Stand.svelte';

  /** The last call: the tagline again and the download, with Mochi and Pudding cheering either side. */
  let { lang, version }: { lang: Lang; version: string } = $props();

  const stage = useStage();
  const copy = $derived(stage.copy);
  let el: HTMLElement | undefined = $state();

  $effect(() => {
    if (el) return stage.register('end', el, 'flow');
  });

  $effect(() => {
    if (stage.active !== 'end') return;
    stage.act('mochi', { pose: 'cheer', say: null, held: null, away: false, mirror: false });
    stage.act('pudding', { pose: 'cheer', say: null, held: null, away: false, mirror: true });
  });
</script>

<section class="end" bind:this={el} aria-labelledby="end-title">
  <div class="page inner">
    <h2 class="display title" id="end-title">{copy.end.title}</h2>
    <p class="body">{copy.end.body}</p>
    <div class="row">
      <Stand who="mochi" size={104} />
      <div class="actions">
        <a class="btn btn-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">{copy.end.download}</a>
        <a class="btn btn-secondary" href="{base}/{lang}{docsPath('docs')}">{copy.end.docs}</a>
      </div>
      <Stand who="pudding" size={104} />
    </div>
    <p class="fine"><span>v{version}</span><span>{copy.hero.note}</span></p>
  </div>
</section>

<style>
  .end {
    padding-block: clamp(80px, 14vh, 140px) clamp(64px, 10vh, 110px);
    border-top: 1px solid var(--line-2);
    background: radial-gradient(60% 80% at 50% 100%, var(--teal-tint), transparent 70%);
  }

  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .title {
    margin: 0;
    font-size: clamp(1.9rem, 4vw, 3.2rem);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.12;
    text-wrap: balance;
  }

  .body {
    margin: 14px 0 0;
    color: var(--ink-2);
    font-size: 17px;
  }

  .row {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: clamp(12px, 3vw, 36px);
    margin-top: 28px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
    padding-bottom: 18px;
  }

  .fine {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px 14px;
    margin: 18px 0 0;
    font-size: 13px;
    color: var(--ink-3);
  }

  @media (max-width: 560px) {
    .row {
      flex-wrap: wrap;
    }

    .actions {
      order: 3;
      width: 100%;
    }
  }
</style>
