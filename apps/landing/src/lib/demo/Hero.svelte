<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import type { Dict, Lang } from '$lib/i18n';
  import { LATEST_RELEASE_URL } from '$lib/site';
  import VideoDialog from './VideoDialog.svelte';
  import clips from './clips.json';

  let { t, lang, version }: { t: Dict; lang: Lang; version: string } = $props();

  /**
   * The headline is the player: each of its three beats is one clip of the real app, cut from the
   * promo's recording (scripts/film/clips.ts). The beat being shown is lit and fills as its clip
   * plays; at a clip's end the next beat takes over, round and round.
   */
  const BEAT_CLIPS = ['04.mp4', '06.mp4', '09.mp4'];
  /** The films are 1920×1080; the mascot one is drawn light, the tour per language. */
  const FILM_GROUND: Record<Lang, string> = { zh: '#eef1f2', en: '#0f1416' };

  let beat = $state(0);
  let progress = $state(0);
  /** A clip has shown a frame on the stage; until then the still stands in. */
  let live = $state(false);
  let dark = $state(false);
  let reduced = $state(false);
  let visible = true;
  let stageEl: HTMLElement | undefined = $state();
  let film: VideoDialog | undefined = $state();
  let tour: VideoDialog | undefined = $state();
  const videos: (HTMLVideoElement | undefined)[] = $state([]);

  const set = $derived(`${lang}-${dark ? 'dark' : 'light'}`);
  const media = (file: string) => `${base}/media/walkthrough/${set}/${file}`;
  const beats = $derived(t.home.beats);

  function play(n: number) {
    videos.forEach((v, i) => {
      if (v && i !== n && !v.paused) v.pause();
    });
    const v = videos[n];
    if (!v) return;
    v.muted = true;
    v.currentTime = 0;
    progress = 0;
    v.play().then(
      () => {
        if (beat === n) live = true;
      },
      // Autoplay refused (a phone saving power): the still stays until a beat is pressed.
      () => {}
    );
  }

  function choose(n: number) {
    beat = n;
    play(n);
  }

  function ended(n: number) {
    if (n !== beat) return;
    progress = 1;
    if (reduced) return;
    choose((n + 1) % BEAT_CLIPS.length);
  }

  function tick(n: number) {
    const v = videos[n];
    if (n === beat && v && v.duration) progress = v.currentTime / v.duration;
  }

  onMount(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const root = document.documentElement;
    reduced = motion.matches;
    const readTheme = () => {
      const chosen = root.getAttribute('data-theme');
      const next = chosen ? chosen === 'dark' : scheme.matches;
      if (next === dark) return;
      dark = next;
      live = false;
      // The other set's clips load in place of these; start the current beat over on them.
      queueMicrotask(() => {
        if (!reduced) play(beat);
      });
    };
    readTheme();
    const onMotion = () => (reduced = motion.matches);
    motion.addEventListener('change', onMotion);
    scheme.addEventListener('change', readTheme);
    const themeObserver = new MutationObserver(readTheme);
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    // Off screen the loop rests, and picks up where it was when the stage comes back.
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      const v = videos[beat];
      if (!v || reduced) return;
      if (visible && v.paused && live) v.play().catch(() => {});
      else if (!visible && !v.paused) v.pause();
    });
    if (stageEl) io.observe(stageEl);

    if (!reduced) play(0);

    // rAF keeps the bar smooth; timeupdate alone steps about four times a second.
    let raf = 0;
    const frame = () => {
      tick(beat);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      motion.removeEventListener('change', onMotion);
      scheme.removeEventListener('change', readTheme);
      themeObserver.disconnect();
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  });
</script>

