<script lang="ts">
  import type { Lang } from '$lib/i18n';
  import { onMount, untrack } from 'svelte';
  import Chapter from './Chapter.svelte';
  import ChapterRail from './ChapterRail.svelte';
  import Companion from './Companion.svelte';
  import { HOME } from './copy';
  import EndCta from './EndCta.svelte';
  import HomeHero from './HomeHero.svelte';
  import ModelsScene from './scenes/ModelsScene.svelte';
  import PanesScene from './scenes/PanesScene.svelte';
  import PreviewScene from './scenes/PreviewScene.svelte';
  import RemoteScene from './scenes/RemoteScene.svelte';
  import SessionsScene from './scenes/SessionsScene.svelte';
  import SpendScene from './scenes/SpendScene.svelte';
  import { provideStage, Stage } from './stage.svelte';
  import UsageBall from './UsageBall.svelte';

  /**
   * The home page: a first screen, then six chapters, each a feature that Mochi (you) and Pudding
   * (your Bot) act out as the reader scrolls, then the download again. The stage (stage.svelte.ts)
   * follows the scroll; the companions travel on their own layer when the page plays wide.
   */
  let { lang, version }: { lang: Lang; version: string } = $props();

  const stage = new Stage();
  provideStage(stage);
  // Set before the first render too: prerendering runs no effects.
  stage.copy = HOME[untrack(() => lang)];
  $effect.pre(() => {
    stage.copy = HOME[lang];
  });

  const copy = $derived(stage.copy);
  /** The usage widget turns up with the spend chapter and stays for the rest of the visit. */
  let spendSeen = $state(false);
  $effect(() => {
    if (stage.active === 'spend' || stage.active === 'end') spendSeen = true;
  });

  onMount(() => stage.start());
</script>

<div class="home" class:is-wide={stage.wide}>
  <HomeHero {lang} {version} />

  <Chapter id="models" index={0} copy={copy.chapters.models} {lang}>
    {#snippet scene({ p, active })}
      <ModelsScene copy={copy.scenes.models} {p} {active} {lang} />
    {/snippet}
  </Chapter>
  <Chapter id="sessions" index={1} copy={copy.chapters.sessions} {lang}>
    {#snippet scene({ p, active })}
      <SessionsScene copy={copy.scenes.sessions} {p} {active} {lang} />
    {/snippet}
  </Chapter>
  <Chapter id="preview" index={2} copy={copy.chapters.preview} {lang}>
    {#snippet scene({ p, active })}
      <PreviewScene copy={copy.scenes.preview} {p} {active} {lang} />
    {/snippet}
  </Chapter>
  <Chapter id="panes" index={3} copy={copy.chapters.panes} {lang}>
    {#snippet scene({ p, active })}
      <PanesScene copy={copy.scenes.panes} {p} {active} {lang} />
    {/snippet}
  </Chapter>
  <Chapter id="remote" index={4} copy={copy.chapters.remote} {lang}>
    {#snippet scene({ p, active })}
      <RemoteScene copy={copy.scenes.remote} {p} {active} {lang} />
    {/snippet}
  </Chapter>
  <Chapter id="spend" index={5} copy={copy.chapters.spend} {lang}>
    {#snippet scene({ p, active })}
      <SpendScene copy={copy.scenes.spend} {p} {active} {lang} />
    {/snippet}
  </Chapter>

  <EndCta {lang} {version} />
</div>

<UsageBall copy={copy.scenes.spend.usage} shown={spendSeen} />

{#if stage.wide}
  <Companion />
  <ChapterRail />
{/if}

<style>
  .home {
    overflow-x: clip;
  }
</style>
