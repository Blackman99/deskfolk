<script lang="ts">
  import { flushSync, onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { base } from '$app/paths';
  import { docsPath } from '$lib/docs';
  import type { Dict, Lang } from '$lib/i18n';
  import { LATEST_RELEASE_URL } from '$lib/site';
  import CopyButton from '$lib/CopyButton.svelte';
  import VideoDialog from './VideoDialog.svelte';
  import clips from './clips.json';

  let { t, lang, version }: { t: Dict; lang: Lang; version: string } = $props();

  /**
   * The stage shows the real app: one clip per step, cut from the promo's recording
   * (scripts/film/clips.ts), and the four-pane screen it reaches as the first screen's still.
   * The recording is continuous, so each clip starts where the one before it ends.
   */
  type Clip = { seconds: number; speed: number };
  const SETS = clips.sets as Record<string, { steps: Clip[] }>;

  let scene = $state(0);
  /** Scrolling up into a step shows where it ends instead of playing it again. */
  let back = $state(false);
  /**
   * Reduced motion: a jump from the rail lands at once instead of scrolling there. The clips still
   * play as you scroll: they are what the section shows, and Windows reports reduced motion
   * whenever its animation effects are off.
   */
  let instant = $state(false);
  let dark = $state(false);
  /** Which picture is on the stage: 0 = the still, n = step n's clip. Lags `scene` until that clip can show. */
  let shown = $state(0);
  let playing = $state(false);
  let rootEl: HTMLElement | undefined = $state();
  let film: VideoDialog | undefined = $state();
  let enlarged: VideoDialog | undefined = $state();
  let stageWidth = $state(0);
  let innerWidth = $state(0);
  let innerHeight = $state(0);
  const videos: (HTMLVideoElement | undefined)[] = $state([]);
  /** Clips given their source: the current step and the next, and any loaded before. */
  const wanted = new SvelteSet<number>();
  /**
   * Steps whose clip has started playing on this visit. The rest wait on a frame without having
   * moved (autoplay refused, or reached by scrolling back up), so their button offers to play, not
   * to replay.
   */
  const played = new SvelteSet<number>();

  const set = $derived(`${lang}-${dark ? 'dark' : 'light'}`);
  const steps = $derived(SETS[set]?.steps ?? []);
  const calloutText = $derived(scene > 0 ? t.demo.steps[scene - 1]?.callout ?? null : null);
  const speed = $derived(shown > 0 ? steps[shown - 1]?.speed ?? 1 : 1);
  const media = (s: string, file: string) => `${base}/media/walkthrough/${s}/${file}`;

  /** The full film is the README's: 1920×1080, the English one recorded dark and the Chinese one light. */
  const FILM_GROUND: Record<Lang, string> = { zh: '#eef1f2', en: '#0f1416' };
  /** The step whose clip the stage is showing, for the enlarged view. */
  const onStage = $derived(shown > 0 && shown === scene ? shown : 0);
  /** The step the enlarged view holds; set as it opens, so a later theme change cannot swap it. */
  let enlargedStep = $state(1);
  /**
   * Enlarging is offered only where the dialog would show the clip clearly bigger than the stage
   * (the dialog's frame: the viewport less its gutters and header, at most the clip's own size).
   */
  const canEnlarge = $derived.by(() => {
    if (!stageWidth || !innerWidth) return false;
    const gutter = Math.min(48, Math.max(16, innerWidth * 0.04));
    const frame = Math.min(
      clips.width,
      innerWidth - 2 * gutter,
      ((innerHeight - 2 * gutter - 88) * clips.width) / clips.height
    );
    return frame >= stageWidth * 1.25;
  });

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  function setScene(next: number) {
    if (next === scene) return;
    back = next < scene;
    scene = next;
  }

  function jumpTo(n: number) {
    const el = rootEl?.querySelector<HTMLElement>(`[data-scene="${n}"]`);
    el?.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
  }

  function want(n: number) {
    if (n >= 1 && n <= steps.length) wanted.add(n);
  }

  /** Puts step n on the stage once its clip can show a frame: from the top, or at its end. */
  function enter(n: number) {
    want(n);
    want(n + 1);
    videos.forEach((v, i) => {
      if (v && i !== n - 1 && !v.paused) v.pause();
    });
    playing = false;
    if (n === 0) {
      shown = 0;
      return;
    }
    const v = videos[n - 1];
    if (!v || v.readyState < 2) return; // onloadeddata comes back here
    const reveal = () => {
      if (scene === n) shown = n;
    };
    if (back) {
      v.pause();
      const end = Math.max(0, v.duration - 0.05);
      if (Math.abs(v.currentTime - end) < 0.01) return reveal();
      v.addEventListener('seeked', reveal, { once: true });
      v.currentTime = end;
      return;
    }
    play(v, n);
  }

  function play(v: HTMLVideoElement, n: number) {
    v.muted = true;
    v.currentTime = 0;
    v.play().then(
      () => {
        played.add(n);
        if (scene !== n) return;
        shown = n;
        playing = true;
      },
      // Autoplay refused (a phone saving power): the first frame waits for the play button.
      () => {
        if (scene === n) shown = n;
      }
    );
  }

  function enlarge() {
    // Its source has to be in place before open() plays it, while the click still counts.
    flushSync(() => (enlargedStep = onStage));
    enlarged?.open();
  }

  function replay() {
    const v = videos[scene - 1];
    if (v && scene > 0) play(v, scene);
  }

  $effect(() => {
    const n = scene;
    untrack(() => enter(n));
  });

  onMount(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const root = document.documentElement;
    // The other theme's clips replace these; until the current one loads the still stands in,
    // and then it shows where the step ends.
    const readTheme = () => {
      const chosen = root.getAttribute('data-theme');
      const next = chosen ? chosen === 'dark' : scheme.matches;
      if (next === dark) return;
      dark = next;
      back = true;
      shown = 0;
      playing = false;
      wanted.clear();
      want(scene);
      want(scene + 1);
    };
    instant = motion.matches;
    readTheme();
    const onMotion = () => (instant = motion.matches);
    motion.addEventListener('change', onMotion);
    scheme.addEventListener('change', readTheme);
    const themeObserver = new MutationObserver(readTheme);
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    // Step 1's clip loads once the first screen has settled, so it is ready by the first scroll.
    const warm = setTimeout(() => want(1), 1500);

    // Adjacent steps can both touch the observation band; pick the one nearest the viewport centre.
    const els = rootEl ? Array.from(rootEl.querySelectorAll<HTMLElement>('[data-scene]')) : [];
    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        }
        if (visible.size === 0) return;
        const mid = window.innerHeight / 2;
        let best: Element | null = null;
        let bestDist = Infinity;
        for (const el of visible) {
          const r = el.getBoundingClientRect();
          const dist = Math.abs(r.top + r.height / 2 - mid);
          if (dist < bestDist) {
            bestDist = dist;
            best = el;
          }
        }
        if (best) setScene(Number(best.getAttribute('data-scene')));
      },
      { rootMargin: '-42% 0px -42% 0px', threshold: 0 }
    );
    els.forEach((el) => io.observe(el));

    return () => {
      clearTimeout(warm);
      motion.removeEventListener('change', onMotion);
      scheme.removeEventListener('change', readTheme);
      themeObserver.disconnect();
      io.disconnect();
    };
  });
