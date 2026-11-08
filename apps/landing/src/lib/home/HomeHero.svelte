<script lang="ts">
  import { base } from '$app/paths';
  import VideoDialog from '$lib/demo/VideoDialog.svelte';
  import { DICT, type Lang } from '$lib/i18n';
  import { LATEST_RELEASE_URL } from '$lib/site';
  import { CHAPTER_IDS } from './copy';
  import { useStage } from './stage.svelte';
  import Stand from './Stand.svelte';

  /**
   * The first screen: what Deskfolk is in one line (the repository's description), the tagline, the download, and Mochi and Pudding at their desk, Pudding
   * typing away and saying what the page goes on to show. The six chapters are listed under the
   * tagline as links down the page; the 30-second film is one button away for whoever wants it.
   */
  let { lang, version }: { lang: Lang; version: string } = $props();

  const stage = useStage();
  const copy = $derived(stage.copy);
  const descriptor = $derived(DICT[lang].hero.descriptor);
  const headline = $derived(DICT[lang].hero.headlineLines);
  let el: HTMLElement | undefined = $state();
  let film: VideoDialog | undefined = $state();
  let line = $state(0);

  $effect(() => {
    if (el) return stage.register('hero', el, 'flow');
  });

  const onHero = $derived(stage.active === 'hero');

  // Mochi waves hello with its coffee, then stands by; Pudding types and says what is coming.
  $effect(() => {
    if (!onHero) return;
    stage.act('mochi', { pose: 'wave', say: null, held: 'mug', away: false, mirror: false });
    const calm = setTimeout(() => stage.act('mochi', { pose: 'idle' }), 2600);
    return () => clearTimeout(calm);
  });

  $effect(() => {
    if (!onHero) return;
    stage.act('pudding', { pose: 'work', say: copy.hero.deskSays[line], held: null, away: false, mirror: true });
  });

  $effect(() => {
    if (!onHero || stage.reduced) return;
    const says = copy.hero.deskSays.length;
    const timer = setInterval(() => (line = (line + 1) % says), 2800);
    return () => clearInterval(timer);
  });
</script>

