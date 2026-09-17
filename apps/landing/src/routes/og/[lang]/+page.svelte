<script lang="ts">
  import { dev } from '$app/environment';
  import AppMock from '$lib/demo/AppMock.svelte';
  import Logo from '$lib/Logo.svelte';
  import { DICT, type Lang } from '$lib/i18n';
  import { GITHUB_OWNER, GITHUB_REPO } from '$lib/site';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const siteLabel = `${GITHUB_OWNER.toLowerCase()}.github.io/${GITHUB_REPO}`;
</script>

<svelte:head>
  <title>OG image studio — Real Bot</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if dev}
  <div class="og" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
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
      <div class="scaler">
        <AppMock scene={0} {t} instant />
      </div>
    </div>
  </div>
{:else}
  <p>Development only.</p>
{/if}

<style>
  :global(html),
  :global(body) {
    background: #eef2f7;
  }

  .og {
    position: relative;
    width: 1200px;
    height: 630px;
    overflow: hidden;
    background:
      radial-gradient(900px 500px at 105% 110%, #e3f0f2 0%, rgba(227, 240, 242, 0) 60%),
      #eef2f7;
    color: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', system-ui, sans-serif;
  }

  .copy {
    position: absolute;
    left: 64px;
    top: 56px;
    bottom: 56px;
    width: 560px;
    display: flex;
    flex-direction: column;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .brand-name {
    font-family: 'Iowan Old Style', 'Charter', 'Songti SC', Georgia, serif;
    font-size: 34px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .wip {
    margin-left: 6px;
    font-size: 15px;
    font-weight: 600;
    color: #8a5a08;
    background: #fdf3e1;
    border: 1px solid #f3d08e;
    border-radius: 999px;
    padding: 3px 12px;
  }

  h1 {
    margin: 48px 0 0;
    font-family: 'Iowan Old Style', 'Charter', 'Songti SC', Georgia, serif;
    font-size: 58px;
    line-height: 1.22;
    font-weight: 700;
    letter-spacing: -0.01em;
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
    color: #475569;
    max-width: 520px;
  }

  .url {
    margin: auto 0 0;
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 17px;
    color: #146a7c;
  }

  .window {
    position: absolute;
    left: 660px;
    top: 90px;
    width: 720px;
    height: 464px;
    border-radius: 12px;
    box-shadow: 0 40px 80px -30px rgba(15, 23, 42, 0.45), 0 12px 28px -10px rgba(15, 23, 42, 0.25);
    overflow: hidden;
  }

  .scaler {
    width: 900px;
    height: 580px;
    transform: scale(0.8);
    transform-origin: 0 0;
  }
</style>
