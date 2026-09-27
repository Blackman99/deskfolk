<script lang="ts">
  import { dev } from '$app/environment';
  import { onMount } from 'svelte';
  import AppMock from '$lib/demo/AppMock.svelte';
  import { CALLOUT_TARGETS } from '$lib/demo/scenes';
  import Logo from '$lib/Logo.svelte';
  import { DICT, type Lang } from '$lib/i18n';
  import { SITE_URL } from '$lib/site';
  import { BEAT_MS, filmTimeline, type CueType, type FilmCue } from '$lib/film/timeline';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const theme = $derived(data.theme);

  const COPY = {
    zh: { license: 'MIT 开源 · macOS Alpha 快照' },
    en: { license: 'Open source under MIT · macOS alpha snapshot' }
  } as const;

  const FILM_W = 1920;
  const FILM_H = 1080;
  const DESIGN_W = 900;
  const DESIGN_H = 580;
  const STAGE_W = 1140;
  const STAGE_H = Math.round((STAGE_W * DESIGN_H) / DESIGN_W);
  const FIT = STAGE_W / DESIGN_W;
  /** How far the camera may push in on a step's callout, relative to the whole window. */
  const MAX_ZOOM = 1.25;
  /** The desktop and the phone read only as a whole, as on the narrow landing stage. */
  const WHOLE_WINDOW = new Set([10, 11]);
  /** Where the callout points into a bigger piece, the camera keeps that whole piece in frame. */
  const FOCUS_CONTEXT: Record<number, string> = { 1: '.modal', 5: '.approval' };
  /** The prompter's current title sits level with the middle of the stage. */
  const PROMPTER_TOP = 150;
  const PROMPTER_FOCUS = FILM_H / 2 - PROMPTER_TOP;

  const timeline = filmTimeline();
  const bar = (n: number) => n * timeline.barMs;

  type Phase = 'idle' | 'logo' | 'hero' | 'steps' | 'trust' | 'end';
  let phase = $state<Phase>('idle');
  let scene = $state(0);
  let dim = $state(false);
  let trustShown = $state(0);
  let started = false;
  let t0 = 0;

  let stageEl: HTMLDivElement | undefined = $state();
  let itemEls: HTMLElement[] = $state([]);
  let itemCenters = $state<number[]>([]);
  let fitScale = $state(1);

  const steps = $derived(t.demo.steps);
  const calloutTarget = $derived(phase === 'steps' ? (CALLOUT_TARGETS[scene] ?? null) : null);
  const calloutText = $derived(phase === 'steps' && scene > 0 ? (steps[scene - 1]?.callout ?? null) : null);
  const prompterY = $derived(PROMPTER_FOCUS - (itemCenters[Math.max(0, scene - 1)] ?? 0));
  const siteLabel = SITE_URL.replace(/^https?:\/\//, '');

  /* ---- Camera: a spring toward the step's callout and its target, whole window otherwise. ---- */
  type Cam = { s: number; tx: number; ty: number };
  let cam = $state<Cam>({ s: FIT, tx: 0, ty: 0 });
  const vel: Cam = { s: 0, tx: 0, ty: 0 };
  const OMEGA = 5.5;

  function cameraGoal(): Cam {
    const whole = { s: FIT, tx: 0, ty: 0 };
    if (phase !== 'steps' || WHOLE_WINDOW.has(scene) || !calloutTarget) return whole;
    const win = stageEl?.querySelector<HTMLElement>('.win');
    const el = win?.querySelector<HTMLElement>(`[data-hit="${calloutTarget.split(':')[0]}"]`);
    if (!win || !el) return whole;
    const host = win.getBoundingClientRect();
    const k = host.width / DESIGN_W || 1;
    const box = (r: DOMRect) => ({
      x0: (r.left - host.left) / k,
      y0: (r.top - host.top) / k,
      x1: (r.right - host.left) / k,
      y1: (r.bottom - host.top) / k
    });
    let b = box(el.getBoundingClientRect());
    const extra = [win.querySelector<HTMLElement>('.callout')];
    if (FOCUS_CONTEXT[scene]) extra.push(win.querySelector<HTMLElement>(FOCUS_CONTEXT[scene]));
    for (const more of extra) {
      if (!more) continue;
      const c = box(more.getBoundingClientRect());
      b = { x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1) };
    }
    const pad = 44;
    let w = Math.max(b.x1 - b.x0 + pad * 2, DESIGN_W / MAX_ZOOM);
    let h = Math.max(b.y1 - b.y0 + pad * 2, DESIGN_H / MAX_ZOOM);
    if (w / h > DESIGN_W / DESIGN_H) h = (w * DESIGN_H) / DESIGN_W;
    else w = (h * DESIGN_W) / DESIGN_H;
    const s = STAGE_W / Math.min(w, DESIGN_W);
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const tx = Math.min(0, Math.max(STAGE_W - DESIGN_W * s, STAGE_W / 2 - cx * s));
    const ty = Math.min(0, Math.max(STAGE_H - DESIGN_H * s, STAGE_H / 2 - cy * s));
    return { s, tx, ty };
  }

  function stepCamera(dt: number) {
    const goal = cameraGoal();
    const next = { ...cam };
    for (const key of ['s', 'tx', 'ty'] as const) {
      const a = OMEGA * OMEGA * (goal[key] - cam[key]) - 2 * OMEGA * vel[key];
      vel[key] += a * dt;
      next[key] = cam[key] + vel[key] * dt;
    }
    cam = next;
  }

  /* ---- Sound cues: what happens in the window, stamped in film time for the soundtrack. ---- */
  const cues: FilmCue[] = [];
  const lastCue: Partial<Record<CueType, number>> = {};
  const CUE_GAP: Partial<Record<CueType, number>> = { key: 55 };
  const CUE_SELECTORS: [string, CueType][] = [
    ['.msg.you, .ph-msg.you', 'send'],
    ['.msg.bot, .card.running', 'receive'],
    ['.approval', 'alert'],
    ['.ap-status, .pv-toast, .chip-ok', 'confirm'],
    ['.banner', 'notify'],
    ['.roster-item, .dk-badge, .judgement', 'pop'],
    ['.modal, .sheet, .col-right, .bottom-pane, .desk, .phone, .ph-chat', 'whoosh'],
    ['.menu, .tray-menu, .c-detail', 'tick']
  ];

  /** A scene switch remounts what the new beat-0 state shows; none of that is news. */
  let sceneSwitchedAt = -Infinity;

  function cue(type: CueType) {
    if (!started || phase !== 'steps') return;
    const at = performance.now() - t0;
    if (at - sceneSwitchedAt < 80) return;
    const prev = lastCue[type];
    if (prev !== undefined && at - prev < (CUE_GAP[type] ?? 90)) return;
    lastCue[type] = at;
    cues.push({ t: Math.round(at), type });
  }

  function observeCues(root: HTMLElement): MutationObserver {
    const inTypewriter = (node: Node) => !!node.parentElement?.closest('.tw');
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const node of r.addedNodes) {
            if (node instanceof HTMLElement) {
              for (const [sel, type] of CUE_SELECTORS) if (node.matches(sel)) cue(type);
            } else if (inTypewriter(node)) {
              cue('key');
            }
          }
        } else if (r.type === 'characterData') {
          if (inTypewriter(r.target)) cue('key');
        } else if (r.target instanceof HTMLElement && r.target.matches('.cursor')) {
          if (r.target.classList.contains('clicking') && !(r.oldValue ?? '').includes('clicking')) cue('click');
        }
      }
    });
    mo.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true
    });
    return mo;
  }

  /* ---- The cut: every part scheduled on the page's own clock, so a fake clock can step it. ---- */
  function measurePrompter() {
    itemCenters = itemEls.map((el) => el.offsetTop + el.offsetHeight / 2);
  }

  function start() {
    if (started) return;
    started = true;
    measurePrompter();
    t0 = performance.now();
    const at = (ms: number, fn: () => void) => setTimeout(fn, Math.max(0, ms));
    const { bars } = timeline;
    phase = 'logo';
    at(bar(bars.hero), () => (phase = 'hero'));
    at(bar(bars.steps[0]) - 220, () => (dim = true));
    bars.steps.forEach((b, i) =>
      at(bar(b), () => {
        phase = 'steps';
        scene = i + 1;
        dim = false;
        sceneSwitchedAt = performance.now() - t0;
      })
    );
    at(bar(bars.trust), () => (phase = 'trust'));
    t.hero.trust.forEach((_, i) => at(bar(bars.trust) + 250 + i * BEAT_MS * 1.5, () => (trustShown = i + 1)));
    at(bar(bars.end), () => (phase = 'end'));
  }

  onMount(() => {
    const fit = () => (fitScale = Math.min(1, window.innerWidth / FILM_W, window.innerHeight / FILM_H));
    fit();
    window.addEventListener('resize', fit);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      stepCamera(Math.min(0.05, Math.max(0, (now - last) / 1000)));
      last = now;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const mo = stageEl ? observeCues(stageEl) : null;
    measurePrompter();

    (window as unknown as { __film: unknown }).__film = {
      ready: true,
      timeline,
      start,
      cues
    };
    if (new URLSearchParams(location.search).has('autoplay')) setTimeout(start, 600);

    return () => {
      window.removeEventListener('resize', fit);
      cancelAnimationFrame(raf);
      mo?.disconnect();
    };
  });

  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  });

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }
</script>