<section class="hero" bind:this={el} aria-labelledby="hero-title">
  <div class="page grid">
    <div class="copy">
      <p class="descriptor">{descriptor}</p>
      <h1 class="display headline" id="hero-title">
        {#each headline as l}
          <span>{l}</span>
        {/each}
      </h1>
      <p class="lead">{copy.hero.lead}</p>
      <div class="actions">
        <a class="btn btn-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">{copy.hero.download}</a>
        <button type="button" class="film" onclick={() => film?.open()}>
          <img src="{base}/media/reel-thumb.jpg" alt="" width="64" height="36" />
          <span>{copy.hero.film}</span>
          <span class="len">{copy.hero.filmDuration}</span>
        </button>
      </div>
      <p class="fine"><span>v{version}</span><span>{copy.hero.note}</span></p>
    </div>

    <div class="desk-wrap" aria-hidden="true">
      <div class="desk">
        <div class="spot mochi"><Stand who="mochi" size={128} /></div>
        <div class="laptop">
          <span class="lid"><i></i><i></i><i></i></span>
          <span class="base"></span>
        </div>
        <div class="spot pudding"><Stand who="pudding" size={128} /></div>
        <span class="surface"></span>
      </div>
    </div>
  </div>

  <nav class="page toc" aria-label={copy.hero.tocLabel}>
    <span class="toc-label">{copy.hero.tocLabel}</span>
    <ol>
      {#each CHAPTER_IDS as id, i}
        <li>
          <a href="#{id}"><span class="num">{String(i + 1).padStart(2, '0')}</span>{copy.chapters[id].kicker}</a>
        </li>
      {/each}
    </ol>
  </nav>

  <a class="hint" href="#{CHAPTER_IDS[0]}" aria-label={copy.hero.scrollHint}>
    <span>{copy.hero.scrollHint}</span>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5" /></svg>
  </a>
</section>

<VideoDialog
  bind:this={film}
  src="{base}/media/deskfolk-reel-{lang}.mp4"
  width={1920}
  height={1080}
  title={copy.hero.filmTitle}
  badge={copy.hero.filmDuration}
  description={copy.hero.filmDescription}
  closeLabel={copy.hero.close}
  ground="#eef1f2"
/>

<style>
  .hero {
    position: relative;
    min-height: calc(100svh - var(--nav-h));
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: clamp(28px, 5vh, 56px);
    padding-block: clamp(36px, 7vh, 80px) 88px;
  }

  .grid {
    display: grid;
    gap: 40px;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
  }

  @media (min-width: 1000px) {
    .grid {
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
      gap: clamp(40px, 5vw, 96px);
    }
  }

  .copy {
    container-type: inline-size;
    --fit: 15cqi;
  }

  .copy:lang(en) {
    --fit: 10.6cqi;
  }

  .descriptor {
    margin: 0 0 14px;
    font-size: clamp(14px, 1.15vw, 16px);
    font-weight: 650;
    color: var(--teal-2);
    line-height: 1.4;
  }

  .headline {
    margin: 0;
    display: flex;
    flex-direction: column;
    font-size: min(var(--fit), 5.4rem);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.06;
  }

  .headline span {
    white-space: nowrap;
  }

  .headline span:last-child {
    color: var(--teal);
  }

  .lead {
    margin: 22px 0 0;
    max-width: 34em;
    font-size: clamp(16px, 1.3vw, 18.5px);
    color: var(--ink-2);
    line-height: 1.7;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 28px;
  }

  .film {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 4px 14px 4px 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--paper);
    color: var(--ink);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 160ms ease, color 160ms ease;
  }

  .film:hover {
    border-color: var(--teal);
    color: var(--teal-2);
  }

  .film:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .film img {
    width: 64px;
    height: 36px;
    object-fit: cover;
    border-radius: var(--radius-sm);
  }

  .len {
    font-weight: 500;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .fine {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 14px 0 0;
    font-size: 13px;
    color: var(--ink-3);
  }

  /* ── The desk ── */
  .desk-wrap {
    display: flex;
    justify-content: center;
  }

  .desk {
    position: relative;
    width: min(100%, 520px);
    aspect-ratio: 520 / 300;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 4%;
    padding-bottom: 12%;
    isolation: isolate;
  }

  .surface {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 15%;
    border-radius: 18px 18px 26px 26px;
    background: linear-gradient(var(--paper), var(--ground-2));
    border: 1px solid var(--line);
    box-shadow: var(--shadow-float);
    z-index: -1;
  }

  .spot {
    position: relative;
    margin-bottom: -2%;
  }

  .laptop {
    position: relative;
    width: 30%;
    aspect-ratio: 150 / 100;
    margin-bottom: -1%;
  }

  .lid {
    position: absolute;
    left: 6%;
    right: 6%;
    top: 0;
    bottom: 12%;
    border-radius: 8px 8px 2px 2px;
    background: #1d2529;
    border: 3px solid #2c373c;
    display: flex;
    flex-direction: column;
    gap: 9%;
    padding: 12% 12%;
    box-sizing: border-box;
  }

  .lid i {
    display: block;
    height: 9%;
    border-radius: 3px;
    background: var(--teal);
    opacity: 0.85;
    animation: type-line 2.4s steps(6) infinite;
    transform-origin: left;
  }

  .lid i:nth-child(2) {
    width: 70%;
    animation-delay: -0.8s;
    opacity: 0.55;
  }

  .lid i:nth-child(3) {
    width: 45%;
    animation-delay: -1.6s;
    opacity: 0.4;
  }

  .base {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 12%;
    border-radius: 3px 3px 10px 10px;
    background: #c3ccd0;
  }

  /* ── The six chapters ── */
  .toc {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 18px;
  }

  .toc-label {
    font-size: 13px;
    font-weight: 650;
    color: var(--ink-3);
  }

  .toc ol {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .toc a {
    display: inline-flex;
    align-items: baseline;
    gap: 7px;
    padding: 7px 13px;
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
    background: var(--paper);
    color: var(--ink-2);
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    transition: border-color 160ms ease, color 160ms ease, background-color 160ms ease;
  }

  .toc a:hover {
    border-color: var(--teal);
    color: var(--teal-2);
    background: var(--teal-tint);
  }

  .num {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-3);
  }

  .hint {
    position: absolute;
    left: 50%;
    bottom: 22px;
    translate: -50% 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    color: var(--ink-3);
    font-size: 12px;
    text-decoration: none;
  }

  .hint svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    animation: nudge 1.8s ease-in-out infinite;
  }

  @keyframes nudge {
    0%,
    100% {
      translate: 0 0;
    }
    50% {
      translate: 0 5px;
    }
  }

  @keyframes type-line {
    from {
      scale: 0.2 1;
    }
    to {
      scale: 1 1;
    }
  }

  @media (max-width: 999px) {
    .hint {
      display: none;
    }

    .hero {
      padding-bottom: 48px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hint svg,
    .lid i {
      animation: none;
    }
  }
</style>