<section class="hero" id="demo" aria-label={t.home.stageLabel}>
  <div class="page hero-grid">
    <div class="copy">
      <h1 class="display beats">
        {#each beats as b, i}
          <button
            type="button"
            class="beat"
            class:on={beat === i}
            aria-pressed={beat === i}
            onclick={() => choose(i)}
          >
            <span class="line">{b.line}</span>
            <span class="bar" aria-hidden="true"><i style:transform="scaleX({beat === i ? progress : 0})"></i></span>
          </button>
        {/each}
      </h1>

      <div class="actions">
        <a class="btn btn-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">{t.home.download}</a>
        <button type="button" class="film" onclick={() => film?.open()}>
          <img src="{base}/media/mascots-thumb.jpg" alt="" width="64" height="36" />
          <span>{t.home.film}</span>
          <span class="len">{t.home.filmDuration}</span>
        </button>
      </div>
      <p class="fine">
        <span>v{version}</span>
        <span>{t.home.note}</span>
        <button type="button" class="text-link tour" onclick={() => tour?.open()}>{t.home.tour} {t.home.tourDuration}</button>
      </p>
    </div>

    <figure class="stage" bind:this={stageEl}>
      <div class="window">
        <img
          class="still"
          class:gone={live}
          src={media('hero.jpg')}
          alt={t.demo.stillLabel}
          width={clips.width}
          height={clips.height}
        />
        {#each BEAT_CLIPS as file, i (`${set}/${file}`)}
          <video
            bind:this={videos[i]}
            class:shown={live && beat === i}
            src={media(file)}
            muted
            playsinline
            preload={i === beat ? 'auto' : 'metadata'}
            aria-hidden="true"
            tabindex="-1"
            onended={() => ended(i)}
            onplaying={() => {
              if (beat === i) live = true;
            }}
          ></video>
        {/each}
      </div>
      <figcaption aria-live="polite">{beats[beat].caption}</figcaption>
    </figure>
  </div>
</section>

<VideoDialog
  bind:this={film}
  src="{base}/media/deskfolk-mascots-{lang}.mp4"
  width={1920}
  height={1080}
  title={t.home.filmTitle}
  badge={t.home.filmDuration}
  description={t.home.filmDescription}
  closeLabel={t.home.close}
  ground="#eef1f2"
/>
<VideoDialog
  bind:this={tour}
  src="{base}/media/deskfolk-promo-{lang}.mp4"
  width={1920}
  height={1080}
  title={t.home.tourTitle}
  badge={t.home.tourDuration}
  closeLabel={t.home.close}
  ground={FILM_GROUND[lang]}
/>

<style>
  .hero {
    min-height: calc(100svh - var(--nav-h));
    display: flex;
    align-items: center;
    padding-block: clamp(28px, 5vh, 64px);
    overflow: hidden;
  }

  .hero-grid {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
    align-items: center;
  }

  /* ── The headline, three beats ── */
  /* Each beat stays one line and sizes to the column: the longest line is about 6em in Chinese
     and 9em in English. */
  .copy {
    container-type: inline-size;
    --fit: 16.8cqi;
  }

  .copy:lang(en) {
    --fit: 12.3cqi;
  }

  .beats {
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.14em;
    font-size: min(var(--fit), 4.2rem);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.04;
  }

  .beat {
    all: unset;
    position: relative;
    cursor: pointer;
    padding-bottom: 0.16em;
    color: color-mix(in srgb, var(--ink) 24%, transparent);
    transition: color 360ms ease;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .beat:hover {
    color: color-mix(in srgb, var(--ink) 55%, transparent);
  }

  .beat.on {
    color: var(--ink);
  }

  .beat:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 6px;
  }

  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
  }

  .beat.on .bar {
    background: var(--line);
  }

  .bar i {
    display: block;
    height: 100%;
    background: var(--teal);
    transform-origin: left;
  }

  /* ── Actions ── */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: clamp(22px, 4vh, 40px);
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

  .tour {
    all: unset;
    cursor: pointer;
    color: var(--teal);
    text-decoration: underline;
    text-decoration-color: var(--teal-line);
    text-underline-offset: 3px;
  }

  .tour:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  /* ── The stage: the app's own window ── */
  .stage {
    margin: 0;
    min-width: 0;
  }

  .window {
    position: relative;
    aspect-ratio: 1480 / 924;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--app-bg);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-window);
  }

  .window img,
  .window video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .window video {
    opacity: 0;
  }

  .window video.shown {
    opacity: 1;
  }

  .still.gone {
    visibility: hidden;
  }

  figcaption {
    margin-top: 14px;
    min-height: 1.5em;
    font-size: 15px;
    color: var(--ink-2);
  }

  @media (min-width: 1100px) {
    .hero-grid {
      grid-template-columns: minmax(340px, 0.62fr) minmax(0, 1.38fr);
      gap: clamp(40px, 4vw, 80px);
    }

    .beats {
      font-size: min(var(--fit), 6rem);
    }

    /* Tall enough for the caption to stay on the first screen. */
    .stage {
      max-width: min(1480px, calc((100svh - var(--nav-h) - 130px) * 1480 / 924));
      justify-self: end;
      width: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .beat {
      transition: none;
    }
  }
</style>
