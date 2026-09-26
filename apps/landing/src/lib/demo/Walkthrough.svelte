<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { docsPath } from '$lib/docs';
  import type { Dict, Lang } from '$lib/i18n';
  import { LATEST_RELEASE_URL } from '$lib/site';
  import CopyButton from '$lib/CopyButton.svelte';
  import AppMock, { type FocusRect } from './AppMock.svelte';

  let { t, lang, version }: { t: Dict; lang: Lang; version: string } = $props();

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
    'cmd-row:right',
    'pv-edit:left',
    'route-line:left',
    'term-output:left',
    'tray-status:right',
    'phone-url:left'
  ];

  /**
   * Narrow screens zoom the window onto the part that matters. Until the callout
   * target exists in a scene, these regions (design px) are used instead.
   */
  const FOCUS_FALLBACK: (FocusRect | null)[] = [
    null,
    { x: 180, y: 60, w: 540, h: 470 },
    { x: 0, y: 0, w: 520, h: 580 },
    { x: 200, y: 30, w: 700, h: 550 },
    { x: 200, y: 30, w: 700, h: 550 },
    { x: 200, y: 30, w: 700, h: 550 },
    { x: 200, y: 30, w: 700, h: 550 },
    { x: 380, y: 30, w: 520, h: 550 },
    { x: 380, y: 30, w: 520, h: 550 },
    { x: 380, y: 30, w: 520, h: 550 },
    null,
    null
  ];

  /**
   * Scenes a narrow stage shows whole: the desktop with its banner and Dock does not survive a crop,
   * and the phone is taller than any crop the landscape stage can make.
   */
  const WHOLE_WINDOW = new Set([10, 11]);

  let scene = $state(0);
  let skipToEnd = $state(false);
  let stageW = $state(720);
  let narrow = $state(false);
  let instant = $state(false);
  let focusTarget = $state<FocusRect | null>(null);
  let stageEl: HTMLDivElement | undefined = $state();
  let rootEl: HTMLElement | undefined = $state();

  const calloutText = $derived(scene > 0 ? t.demo.steps[scene - 1]?.callout ?? null : null);
  const calloutTarget = $derived(CALLOUT_TARGETS[scene] ?? null);

  /** Camera: whole window on wide screens; a focused region on narrow ones. */
  const camera = $derived.by(() => {
    const fit = stageW / DESIGN_W;
    if (!narrow || WHOLE_WINDOW.has(scene)) return { s: fit, tx: 0, ty: 0 };
    const region = focusTarget ? boxAround(focusTarget) : FOCUS_FALLBACK[scene];
    if (!region) return { s: fit, tx: 0, ty: 0 };
    const stageH = stageW * (DESIGN_H / DESIGN_W);
    const s = Math.min(stageW / region.w, stageH / region.h);
    const cx = region.x + region.w / 2;
    const cy = region.y + region.h / 2;
    let tx = stageW / 2 - cx * s;
    let ty = stageH / 2 - cy * s;
    tx = Math.min(0, Math.max(stageW - DESIGN_W * s, tx));
    ty = Math.min(0, Math.max(stageH - DESIGN_H * s, ty));
    return { s, tx, ty };
  });

  function boxAround(r: FocusRect): FocusRect {
    const w = Math.min(DESIGN_W, Math.max(460, r.w + 80));
    const h = Math.min(DESIGN_H, Math.max(w * (DESIGN_H / DESIGN_W), r.h + 80));
    let x = r.x + r.w / 2 - w / 2;
    let y = r.y + r.h / 2 - h / 2;
    x = Math.max(0, Math.min(DESIGN_W - w, x));
    y = Math.max(0, Math.min(DESIGN_H - h, y));
    return { x, y, w, h };
  }

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  function setScene(next: number) {
    if (next === scene) return;
    skipToEnd = next < scene;
    scene = next;
  }

  function jumpTo(n: number) {
    const el = rootEl?.querySelector<HTMLElement>(`[data-scene="${n}"]`);
    el?.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
  }

  onMount(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const width = window.matchMedia('(max-width: 1023px)');
    instant = motion.matches;
    narrow = width.matches;
    const onMotion = () => (instant = motion.matches);
    const onWidth = () => (narrow = width.matches);
    motion.addEventListener('change', onMotion);
    width.addEventListener('change', onWidth);

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) stageW = e.contentRect.width;
    });
    if (stageEl) ro.observe(stageEl);

    // Adjacent steps can both touch the observation band; pick the one nearest the viewport centre.
    const steps = rootEl ? Array.from(rootEl.querySelectorAll<HTMLElement>('[data-scene]')) : [];
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
    steps.forEach((el) => io.observe(el));

    return () => {
      motion.removeEventListener('change', onMotion);
      width.removeEventListener('change', onWidth);
      ro.disconnect();
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
        <div class="stage" bind:this={stageEl} style:border-radius="{12 * camera.s}px">
          <div
            class="scaler"
            class:animated={narrow && !instant}
            style:transform="translate({camera.tx}px, {camera.ty}px) scale({camera.s})"
          >
            <AppMock
              {scene}
              {t}
              {instant}
              {skipToEnd}
              {calloutTarget}
              {calloutText}
              onFocus={(r) => (focusTarget = r)}
            />
          </div>
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
    aspect-ratio: 900 / 580;
    overflow: hidden;
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

  .scaler.animated {
    transition: transform 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
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
    .seg,
    .step h3,
    .scaler.animated {
      transition: none;
    }

    .steps .step:not(.on) {
      opacity: 1;
    }
  }
</style>
