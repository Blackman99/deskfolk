<script lang="ts">
  import { dev } from '$app/environment';
  import AppMock from '$lib/demo/AppMock.svelte';
  import Logo from '$lib/Logo.svelte';
  import { DICT, type Lang } from '$lib/i18n';
  import { GITHUB_OWNER, GITHUB_REPO } from '$lib/site';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const variant = $derived(data.variant);
  const theme = $derived(data.theme);
  const siteLabel = `${GITHUB_OWNER.toLowerCase()}.github.io/${GITHUB_REPO}`;

  const SIZES = {
    og: { w: 1200, h: 630 },
    social: { w: 1280, h: 640 },
    hero: { w: 1600, h: 900 }
  } as const;
  const size = $derived(SIZES[variant]);

  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  });
</script>

<svelte:head>
  <title>Brand image studio — Real Bot</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if dev}
  <div class="og {variant}" lang={lang === 'zh' ? 'zh-CN' : 'en'} style:width="{size.w}px" style:height="{size.h}px">
    {#if variant === 'hero'}
      <!-- Montage: group collaboration, a pending approval card, the artifact editor. -->
      <div class="win-a">
        <div class="scaler" style:transform="scale(0.95)"><AppMock scene={0} {t} instant /></div>
      </div>
      <div class="win-c">
        <div class="scaler" style:transform="scale(0.58)"><AppMock scene={5} {t} instant frozenBeat={3} /></div>
      </div>
      <div class="win-b">
        <div class="scaler" style:transform="scale(0.66)"><AppMock scene={7} {t} instant /></div>
      </div>
    {:else}
      <div class="copy">
        <div class="brand">
          <Logo size={44} />
          <span class="brand-name">Real Bot</span>
          <span class="wip">{t.nav.wip}</span>
        </div>
        <h1>
          {#each t.hero.headlineLines as line, i}{#if i > 0}<br />{/if}<span>{line}</span>{/each}
        </h1>
        <p class="tagline">{t.footer.tagline}{lang === 'zh' ? ' MIT 开源。' : ' Open source under MIT.'}</p>
        <p class="url">{siteLabel}</p>
      </div>
      <div class="window">
        <div class="scaler" style:transform="scale(0.8)"><AppMock scene={0} {t} instant /></div>
      </div>
    {/if}
  </div>
{:else}
  <p>Development only.</p>
{/if}

<style>
  :global(html),
  :global(body) {
    background: var(--ground);
  }

  .og {
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(900px 500px at 105% 110%, var(--teal-tint) 0%, transparent 60%),
      var(--ground);
    color: var(--ink);
    font-family: var(--font-sans);
  }

  .hero {
    background:
      radial-gradient(1100px 700px at 100% 0%, var(--teal-tint) 0%, transparent 60%),
      radial-gradient(900px 600px at 0% 100%, var(--mustard-tint) 0%, transparent 55%),
      var(--ground);
  }

  /* ── Open Graph / social preview ── */
  .copy {
    position: absolute;
    left: 64px;
    top: 56px;
    bottom: 56px;
    width: 560px;
    display: flex;
    flex-direction: column;
  }

  .social .copy {
    left: 72px;
    top: 64px;
    bottom: 64px;
    width: 600px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .brand-name,
  h1 {
    font-family: var(--font-serif);
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .brand-name {
    font-size: 34px;
  }

  .wip {
    margin-left: 6px;
    font-size: 15px;
    font-weight: 600;
    color: var(--mustard-ink);
    background: var(--mustard-tint);
    border: 1px solid var(--mustard-line);
    border-radius: 999px;
    padding: 3px 12px;
  }

  h1 {
    margin: 48px 0 0;
    font-size: 58px;
    line-height: 1.22;
  }

  .og[lang='en'] h1 {
    font-size: 50px;
    line-height: 1.14;
    letter-spacing: -0.015em;
  }

  h1 span {
    display: inline-block;
  }

  .tagline {
    margin: 28px 0 0;
    font-size: 21px;
    line-height: 1.55;
    color: var(--ink-2);
    max-width: 520px;
  }

  .url {
    margin: auto 0 0;
    font-family: var(--font-mono);
    font-size: 17px;
    color: var(--teal);
  }

  .window,
  .win-a,
  .win-b,
  .win-c {
    position: absolute;
    border-radius: 12px;
    box-shadow: var(--shadow-window);
    overflow: hidden;
  }

  .window {
    left: 660px;
    top: 90px;
    width: 720px;
    height: 464px;
  }

  .social .window {
    left: 720px;
    top: 96px;
  }

  .scaler {
    width: 900px;
    height: 580px;
    transform-origin: 0 0;
  }

  /* ── README hero montage ── */
  .win-a {
    left: 72px;
    top: 168px;
    width: 855px;
    height: 551px;
    z-index: 1;
  }

  .win-c {
    left: 990px;
    top: 72px;
    width: 522px;
    height: 336px;
    z-index: 2;
  }

  .win-b {
    left: 900px;
    top: 452px;
    width: 594px;
    height: 383px;
    z-index: 3;
  }
</style>
