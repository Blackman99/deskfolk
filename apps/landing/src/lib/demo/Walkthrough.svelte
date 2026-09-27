<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { base } from '$app/paths';
  import { docsPath } from '$lib/docs';
  import type { Dict, Lang } from '$lib/i18n';
  import { LATEST_RELEASE_URL } from '$lib/site';
  import CopyButton from '$lib/CopyButton.svelte';
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
  let instant = $state(false);
  let dark = $state(false);
  /** Which picture is on the stage: 0 = the still, n = step n's clip. Lags `scene` until that clip can show. */
  let shown = $state(0);
  let playing = $state(false);
  let rootEl: HTMLElement | undefined = $state();
  const videos: (HTMLVideoElement | undefined)[] = $state([]);
  /** Clips given their source: the current step and the next, and any loaded before. */
  const wanted = new SvelteSet<number>();

  const set = $derived(`${lang}-${dark ? 'dark' : 'light'}`);
  const steps = $derived(SETS[set]?.steps ?? []);
  const calloutText = $derived(scene > 0 ? t.demo.steps[scene - 1]?.callout ?? null : null);
  const speed = $derived(shown > 0 ? steps[shown - 1]?.speed ?? 1 : 1);
  const media = (s: string, file: string) => `${base}/media/walkthrough/${s}/${file}`;

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
    if (back || instant) {
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

<section class="walk" id="demo" bind:this={rootEl}>
  <div class="page walk-grid">
    <!-- Hero copy: scene 0 -->
    <div class="hero step" data-scene="0">
      <p class="wip">
        <span class="wip-mark"></span>
        <span>{t.hero.wipNote}</span>
        <span class="version mono">v{version}</span>
      </p>
      <h1 class="serif">
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
      <p class="scroll-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        {t.hero.scrollHint}
      </p>
    </div>

    <!-- Sticky stage -->
    <div class="stage-col">
      <div class="sticky">
        <div class="stage" style:aspect-ratio="{clips.width} / {clips.height}">
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
          {#if shown > 0 && shown === scene}
            {#if playing}
              {#if speed > 1}
                <span class="speed" aria-hidden="true">
                  <svg viewBox="0 0 26 18" width="15" height="11"><path d="M1 1l11 8-11 8zM13 1l11 8-11 8z" fill="currentColor" /></svg>{speed}×
                </span>
              {/if}
            {:else}
              <button type="button" class="replay" onclick={replay}>
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.4-3.4M3.2 2.6v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
                {t.demo.replay}
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
        <h2 class="serif">{t.demo.heading}</h2>
        <p>{t.demo.intro}</p>
      </header>
      {#each t.demo.steps as step, i}
        <article class="step" data-scene={i + 1} class:on={scene === i + 1}>
          <button type="button" class="step-link" onclick={() => jumpTo(i + 1)}>
            <span class="num serif" aria-hidden="true">{pad(i + 1)}</span>
            <h3 class="serif">{step.title}</h3>
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
    font-size: 13.5px;
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
    border-radius: 6px;
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
  }

  /* Below the buttons on narrow screens, so they stay above the fold. */
  .trust {
    order: 1;
    max-width: 38em;
  }

  .scroll-hint {
    order: 2;
  }

  .trust h2 {
    margin: 0 0 8px;
    font-size: 12.5px;
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
    border-radius: 10px;
    background: var(--paper);
    font-size: 13.5px;
  }

  .run-label {
    color: var(--ink-3);
  }

  .run code {
    color: var(--teal-2);
    font-size: 13.5px;
  }

  .scroll-hint {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--ink-3);
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
    border-radius: 12px;
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
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 11px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.72);
    color: #fff;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 6px 18px -8px rgba(0, 0, 0, 0.5);
  }

  .replay {
    border: 0;
    cursor: pointer;
    transition: background-color 160ms ease;
  }

  .replay:hover {
    background: rgba(15, 23, 42, 0.88);
  }

  .caption {
    margin: 0;
    min-height: 1.5em;
    font-size: 13.5px;
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
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink-3);
    font: inherit;
    font-size: 12.5px;
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

    .sticky {
      position: sticky;
      top: var(--nav-h);
      height: calc(100vh - var(--nav-h));
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

  @media (prefers-reduced-motion: reduce) {
    .scroll-hint svg {
      animation: none;
    }

    .step,
    .seg,
    .step h3,
    .replay {
      transition: none;
    }

    .steps .step:not(.on) {
      opacity: 1;
    }
  }
</style>
