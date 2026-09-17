<script lang="ts">
  import { base } from '$app/paths';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const doc = $derived(data.doc);
  const t = $derived(DICT[lang]);
</script>

<svelte:head>
  <title>{doc.title} — {t.nav.manifesto} — Real Bot</title>
</svelte:head>

<div class="doc page">
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="{base}/{lang}">Real Bot</a>
    <span aria-hidden="true">/</span>
    <span>{t.nav.manifesto}</span>
  </nav>

  <header class="doc-head">
    <span class="doc-tag mono">{t.docs.manifestoTag}</span>
    <h1 class="serif">{doc.title}</h1>
    <p>{t.docs.manifestoIntro}</p>
  </header>

  <article class="markdown-body">
    {@html doc.contentHtml}
  </article>

  <footer class="doc-foot">
    <a class="text-link" href="{base}/{lang}">{t.docs.backHome}</a>
    <a class="text-link" href="{base}/{lang}/roadmap">{t.docs.toRoadmap}</a>
  </footer>
</div>

<style>
  .doc {
    max-width: 820px;
    padding-block: 40px 96px;
  }

  .crumbs {
    display: flex;
    gap: 10px;
    font-size: 13.5px;
    color: var(--ink-3);
    margin-bottom: 28px;
  }

  .crumbs a {
    color: var(--ink-2);
    text-decoration: none;
  }

  .crumbs a:hover {
    color: var(--teal-2);
  }

  .doc-head {
    padding-bottom: 28px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--ink);
  }

  .doc-tag {
    display: inline-block;
    font-size: 12.5px;
    color: var(--teal-ink, var(--teal-2));
    background: var(--teal-tint);
    border: 1px solid var(--teal-line);
    border-radius: 6px;
    padding: 2px 8px;
    margin-bottom: 16px;
  }

  h1 {
    margin: 0 0 14px;
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.2;
    font-weight: 700;
  }

  .doc-head p {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.75;
    max-width: 40em;
  }

  .doc-foot {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-top: 56px;
    padding-top: 24px;
    border-top: 1px solid var(--line);
    font-size: 15px;
  }
</style>