<svelte:head>
  <title>Film stage — Deskfolk</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if dev}
  <div
    class="film phase-{phase}"
    lang={lang === 'zh' ? 'zh-CN' : 'en'}
    style:width="{FILM_W}px"
    style:height="{FILM_H}px"
    style:transform={fitScale < 1 ? `scale(${fitScale})` : undefined}
  >
    <!-- Logo: bar 0 -->
    <div class="brand-big" class:on={phase === 'logo'}>
      <Logo size={112} />
      <span class="brand-name">Deskfolk</span>
    </div>

    <div class="brand-small" class:on={phase === 'hero' || phase === 'steps'}>
      <Logo size={34} />
      <span class="brand-name">Deskfolk</span>
    </div>

    <!-- Hero copy, as on the landing's first screen -->
    <div class="hero-copy" class:on={phase === 'hero'}>
      <h1>
        {#each t.hero.headlineLines as line, i}<span class="line" style:transition-delay="{phase === 'hero' ? 150 + i * 220 : 0}ms">{line}</span>{/each}
      </h1>
      <p class="sub">{t.hero.subhead}</p>
    </div>

    <!-- Prompter: the step list scrolls past the window, as the landing does on scroll -->
    <div class="prompter" class:on={phase === 'steps'} style:top="{PROMPTER_TOP}px">
      <ol class="list" style:transform="translateY({prompterY}px)">
        {#each steps as step, i}
          <li
            class="item"
            class:on={scene === i + 1}
            class:done={scene > i + 1}
            bind:this={itemEls[i]}
          >
            <span class="num">{pad(i + 1)}<i> / {pad(steps.length)}</i></span>
            <h2>{step.title}</h2>
          </li>
        {/each}
      </ol>
    </div>

    <!-- Stage -->
    <div
      class="stage"
      class:on={phase === 'hero' || phase === 'steps'}
      class:out={phase === 'trust' || phase === 'end'}
      bind:this={stageEl}
      style:width="{STAGE_W}px"
      style:height="{STAGE_H}px"
    >
      <div
        class="scaler"
        class:dim
        style:transform="translate({cam.tx}px, {cam.ty}px) scale({cam.s})"
      >
        <AppMock {scene} {t} {calloutTarget} {calloutText} />
      </div>
    </div>

    <!-- Trust points -->
    <div class="trust" class:on={phase === 'trust'}>
      <p class="trust-label">{t.hero.trustLabel}</p>
      {#each t.hero.trust as item, i}
        <p class="trust-item" class:shown={trustShown > i}>{item.label}</p>
      {/each}
    </div>

    <!-- End card -->
    <div class="end" class:on={phase === 'end'}>
      <div class="end-brand">
        <Logo size={96} />
        <span class="brand-name">Deskfolk</span>
      </div>
      <p class="end-headline">{t.hero.headline}</p>
      <div class="end-cta">
        <span class="pill">{t.hero.ctaPrimary}</span>
        <span class="url">{siteLabel}</span>
      </div>
      <p class="end-license">{COPY[lang].license}</p>
    </div>
  </div>
{:else}
  <p>Development only.</p>
{/if}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    background: var(--ground);
    overflow: hidden;
  }

  .film {
    position: fixed;
    left: 0;
    top: 0;
    overflow: hidden;
    transform-origin: 0 0;
    color: var(--ink);
    font-family: var(--font-sans);
    background:
      radial-gradient(1200px 760px at 100% 0%, var(--teal-tint) 0%, transparent 60%),
      radial-gradient(1000px 680px at 0% 100%, var(--mustard-tint) 0%, transparent 55%),
      var(--ground);
  }

  .brand-name {
    font-family: var(--font-serif);
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  /* ── Logo ── */
  .brand-big {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 30px;
    opacity: 0;
    transform: scale(0.94);
    transition:
      opacity 500ms ease,
      transform 900ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .brand-big.on {
    opacity: 1;
    transform: none;
  }

  .brand-big .brand-name {
    font-size: 96px;
  }

  .brand-small {
    position: absolute;
    left: 120px;
    top: 58px;
    display: flex;
    align-items: center;
    gap: 12px;
    opacity: 0;
    transition: opacity 600ms ease 200ms;
  }

  .brand-small.on {
    opacity: 1;
  }

  .brand-small .brand-name {
    font-size: 28px;
  }

  /* ── Hero copy ── */
  .hero-copy {
    position: absolute;
    left: 120px;
    top: 540px;
    width: 480px;
    transform: translateY(-50%);
    opacity: 0;
    transition: opacity 450ms ease;
  }

  .hero-copy.on {
    opacity: 1;
  }

  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 62px;
    white-space: nowrap;
    font-weight: 700;
    line-height: 1.22;
  }

  .film[lang='en'] h1 {
    font-size: 54px;
    line-height: 1.14;
    letter-spacing: -0.015em;
  }

  .line {
    display: block;
    opacity: 0;
    transform: translateY(24px);
    transition:
      opacity 600ms ease,
      transform 800ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .hero-copy.on .line {
    opacity: 1;
    transform: none;
  }

  .sub {
    margin: 30px 0 0;
    font-size: 23px;
    line-height: 1.7;
    color: var(--ink-2);
    opacity: 0;
    transition: opacity 700ms ease;
  }

  .hero-copy.on .sub {
    opacity: 1;
    transition-delay: 800ms;
  }

  /* ── Prompter ── */
  .prompter {
    position: absolute;
    left: 120px;
    width: 480px;
    height: 780px;
    overflow: hidden;
    opacity: 0;
    transition: opacity 500ms ease;
    mask-image: linear-gradient(to bottom, transparent 0%, #000 24%, #000 76%, transparent 100%);
  }

  .prompter.on {
    opacity: 1;
    transition-delay: 250ms;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    transition: transform 850ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .item {
    margin-bottom: 44px;
    opacity: 0.2;
    transform: scale(0.88);
    transform-origin: 0 50%;
    transition:
      opacity 450ms ease,
      transform 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .item.on {
    opacity: 1;
    transform: none;
  }

  .num {
    font-family: var(--font-mono);
    font-size: 17px;
    color: var(--teal);
    letter-spacing: 0.04em;
  }

  .num i {
    font-style: normal;
    color: var(--ink-3);
  }

  h2 {
    margin: 10px 0 0;
    font-family: var(--font-serif);
    font-size: 46px;
    font-weight: 700;
    line-height: 1.26;
    text-wrap: balance;
  }

  .film[lang='en'] h2 {
    font-size: 40px;
    line-height: 1.18;
    letter-spacing: -0.01em;
  }

  /* ── Stage ── */
  .stage {
    position: absolute;
    left: 660px;
    top: 173px;
    border-radius: 16px;
    overflow: hidden;
    background: var(--app-bg);
    box-shadow: var(--shadow-window);
    opacity: 0;
    transform: translateY(56px) scale(0.98);
    transition:
      opacity 700ms ease,
      transform 1000ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .stage.on {
    opacity: 1;
    transform: none;
  }

  .stage.out {
    opacity: 0;
    transform: scale(0.94);
  }

  .scaler {
    position: absolute;
    left: 0;
    top: 0;
    width: 900px;
    height: 580px;
    transform-origin: 0 0;
    transition: opacity 260ms ease;
  }

  .scaler.dim {
    opacity: 0;
    transition-duration: 200ms;
  }

  /* ── Trust points ── */
  .trust {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    opacity: 0;
    transition: opacity 500ms ease;
  }

  .trust.on {
    opacity: 1;
    transition-delay: 300ms;
  }

  .trust-label {
    margin: 0 0 18px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--teal);
  }

  .trust-item {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 60px;
    font-weight: 700;
    line-height: 1.4;
    opacity: 0;
    transform: translateY(22px);
    transition:
      opacity 500ms ease,
      transform 800ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .film[lang='en'] .trust-item {
    font-size: 54px;
    letter-spacing: -0.01em;
  }

  .trust-item.shown {
    opacity: 1;
    transform: none;
  }

  /* ── End card ── */
  .end {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 600ms ease;
  }

  .end.on {
    opacity: 1;
  }

  .end-brand {
    display: flex;
    align-items: center;
    gap: 26px;
    transform: translateY(18px);
    transition: transform 1000ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .end-brand .brand-name {
    font-size: 88px;
  }

  .end-headline {
    margin: 34px 0 0;
    font-family: var(--font-serif);
    font-size: 42px;
    font-weight: 700;
    color: var(--ink-2);
  }

  .end-cta {
    display: flex;
    align-items: center;
    gap: 28px;
    margin-top: 56px;
  }

  .pill {
    font-size: 26px;
    font-weight: 600;
    color: var(--paper);
    background: var(--teal);
    border-radius: 999px;
    padding: 16px 36px;
  }

  .url {
    font-family: var(--font-mono);
    font-size: 26px;
    color: var(--teal);
  }

  .end-license {
    margin: 30px 0 0;
    font-size: 20px;
    color: var(--ink-3);
  }

  .end-headline,
  .end-cta,
  .end-license {
    opacity: 0;
    transform: translateY(16px);
    transition:
      opacity 600ms ease,
      transform 900ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .end.on .end-brand {
    transform: none;
  }

  .end.on .end-headline,
  .end.on .end-cta,
  .end.on .end-license {
    opacity: 1;
    transform: none;
  }

  .end.on .end-headline {
    transition-delay: 300ms;
  }

  .end.on .end-cta {
    transition-delay: 700ms;
  }

  .end.on .end-license {
    transition-delay: 1000ms;
  }
</style>
