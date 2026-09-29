<script lang="ts">
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import SiteFrame from '$lib/SiteFrame.svelte';
  import { DICT, type Lang } from '$lib/i18n';

  /** An unknown path still reads its language from its first segment. */
  const lang: Lang = $derived(/^\/en(\/|$)/.test(page.url.pathname.slice(base.length)) ? 'en' : 'zh');
  const t = $derived(DICT[lang]);
  const missing = $derived(page.status === 404);
</script>

<svelte:head>
  <title>{missing ? t.error.notFound : t.error.generic} — Deskfolk</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<SiteFrame {lang}>
  <section class="page oops">
    <p class="code mono">{page.status}</p>
    <h1 class="display">{missing ? t.error.notFound : t.error.generic}</h1>
    <p class="body">{missing ? t.error.body : page.error?.message}</p>
    <div class="actions">
      <a class="btn btn-primary" href="{base}/{lang}">{t.error.home}</a>
      <a class="btn btn-secondary" href="{base}/{lang}/docs">{t.error.docs}</a>
    </div>
  </section>
</SiteFrame>

<style>
  .oops {
    padding-block: 96px 128px;
    max-width: 40rem;
  }

  .code {
    margin: 0 0 12px;
    font-size: 14px;
    color: var(--ink-3);
  }

  h1 {
    margin: 0 0 14px;
    font-size: clamp(1.9rem, 4vw, 2.6rem);
    line-height: 1.2;
  }

  .body {
    margin: 0 0 28px;
    color: var(--ink-2);
    line-height: 1.75;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
</style>
