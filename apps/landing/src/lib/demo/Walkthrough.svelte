<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import type { Dict, Lang } from '$lib/i18n';
  import AppMock from './AppMock.svelte';
  import { LATEST_RELEASE_URL } from '$lib/site';

  let { t, lang }: { t: Dict; lang: Lang } = $props();

  const DESIGN_W = 900;
  const DESIGN_H = 580;

  /** Which [data-hit] element in the mock each step's callout points at, with a preferred side. */
  const CALLOUT_TARGETS: (string | null)[] = [
    null,
    'settings-key-chip:right',
    'roster-row:below',
    'msg-u1:left',
    'judgement:left',
    'allow-once:below',
    'msg-g3:right',
    'pv-edit:left',
    'tray-status:right'
  ];

  let scene = $state(0);
  let scale = $state(0.8);
  let instant = $state(false);
  let copied = $state(false);
  let stageEl: HTMLDivElement | undefined = $state();
  let rootEl: HTMLElement | undefined = $state();

  const calloutText = $derived(scene > 0 ? t.demo.steps[scene - 1]?.callout ?? null : null);
  const calloutTarget = $derived(CALLOUT_TARGETS[scene] ?? null);
  const railLabel = $derived(
    scene > 0 ? `${String(scene).padStart(2, '0')}  ${t.demo.steps[scene - 1]?.title ?? ''}` : t.demo.railLabel
  );

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  function copyCommand() {
    navigator.clipboard?.writeText(t.hero.runCommand).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1800);
    });
  }

  function jumpTo(n: number) {
    const el = rootEl?.querySelector<HTMLElement>(`[data-scene="${n}"]`);
    el?.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
  }

  onMount(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    instant = mq.matches;
    const onMq = () => (instant = mq.matches);
    mq.addEventListener('change', onMq);

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) scale = e.contentRect.width / DESIGN_W;
    });
    if (stageEl) ro.observe(stageEl);

    const steps = rootEl ? Array.from(rootEl.querySelectorAll<HTMLElement>('[data-scene]')) : [];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) scene = Number(e.target.getAttribute('data-scene'));
        }
      },
      { rootMargin: '-42% 0px -42% 0px', threshold: 0 }
    );
    steps.forEach((el) => io.observe(el));

    return () => {
      mq.removeEventListener('change', onMq);
      ro.disconnect();
      io.disconnect();
    };
  });
</script>

<section class="walk" id="demo" bind:this={rootEl}>
  <div class="page walk-grid">
    <!-- Hero copy: scene 0 -->
    <div class="hero step" data-scene="0">
      <p class="wip"><span class="wip-mark"></span>{t.hero.wipNote}</p>
      <h1 class="serif">
        {#each t.hero.headlineLines as line, i}{#if i > 0}<br />{/if}<span>{line}</span>{/each}
      </h1>
      <p class="sub">{t.hero.subhead}</p>
      <div class="ctas">
        <a class="btn btn-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">{t.hero.ctaPrimary}</a>
        <a class="btn btn-secondary" href="{base}/{lang}#quickstart">{t.hero.ctaSecondary}</a>
      </div>
      <div class="run">
        <span class="run-label">{t.hero.runLabel}</span>
        <code class="mono">{t.hero.runCommand}</code>
        <button class="copy" onclick={copyCommand} type="button">{copied ? t.hero.copied : t.hero.copy}</button>
      </div>
      <p class="scroll-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        {t.hero.scrollHint}
      </p>
    </div>

    <!-- Sticky stage -->
    <div class="stage-col">
      <div class="sticky">
        <div class="stage" bind:this={stageEl} style:border-radius="{12 * scale}px">
          <div class="scaler" style:transform="scale({scale})">
            <AppMock {scene} {t} {instant} {calloutTarget} {calloutText} />
          </div>
        </div>
        <p class="caption" class:on={!!calloutText}>{calloutText ?? ''}</p>
        <div class="rail" aria-label={t.demo.railLabel}>
          <span class="rail-label">{railLabel}</span>
          <ol class="rail-segments">
            {#each t.demo.steps as step, i}
              <li>
                <button
                  type="button"
                  class="seg"
                  class:on={scene === i + 1}
                  class:done={scene > i + 1}
                  aria-label="{pad(i + 1)} {step.title}"
                  aria-current={scene === i + 1 ? 'step' : undefined}
                  onclick={() => jumpTo(i + 1)}
                ></button>
              </li>
            {/each}
          </ol>
        </div>
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
          <span class="num serif" aria-hidden="true">{pad(i + 1)}</span>
          <h3 class="serif">{step.title}</h3>
          <p>{step.body}</p>
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
    display: inline-flex;
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

  .copy {
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-2);
    background: var(--ground);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 10px;
    cursor: pointer;
  }

  .copy:hover {
    color: var(--teal-2);
    border-color: var(--teal-line);
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
    aspect-ratio: 900 / 580;
    box-shadow: var(--shadow-window);
    background: var(--app-bg);
  }

  .scaler {
    position: absolute;
    left: 0;
    top: 0;
    width: 900px;
    height: 580px;
    transform-origin: 0 0;
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

  .rail {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 13px;
    color: var(--ink-2);
  }

  .rail-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .rail-segments {
    display: flex;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .seg {
    display: block;
    width: 22px;
    height: 6px;
    border-radius: 3px;
    border: 0;
    padding: 0;
    background: var(--line);
    cursor: pointer;
    transition: background-color 200ms ease;
  }

  .seg.done {
    background: var(--teal-line);
  }

  .seg.on {
    background: var(--teal);
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

    .caption {
      display: none;
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
    .seg {
      transition: none;
    }

    .steps .step:not(.on) {
      opacity: 1;
    }
  }
</style>
