<script lang="ts">
  import { dev } from '$app/environment';
  import { onMount } from 'svelte';
  import Logo from '$lib/Logo.svelte';
  import { DICT, type Lang } from '$lib/i18n';
  import { SITE_URL } from '$lib/site';

  /**
   * The promo on the real app: the demo messenger in an iframe on the stage, driven from outside by
   * scripts/film/live.ts, which also moves the camera and the cursor here and says when each part
   * starts. Unlike the mock film, nothing here keeps time: the director does.
   */
  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const theme = $derived(data.theme);

  const COPY = {
    zh: {
      license: 'MIT 开源 · macOS Alpha 快照',
      tray: ['显示窗口', '停止所有轮次', '退出 Deskfolk'],
      now: '现在'
    },
    en: {
      license: 'Open source under MIT · macOS alpha snapshot',
      tray: ['Show window', 'Stop all turns', 'Quit Deskfolk'],
      now: 'now'
    }
  } as const;

  const FILM_W = 1920;
  const FILM_H = 1080;
  /** The messenger's own viewport, and the space the camera, cursor and desktop share. */
  // Room for four panes side by side (about 666×480 each) without cramming.
  const APP_W = 1600;
  const APP_H = 1000;
  const STAGE_W = 1480;
  const STAGE_H = Math.round((STAGE_W * APP_H) / APP_W);
  const FIT = STAGE_W / APP_W;
  const MAX_ZOOM = 1.3;
  const PHONE_W = 390;
  const PHONE_H = 844;
  const PHONE_SCALE = 0.9;
  /** The status bar above the app and the home indicator under it, as on the device. */
  const PHONE_STATUS = 30;
  const PHONE_HOME = 18;
  const PROMPTER_TOP = 150;
  const PROMPTER_FOCUS = FILM_H / 2 - PROMPTER_TOP;

  type Phase = 'idle' | 'logo' | 'hero' | 'steps' | 'trust' | 'end';
  let phase = $state<Phase>('idle');
  let scene = $state(0);
  let trustShown = $state(0);
  let desk = $state({ on: false, menu: false, banner: null as null | { title: string; body: string }, badge: false });
  let phoneOn = $state(false);

  let stageEl: HTMLDivElement | undefined = $state();
  let scalerEl: HTMLDivElement | undefined = $state();
  let itemEls: HTMLElement[] = $state([]);
  let itemCenters = $state<number[]>([]);
  let fitScale = $state(1);

  const appUrl = $derived(data.app);
  const steps = $derived(t.demo.steps);
  const prompterY = $derived(PROMPTER_FOCUS - (itemCenters[Math.max(0, scene - 1)] ?? 0));
  const siteLabel = SITE_URL.replace(/^https?:\/\//, '');

  /* ---- Camera: a spring toward what the director points at, in app space. ---- */
  type Cam = { s: number; tx: number; ty: number };
  type Rect = { x: number; y: number; w: number; h: number };
  let cam = $state<Cam>({ s: FIT, tx: 0, ty: 0 });
  const vel: Cam = { s: 0, tx: 0, ty: 0 };
  let goal: Cam = { s: FIT, tx: 0, ty: 0 };
  const OMEGA = 7;

  function goalFor(r: Rect | null): Cam {
    if (!r) return { s: FIT, tx: 0, ty: 0 };
    const pad = 48;
    let w = Math.max(r.w + pad * 2, APP_W / MAX_ZOOM);
    let h = Math.max(r.h + pad * 2, APP_H / MAX_ZOOM);
    if (w / h > APP_W / APP_H) h = (w * APP_H) / APP_W;
    else w = (h * APP_W) / APP_H;
    const s = STAGE_W / Math.min(w, APP_W);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const tx = Math.min(0, Math.max(STAGE_W - APP_W * s, STAGE_W / 2 - cx * s));
    const ty = Math.min(0, Math.max(STAGE_H - APP_H * s, STAGE_H / 2 - cy * s));
    return { s, tx, ty };
  }

  /** Page coordinates (what Playwright measures) to app space, through the camera as it is now. */
  function toApp(r: Rect): Rect {
    const box = scalerEl!.getBoundingClientRect();
    const k = box.width / APP_W;
    return { x: (r.x - box.left) / k, y: (r.y - box.top) / k, w: r.w / k, h: r.h / k };
  }

  function stepCamera(dt: number) {
    const next = { ...cam };
    for (const key of ['s', 'tx', 'ty'] as const) {
      const a = OMEGA * OMEGA * (goal[key] - cam[key]) - 2 * OMEGA * vel[key];
      vel[key] += a * dt;
      next[key] = cam[key] + vel[key] * dt;
    }
    cam = next;
  }

  /* ---- Cursor, in app space ---- */
  let cursor = $state({ x: APP_W / 2, y: APP_H / 2, visible: false, clicking: false, touch: false, dragging: false });
  let clickTimer: ReturnType<typeof setTimeout> | undefined;

  function measurePrompter() {
    itemCenters = itemEls.map((el) => el.offsetTop + el.offsetHeight / 2);
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
    measurePrompter();

    (window as unknown as { __film: unknown }).__film = {
      ready: true,
      set(next: { phase?: Phase; scene?: number }) {
        if (next.phase) phase = next.phase;
        if (next.scene !== undefined) scene = next.scene;
        measurePrompter();
      },
      trust(n: number) {
        trustShown = n;
      },
      /** A page-space rectangle to frame, or null for the whole window. */
      focus(r: Rect | null) {
        goal = goalFor(r ? toApp(r) : null);
      },
      /** `dragging` pins the pointer to each point instead of gliding there, to stay on the dragged tab. */
      cursor(p: { x: number; y: number; visible?: boolean; click?: boolean; touch?: boolean; dragging?: boolean }) {
        const a = toApp({ x: p.x, y: p.y, w: 0, h: 0 });
        cursor = {
          x: a.x,
          y: a.y,
          visible: p.visible ?? true,
          clicking: false,
          touch: p.touch ?? false,
          dragging: p.dragging ?? false
        };
        if (p.click) {
          clearTimeout(clickTimer);
          cursor.clicking = true;
          clickTimer = setTimeout(() => (cursor = { ...cursor, clicking: false }), 340);
        }
      },
      hideCursor() {
        cursor = { ...cursor, visible: false };
      },
      /** The camera has come to rest, so what the director measures now is where it will click. */
      settled() {
        const still = Math.abs(vel.s) < 0.002 && Math.abs(vel.tx) < 1 && Math.abs(vel.ty) < 1;
        const there = Math.abs(goal.s - cam.s) < 0.002 && Math.abs(goal.tx - cam.tx) < 1 && Math.abs(goal.ty - cam.ty) < 1;
        return still && there;
      },
      desk(next: Partial<typeof desk>) {
        desk = { ...desk, ...next };
      },
      phone(on: boolean) {
        phoneOn = on;
      }
    };
    return () => {
      window.removeEventListener('resize', fit);
      cancelAnimationFrame(raf);
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
  <title>Film stage (live) — Deskfolk</title>
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
    <div class="brand-big" class:on={phase === 'logo'}>
      <Logo size={112} />
      <span class="brand-name">Deskfolk</span>
    </div>

    <div class="brand-small" class:on={phase === 'hero' || phase === 'steps'}>
      <Logo size={34} />
      <span class="brand-name">Deskfolk</span>
    </div>

    <div class="hero-copy" class:on={phase === 'hero'}>
      <h1>
        {#each t.hero.headlineLines as line, i}<span class="line" style:transition-delay="{phase === 'hero' ? 150 + i * 220 : 0}ms">{line}</span>{/each}
      </h1>
      <p class="sub">{t.hero.subhead}</p>
    </div>

    <div class="prompter" class:on={phase === 'steps'} style:top="{PROMPTER_TOP}px">
      <ol class="list" style:transform="translateY({prompterY}px)">
        {#each steps as step, i}
          <li class="item" class:on={scene === i + 1} bind:this={itemEls[i]}>
            <span class="num">{pad(i + 1)}<i> / {pad(steps.length)}</i></span>
            <h2>{step.title}</h2>
            <p class="callout">{step.callout}</p>
          </li>
        {/each}
      </ol>
    </div>

    <div
      class="stage"
      class:on={phase === 'hero' || phase === 'steps'}
      class:hero={phase === 'hero'}
      class:out={phase === 'trust' || phase === 'end'}
      bind:this={stageEl}
      style:width="{STAGE_W}px"
      style:height="{STAGE_H}px"
    >
      <div
        class="scaler"
        bind:this={scalerEl}
        style:width="{APP_W}px"
        style:height="{APP_H}px"
        style:transform="translate({cam.tx}px, {cam.ty}px) scale({cam.s})"
      >
        <!-- The desktop behind the window, for the tray and phone steps -->
        <div class="desk" class:on={desk.on}>
          <div class="menubar">
            <span class="apple"></span>
            <span class="mb-item strong">Finder</span>
            <span class="mb-item">File</span><span class="mb-item">Edit</span><span class="mb-item">View</span>
            <span class="mb-spacer"></span>
            <span class="tray-icon" class:open={desk.menu}><Logo size={15} /></span>
            <span class="mb-item">14:36</span>
          </div>
          <div class="tray-menu" class:on={desk.menu}>
            {#each COPY[lang].tray as item, i}
              {#if i === 2}<span class="tm-sep"></span>{/if}
              <span class="tm-item">{item}</span>
            {/each}
          </div>
          <div class="banner" class:on={!!desk.banner}>
            <span class="bn-icon"><Logo size={30} /></span>
            <div class="bn-text">
              <div class="bn-top"><span class="bn-app">Deskfolk</span><span>{COPY[lang].now}</span></div>
              <div class="bn-title">{desk.banner?.title ?? ''}</div>
              <div class="bn-body">{desk.banner?.body ?? ''}</div>
            </div>
          </div>
          <div class="dock">
            <span class="dk-app a"></span>
            <span class="dk-app b"></span>
            <span class="dk-app c"></span>
            <span class="dk-app rb">
              <Logo size={30} />
              <span class="dk-badge" class:on={desk.badge}>1</span>
              <i class="dk-dot"></i>
            </span>
          </div>
        </div>

        <div class="window" class:hidden={desk.on}>
          {#if appUrl}<iframe name="app" title="Deskfolk" src={appUrl} width={APP_W} height={APP_H}></iframe>{/if}
        </div>

        <div class="phone" class:on={phoneOn}>
          <div class="ph-screen" style:width="{PHONE_W * PHONE_SCALE}px">
            <div class="ph-status" style:height="{PHONE_STATUS}px">
              <span class="ph-clock">14:41</span>
              <span class="ph-island"></span>
              <span class="ph-bars"><i></i><i></i><i></i><i></i></span>
            </div>
            <div class="ph-app" style:width="{PHONE_W * PHONE_SCALE}px" style:height="{PHONE_H * PHONE_SCALE}px">
              {#if appUrl}
                <iframe
                  name="phone"
                  title="Deskfolk on a phone"
                  src={appUrl}
                  width={PHONE_W}
                  height={PHONE_H}
                  style:transform="scale({PHONE_SCALE})"
                ></iframe>
              {/if}
            </div>
            <div class="ph-home" style:height="{PHONE_HOME}px"><i></i></div>
          </div>
        </div>

        <div
          class="cursor"
          class:visible={cursor.visible}
          class:clicking={cursor.clicking}
          class:touch={cursor.touch}
          class:dragging={cursor.dragging}
          style:transform="translate({cursor.x}px, {cursor.y}px)"
        >
          <svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 3l14 8.5-6.2 1.6L9.5 20z" stroke-width="1.6" stroke-linejoin="round" /></svg>
          <span class="fingertip"></span>
          <span class="ripple"></span>
        </div>
      </div>
    </div>

    <div class="trust" class:on={phase === 'trust'}>
      <p class="trust-label">{t.hero.trustLabel}</p>
      {#each t.hero.trust as item, i}
        <p class="trust-item" class:shown={trustShown > i}>{item.label}</p>
      {/each}
    </div>

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

  /* The overlays cover the stage even while invisible; clicks go through them to the app. */
  .brand-big,
  .brand-small,
  .hero-copy,
  .prompter,
  .trust,
  .end {
    pointer-events: none;
  }

  .brand-name {
    font-family: var(--font-serif);
    font-weight: 700;
    letter-spacing: -0.01em;
  }

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
    left: 56px;
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

  .prompter {
    position: absolute;
    left: 56px;
    width: 300px;
    height: 780px;
    overflow: hidden;
    opacity: 0;
    transition: opacity 500ms ease;
    mask-image: linear-gradient(to bottom, transparent 0%, #000 22%, #000 78%, transparent 100%);
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
    margin-bottom: 40px;
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
    font-size: 34px;
    font-weight: 700;
    line-height: 1.26;
    text-wrap: balance;
  }

  .film[lang='en'] h2 {
    font-size: 30px;
    line-height: 1.18;
    letter-spacing: -0.01em;
  }

  .callout {
    margin: 14px 0 0;
    padding-left: 14px;
    border-left: 3px solid var(--teal);
    font-size: 18px;
    line-height: 1.55;
    color: var(--ink-2);
    opacity: 0;
    transition: opacity 400ms ease;
  }

  .item.on .callout {
    opacity: 1;
    transition-delay: 350ms;
  }

  .stage {
    position: absolute;
    left: 390px;
    top: 77px;
    transform-origin: 100% 50%;
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

  /* Smaller beside the headline on the first screen, then full size for the walkthrough. */
  .stage.on.hero {
    transform: scale(0.78);
  }

  .stage.out {
    opacity: 0;
    transform: scale(0.94);
  }

  .scaler {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }

  .window {
    position: absolute;
    inset: 0;
    background: var(--app-bg);
    transition:
      transform 520ms cubic-bezier(0.2, 0.7, 0.2, 1),
      opacity 380ms ease;
    transform-origin: 88% 0%;
  }

  .window.hidden {
    transform: scale(0.86) translateY(-20px);
    opacity: 0;
    pointer-events: none;
  }

  iframe {
    display: block;
    border: 0;
  }

  /* ── Desktop behind the window ── */
  .desk {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(900px 600px at 20% 110%, #f3c98b 0%, transparent 60%),
      radial-gradient(900px 700px at 90% -10%, #8fb8d8 0%, transparent 60%),
      linear-gradient(160deg, #c9d8e6, #e9dccb);
    opacity: 0;
    pointer-events: none;
    transition: opacity 500ms ease;
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  }

  .desk.on {
    opacity: 1;
  }

  .menubar {
    height: 30px;
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: blur(20px);
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 0 16px;
    font-size: 14px;
    color: #1f2937;
  }

  .apple {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #111827;
    opacity: 0.85;
  }

  .mb-item.strong {
    font-weight: 600;
  }

  .mb-spacer {
    flex: 1;
  }

  .tray-icon {
    display: inline-flex;
    padding: 3px 6px;
    border-radius: 6px;
  }

  .tray-icon.open {
    background: rgba(0, 0, 0, 0.12);
  }

  .tray-menu {
    position: absolute;
    right: 64px;
    top: 36px;
    width: 220px;
    padding: 5px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 16px 36px -10px rgba(15, 23, 42, 0.35);
    font-size: 14px;
    color: #111827;
    opacity: 0;
    transform: translateY(-6px);
    transition:
      opacity 180ms ease,
      transform 220ms ease;
  }

  .tray-menu.on {
    opacity: 1;
    transform: none;
  }

  .tm-item {
    display: block;
    padding: 5px 12px;
    border-radius: 6px;
  }

  .tm-item:first-child {
    background: #2563eb;
    color: #fff;
  }

  .tm-sep {
    display: block;
    height: 1px;
    margin: 4px 8px;
    background: rgba(0, 0, 0, 0.12);
  }

  .banner {
    position: absolute;
    right: 16px;
    top: 44px;
    width: 380px;
    display: flex;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 18px 40px -12px rgba(15, 23, 42, 0.35);
    opacity: 0;
    transform: translateX(80px);
    transition:
      opacity 300ms ease,
      transform 420ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .banner.on {
    opacity: 1;
    transform: none;
  }

  .bn-icon {
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .bn-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: #111827;
  }

  .bn-top {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: #6b7280;
  }

  .bn-app {
    font-weight: 600;
  }

  .bn-title {
    font-size: 14px;
    font-weight: 600;
  }

  .bn-body {
    font-size: 13px;
    line-height: 1.45;
    color: #374151;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .dock {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    display: flex;
    align-items: flex-end;
    gap: 12px;
    padding: 8px 14px;
    border-radius: 22px;
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(20px);
    box-shadow: 0 10px 26px -12px rgba(15, 23, 42, 0.3);
  }

  .dk-app {
    position: relative;
    width: 54px;
    height: 54px;
    border-radius: 13px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .dk-app.a {
    background: linear-gradient(160deg, #60a5fa, #2563eb);
  }

  .dk-app.b {
    background: linear-gradient(160deg, #fcd34d, #f59e0b);
  }

  .dk-app.c {
    background: linear-gradient(160deg, #94a3b8, #475569);
  }

  .dk-app.rb {
    background: #fff;
  }

  .dk-badge {
    position: absolute;
    right: -7px;
    top: -7px;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 999px;
    background: #ef4444;
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transform: scale(0.3);
    opacity: 0;
    transition:
      transform 260ms cubic-bezier(0.3, 1.6, 0.5, 1),
      opacity 160ms ease;
  }

  .dk-badge.on {
    transform: none;
    opacity: 1;
  }

  .dk-dot {
    position: absolute;
    bottom: -7px;
    left: 50%;
    width: 5px;
    height: 5px;
    margin-left: -2.5px;
    border-radius: 50%;
    background: #374151;
  }

  /* The desktop in dark mode, as macOS draws it. */
  :global(:root[data-theme='dark']) .desk {
    background:
      radial-gradient(900px 600px at 20% 110%, #5b3a6b 0%, transparent 60%),
      radial-gradient(900px 700px at 90% -10%, #1f4e79 0%, transparent 60%),
      linear-gradient(160deg, #111827, #1e1b2e);
  }

  :global(:root[data-theme='dark']) .menubar {
    background: rgba(20, 24, 32, 0.55);
    color: #e5e7eb;
  }

  :global(:root[data-theme='dark']) .apple {
    background: #e5e7eb;
  }

  :global(:root[data-theme='dark']) .tray-icon.open {
    background: rgba(255, 255, 255, 0.16);
  }

  :global(:root[data-theme='dark']) .tray-menu,
  :global(:root[data-theme='dark']) .banner {
    background: rgba(32, 36, 46, 0.92);
    color: #f1f5f9;
    box-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.6);
  }

  :global(:root[data-theme='dark']) .tm-sep {
    background: rgba(255, 255, 255, 0.14);
  }

  :global(:root[data-theme='dark']) .bn-text {
    color: #f1f5f9;
  }

  :global(:root[data-theme='dark']) .bn-top {
    color: #9ca3af;
  }

  :global(:root[data-theme='dark']) .bn-body {
    color: #cbd5e1;
  }

  :global(:root[data-theme='dark']) .bn-icon {
    background: #1f2430;
  }

  :global(:root[data-theme='dark']) .dock {
    background: rgba(32, 36, 46, 0.45);
  }

  :global(:root[data-theme='dark']) .dk-app.rb {
    background: #1f2430;
  }

  :global(:root[data-theme='dark']) .dk-dot {
    background: #e5e7eb;
  }

  /* ── Phone ── */
  /* Left of the banner, so the notification that brought you here stays in view. */
  .phone {
    position: absolute;
    left: 600px;
    top: 44px;
    padding: 8px;
    border-radius: 44px;
    background: #16181d;
    box-shadow:
      0 30px 60px -20px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(255, 255, 255, 0.14) inset;
    opacity: 0;
    transform: translateX(140px);
    /* Invisible, it still sits over the window: it must not take the clicks meant for the app. */
    pointer-events: none;
    transition:
      opacity 400ms ease,
      transform 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .phone.on {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }

  /* clip-path, not just overflow with a radius: the scaled iframe is its own layer and ignored that. */
  .ph-screen {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 36px;
    clip-path: inset(0 round 36px);
    background: var(--app-pane);
  }

  .ph-status {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 22px 0 26px;
    font: 600 12px -apple-system, BlinkMacSystemFont, sans-serif;
    color: var(--app-ink);
  }

  .ph-island {
    position: absolute;
    left: 50%;
    top: 7px;
    width: 82px;
    height: 22px;
    margin-left: -41px;
    border-radius: 12px;
    background: #16181d;
  }

  .ph-bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 10px;
  }

  .ph-bars i {
    width: 3px;
    border-radius: 1px;
    background: var(--app-ink);
  }

  .ph-bars i:nth-child(1) {
    height: 4px;
  }

  .ph-bars i:nth-child(2) {
    height: 6px;
  }

  .ph-bars i:nth-child(3) {
    height: 8px;
  }

  .ph-bars i:nth-child(4) {
    height: 10px;
  }

  .ph-app {
    flex: none;
    position: relative;
    overflow: hidden;
  }

  .ph-app iframe {
    transform-origin: 0 0;
  }

  .ph-home {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ph-home i {
    width: 108px;
    height: 4px;
    border-radius: 2px;
    background: var(--app-ink);
    opacity: 0.85;
  }

  /* ── Cursor ── */
  .cursor {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 10;
    pointer-events: none;
    opacity: 0;
    transition:
      transform 340ms cubic-bezier(0.3, 0.8, 0.3, 1),
      opacity 200ms ease;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.35));
  }

  .cursor.visible {
    opacity: 1;
  }

  .cursor.dragging {
    transition: opacity 200ms ease;
  }

  .cursor path {
    fill: #0f172a;
    stroke: #ffffff;
  }

  .cursor svg {
    position: absolute;
    left: -5px;
    top: -4px;
  }

  .ripple {
    position: absolute;
    left: -13px;
    top: -13px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid var(--teal);
    opacity: 0;
    transform: scale(0.4);
  }

  .cursor.clicking .ripple {
    animation: ripple 340ms ease-out;
  }

  .fingertip {
    display: none;
    position: absolute;
    left: -12px;
    top: -12px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: rgba(15, 23, 42, 0.22);
    border: 1.5px solid rgba(255, 255, 255, 0.8);
  }

  .cursor.touch svg {
    display: none;
  }

  .cursor.touch .fingertip {
    display: block;
  }

  @keyframes ripple {
    0% {
      opacity: 0.9;
      transform: scale(0.4);
    }
    100% {
      opacity: 0;
      transform: scale(1.6);
    }
  }

  /* ── Trust points and end card ── */
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