</script>

<section
  class="walk"
  id="demo"
  bind:this={rootEl}
  style:--stage-max="min({clips.width}px, calc((100vh - var(--nav-h) - 132px) * {clips.width} / {clips.height}))"
>
  <div class="page walk-grid">
    <!-- Hero copy: scene 0 -->
    <div class="hero step" data-scene="0">
      <p class="wip">
        <span class="wip-mark"></span>
        <span>{t.hero.wipNote}</span>
        <span class="version mono">v{version}</span>
      </p>
      <h1 class="display">
        {#each t.hero.headlineLines as line, i}{#if i > 0}<br />{/if}<span>{line}</span>{/each}
      </h1>
      <p class="sub">{t.hero.subhead}</p>
      <div class="trust">
        <h2 id="trust-label">{t.hero.trustLabel}</h2>
        <ul aria-labelledby="trust-label">
          {#each t.hero.trust as item}
            <li><b>{item.label}</b> {item.body}</li>
          {/each}
        </ul>
      </div>
      <div class="ctas">
        <a class="btn btn-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">{t.hero.ctaPrimary}</a>
        <a class="btn btn-secondary" href="{base}/{lang}#quickstart">{t.hero.ctaSecondary}</a>
      </div>
      <div class="run">
        <span class="run-label">{t.hero.runLabel}</span>
        <code class="mono">{t.hero.runCommand}</code>
        <CopyButton text={t.hero.runCommand} label={t.hero.copy} doneLabel={t.hero.copied} compact />
      </div>
      <div class="hints">
        <p class="scroll-hint">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          {t.hero.scrollHint}
        </p>
        <button type="button" class="watch-link" onclick={() => film?.open()}>
          <span class="watch-dot" aria-hidden="true"><svg viewBox="0 0 16 16" width="8" height="8"><path d="M4 2.2v11.6L13.6 8z" fill="currentColor" /></svg></span>
          <span class="watch-label">{t.film.watchHint}</span>
          <span class="watch-time">{t.film.duration}</span>
        </button>
      </div>
    </div>

    <!-- Sticky stage -->
    <div class="stage-col">
      <div class="sticky">
        <div class="stage" style:aspect-ratio="{clips.width} / {clips.height}" bind:clientWidth={stageWidth}>
          <div
            class="still"
            class:shown={shown === 0}
            role="img"
            aria-label={t.demo.stillLabel}
            style:--still-light="url({media(`${lang}-light`, 'hero.jpg')})"
            style:--still-dark="url({media(`${lang}-dark`, 'hero.jpg')})"
          ></div>
          {#key set}
            {#each steps as _, i}
              <video
                bind:this={videos[i]}
                class="clip"
                class:shown={shown === i + 1}
                src={wanted.has(i + 1) ? media(set, `${pad(i + 1)}.mp4`) : undefined}
                preload={wanted.has(i + 1) ? 'auto' : 'none'}
                muted
                playsinline
                disablepictureinpicture
                aria-hidden="true"
                onloadeddata={() => {
                  if (scene === i + 1 && shown !== i + 1) enter(i + 1);
                }}
                onended={() => {
                  if (shown === i + 1) playing = false;
                }}
              ></video>
            {/each}
          {/key}
          {#if scene === 0 && shown === 0}
            <button type="button" class="watch" onclick={() => film?.open()}>
              <span class="watch-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.2v11.6L13.6 8z" fill="currentColor" /></svg></span>
              <span>{t.film.watch}</span>
              <span class="watch-time">{t.film.duration}</span>
            </button>
          {/if}
          {#if onStage && canEnlarge}
            <button type="button" class="enlarge" aria-label={t.demo.enlarge} onclick={enlarge}>
              <span class="enlarge-pill" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="12" height="12"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
                {t.demo.enlarge}
              </span>
            </button>
          {/if}
          {#if shown > 0 && shown === scene}
            {#if playing}
              {#if speed > 1}
                <span class="speed" aria-hidden="true">
                  <svg viewBox="0 0 26 18" width="15" height="11"><path d="M1 1l11 8-11 8zM13 1l11 8-11 8z" fill="currentColor" /></svg>{speed}×
                </span>
              {/if}
            {:else}
              <button type="button" class="replay" onclick={replay}>
                {#if played.has(scene)}
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.4-3.4M3.2 2.6v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  {t.demo.replay}
                {:else}
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M4 2.2v11.6L13.6 8z" fill="currentColor" /></svg>
                  {t.demo.play}
                {/if}
              </button>
            {/if}
          {/if}
        </div>
        <p class="caption" class:on={!!calloutText}>{calloutText ?? ''}</p>
        <ol class="rail" aria-label={t.demo.railLabel}>
          {#each t.demo.steps as step, i}
            <li>
              <button
                type="button"
                class="seg"
                class:on={scene === i + 1}
                class:done={scene > i + 1}
                aria-current={scene === i + 1 ? 'step' : undefined}
                title={step.title}
                onclick={() => jumpTo(i + 1)}
              >
                <span class="seg-num">{pad(i + 1)}</span>
                <span class="seg-title">{step.title}</span>
              </button>
            </li>
          {/each}
        </ol>
      </div>
    </div>

    <!-- Steps -->
    <div class="steps">
      <header class="demo-head">
        <h2 class="display">{t.demo.heading}</h2>
        <p>{t.demo.intro}</p>
      </header>
      {#each t.demo.steps as step, i}
        <article class="step" data-scene={i + 1} class:on={scene === i + 1}>
          <button type="button" class="step-link" onclick={() => jumpTo(i + 1)}>
            <span class="num display" aria-hidden="true">{pad(i + 1)}</span>
            <h3 class="display">{step.title}</h3>
          </button>
          <p>{step.body}</p>
          {#if step.link}
            <a class="text-link step-more" href="{base}/{lang}{docsPath(step.link.page)}">{step.link.label} →</a>
          {/if}
          <p class="sr-only">{step.callout}</p>
        </article>
      {/each}
    </div>
  </div>
</section>

<svelte:window bind:innerWidth bind:innerHeight />

<VideoDialog
  bind:this={film}
  src="{base}/media/deskfolk-{lang}.mp4"
  width={1920}
  height={1080}
  title={t.film.title}
  badge={t.film.duration}
  description={t.film.description}
  closeLabel={t.film.close}
  ground={FILM_GROUND[lang]}
/>

<VideoDialog
  bind:this={enlarged}
  src={media(set, `${pad(enlargedStep)}.mp4`)}
  width={clips.width}
  height={clips.height}
  title="{pad(enlargedStep)} · {t.demo.steps[enlargedStep - 1]?.title ?? ''}"
  description={t.demo.steps[enlargedStep - 1]?.callout}
  closeLabel={t.film.close}
  ground="var(--app-bg)"
  loop
/>

<style>
  .walk {
    padding-top: 12px;
  }

  .walk-grid {
    display: block;
  }

  /* ── Hero copy ── */
  .hero {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 22px;
    padding-block: 40px 28px;
  }

  .wip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 0;
    font-size: 14px;
    color: var(--ink-2);
  }

  .wip-mark {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--mustard);
    flex: none;
  }

  .version {
    font-size: 12px;
    color: var(--ink-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 1px 7px;
  }

  h1 {
    margin: 0;
    font-size: clamp(2rem, 4.2vw, 3rem);
    font-weight: 700;
    line-height: 1.22;
    color: var(--ink);
  }

  h1 span {
    display: inline-block;
  }

  :global([lang='en']) h1 {
    font-size: clamp(1.9rem, 3.6vw, 2.6rem);
    line-height: 1.15;
    letter-spacing: -0.015em;
  }

  .sub {
    margin: 0;
    font-size: 1.0625rem;
    line-height: 1.75;
    color: var(--ink-2);
    max-width: 38em;
    text-wrap: pretty;
  }

  /* Below the buttons on narrow screens, so they stay above the fold. */
  .trust {
    order: 1;
    max-width: 38em;
  }

  .hints {
    order: 2;
  }

  .trust h2 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.02em;
    color: var(--teal);
  }

  .trust ul {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .trust li {
    position: relative;
    padding-left: 18px;
    font-size: 15px;
    line-height: 1.6;
    color: var(--ink-2);
    text-wrap: pretty;
  }

  .trust li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.62em;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--teal);
  }

  .trust b {
    font-weight: 650;
    color: var(--ink);
  }

  .ctas {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .run {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    width: fit-content;
    max-width: 100%;
    padding: 8px 8px 8px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--paper);
    font-size: 14px;
  }

  .run-label {
    color: var(--ink-3);
  }

  .run code {
    color: var(--teal-2);
    font-size: 14px;
  }

  .hints {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 18px;
    margin-top: 4px;
  }

  .scroll-hint {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 13px;
    color: var(--ink-3);
  }

  .watch-link {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--teal);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .watch-link:hover {
    color: var(--teal-2);
  }

  .watch-label {
    text-decoration: underline;
    text-decoration-color: var(--teal-line);
    text-underline-offset: 4px;
    text-decoration-thickness: 1px;
  }

  .watch-link:hover .watch-label {
    text-decoration-color: currentColor;
  }

  .watch-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--teal);
    color: var(--paper);
  }

  .watch-dot svg {
    margin-left: 1px;
  }

  .watch-link .watch-time {
    font-weight: 500;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .scroll-hint svg {
    animation: nudge 1.8s ease-in-out infinite;
  }

  @keyframes nudge {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(3px); }
  }

  /* ── Stage ── */
  .stage-col {
    position: sticky;
    top: calc(var(--nav-h) + 8px);
    z-index: 3;
    background: var(--ground);
    padding-bottom: 8px;
  }

  .sticky {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .stage {
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-window);
    background: var(--app-bg);
  }

  /* Clips hold their last frame when they end; the one on the stage covers the rest. */
  .still,
  .clip {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
  }

  .still {
    background: var(--still-light) center / cover no-repeat;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .still {
      background-image: var(--still-dark);
    }
  }

  :global(:root[data-theme='dark']) .still {
    background-image: var(--still-dark);
  }

  .clip {
    display: block;
    object-fit: cover;
    pointer-events: none;
  }

  .still.shown,
  .clip.shown {
    opacity: 1;
    z-index: 1;
  }

  .speed,
  .replay {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 11px;
    border-radius: var(--radius-full);
    background: rgba(18, 28, 32, 0.72);
    color: #fff;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 6px 18px -8px rgba(0, 0, 0, 0.5);
  }

  .replay {
    border: 0;
    cursor: pointer;
    transition: background-color 160ms ease;
  }

  /* Over the whole clip, so a click anywhere on it opens it bigger; the pill says so. */
  .enlarge {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 10px;
    border: 0;
    border-radius: inherit;
    background: none;
    color: #fff;
    font: inherit;
    cursor: zoom-in;
  }

  .enlarge-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 11px;
    border-radius: var(--radius-full);
    background: rgba(18, 28, 32, 0.72);
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 6px 18px -8px rgba(0, 0, 0, 0.5);
    transition: background-color 160ms ease;
  }

  .enlarge:hover .enlarge-pill,
  .enlarge:focus-visible .enlarge-pill {
    background: rgba(18, 28, 32, 0.9);
  }

  /* The full film, over the first screen's still. */
  .watch {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 2;
    transform: translate(-50%, -50%);
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 0 18px 0 6px;
    border: 0;
    border-radius: var(--radius-full);
    background: rgba(18, 28, 32, 0.8);
    color: #fff;
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    box-shadow: 0 14px 36px -12px rgba(0, 0, 0, 0.55);
    transition: background-color 160ms ease;
  }

  .watch:hover {
    background: rgba(18, 28, 32, 0.92);
  }

  .watch-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #fff;
    color: #121c20;
    transition: transform 160ms ease;
  }

  .watch-icon svg {
    margin-left: 2px;
  }

  .watch:hover .watch-icon {
    transform: scale(1.06);
  }

  .watch .watch-time {
    font-size: 13px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.72);
    font-variant-numeric: tabular-nums;
  }

  .replay:hover {
    background: rgba(18, 28, 32, 0.88);
  }

  .caption {
    margin: 0;
    min-height: 1.5em;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink);
    padding-left: 12px;
    border-left: 3px solid transparent;
  }

  .caption.on {
    border-left-color: var(--teal);
  }

  /* Progress rail: one clickable chip per step; the active one shows its title. */
  .rail {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .seg {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--paper);
    color: var(--ink-3);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    transition: background-color 200ms ease, color 200ms ease, border-color 200ms ease;
  }

  .seg:hover {
    color: var(--ink);
    border-color: var(--teal-line);
  }

  .seg-num {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .seg-title {
    display: none;
    color: var(--ink);
    font-weight: 500;
    max-width: 22em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .seg.done {
    border-color: var(--teal-line);
    color: var(--teal);
  }

  .seg.on {
    background: var(--teal-tint);
    border-color: var(--teal);
    color: var(--teal-2);
  }

  .seg.on .seg-title {
    display: inline;
  }

  /* ── Steps ── */
  .steps {
    display: flex;
    flex-direction: column;
  }

  .demo-head {
    padding-block: 56px 12px;
  }

  .demo-head h2 {
    margin: 0 0 12px;
    font-size: clamp(1.5rem, 2.6vw, 2.1rem);
    line-height: 1.3;
    font-weight: 700;
    text-wrap: balance;
  }

  .demo-head p {
    margin: 0;
    color: var(--ink-2);
    max-width: 36em;
  }

  .step {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 10px;
    min-height: 62vh;
    padding-block: 32px;
    transition: opacity 240ms ease;
  }

  .steps .step:not(.on) {
    opacity: 0.55;
  }

  .step-link {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .step-link:hover h3 {
    color: var(--teal-2);
  }

  .num {
    font-size: 2.6rem;
    line-height: 1;
    font-weight: 400;
    color: var(--teal);
    font-variant-numeric: tabular-nums;
  }

  .step h3 {
    margin: 0;
    font-size: clamp(1.35rem, 2vw, 1.7rem);
    line-height: 1.3;
    font-weight: 700;
    color: var(--ink);
    text-wrap: balance;
    transition: color 160ms ease;
  }

  .step-more {
    align-self: flex-start;
    font-size: 15px;
  }

  .step p {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.75;
    max-width: 34em;
  }

  /* ── Two columns from 1024px ── */
  @media (min-width: 1024px) {
    .walk-grid {
      display: grid;
      grid-template-columns: minmax(340px, 9fr) minmax(0, 16fr);
      column-gap: 44px;
    }

    .hero {
      grid-column: 1;
      grid-row: 1;
      min-height: calc(100vh - var(--nav-h));
      padding-block: 0;
    }

    .trust {
      order: 0;
    }

    .stage-col {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: stretch;
      position: static;
      background: transparent;
      padding-bottom: 0;
    }

    /* As wide as the column, but never so tall that the rail drops below the fold. */
    .sticky {
      position: sticky;
      top: var(--nav-h);
      width: min(100%, var(--stage-max));
      height: calc(100vh - var(--nav-h));
      margin-inline: auto;
      justify-content: center;
      gap: 14px;
    }

    .steps {
      grid-column: 1;
      grid-row: 2;
      padding-bottom: 20vh;
    }

    .demo-head {
      padding-block: 24px 24px;
    }

    .step {
      min-height: 78vh;
    }
  }

  /* Wide screens: the copy keeps a reading width and the stage takes the rest (the homepage's
     page is wider than the docs' for it, see the [lang] layout). */
  @media (min-width: 1280px) {
    .walk-grid {
      grid-template-columns: clamp(400px, 24vw, 460px) minmax(0, 1fr);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .scroll-hint svg {
      animation: none;
    }

    .step,
    .seg,
    .step h3,
    .replay,
    .enlarge-pill,
    .watch,
    .watch-icon {
      transition: none;
    }

    .steps .step:not(.on) {
      opacity: 1;
    }
  }
</style>
