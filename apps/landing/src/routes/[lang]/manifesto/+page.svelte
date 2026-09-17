<script lang="ts">
  import { base } from '$app/paths';
  import { DICT, type Lang } from '$lib/i18n';
  import Seo from '$lib/Seo.svelte';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const doc = $derived(data.doc);
  const t = $derived(DICT[lang]);
</script>

<Seo {lang} title="{doc.title} — {t.nav.manifesto} — Real Bot" description={t.docs.manifestoIntro} suffix="/manifesto" imageAlt={t.seo.imageAlt} />

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

  <div class="doc-body">
    {#if doc.toc.length > 1}
      <details class="toc toc-inline">
        <summary>{t.docs.toc}</summary>
        <ol>
          {#each doc.toc as entry}
            <li class="lv{entry.level}"><a href="#{entry.id}">{entry.text}</a></li>
          {/each}
        </ol>
      </details>
      <nav class="toc toc-side" aria-label={t.docs.toc}>
        <p class="toc-title">{t.docs.toc}</p>
        <ol>
          {#each doc.toc as entry}
            <li class="lv{entry.level}"><a href="#{entry.id}">{entry.text}</a></li>
          {/each}
        </ol>
      </nav>
    {/if}

    <article class="markdown-body">
      {@html doc.contentHtml}
    </article>
  </div>

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

  .doc-body {
    position: relative;
  }

  .toc ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .toc li {
    margin: 0;
  }

  .toc a {
    display: block;
    padding: 4px 0;
    color: var(--ink-2);
    text-decoration: none;
    font-size: 13.5px;
    line-height: 1.45;
  }

  .toc a:hover {
    color: var(--teal-2);
  }

  .toc .lv3 a {
    padding-left: 14px;
    color: var(--ink-3);
  }

  .toc-inline {
    margin: 20px 0 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    padding: 10px 14px;
  }

  .toc-inline summary {
    cursor: pointer;
    font-weight: 650;
    font-size: 14px;
  }

  .toc-inline ol {
    margin-top: 8px;
    columns: 2;
    column-gap: 20px;
  }

  .toc-side {
    display: none;
  }

  .toc-title {
    margin: 0 0 6px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--ink-3);
  }

  :global(.markdown-body .term) {
    scroll-margin-top: calc(var(--nav-h) + 16px);
  }

  :global(.markdown-body h2),
  :global(.markdown-body h3) {
    scroll-margin-top: calc(var(--nav-h) + 16px);
  }

  @media (min-width: 1200px) {
    .doc {
      max-width: 1120px;
    }

    .doc-head,
    .crumbs,
    .doc-foot {
      max-width: 820px;
    }

    .doc-body {
      display: grid;
      grid-template-columns: minmax(0, 820px) 220px;
      column-gap: 56px;
      align-items: start;
    }

    .toc-inline {
      display: none;
    }

    .doc-body > :global(.markdown-body) {
      grid-column: 1;
      grid-row: 1;
    }

    .toc-side {
      grid-column: 2;
      grid-row: 1;
      display: block;
      position: sticky;
      top: calc(var(--nav-h) + 24px);
      max-height: calc(100vh - var(--nav-h) - 48px);
      overflow-y: auto;
      padding-left: 16px;
      border-left: 1px solid var(--line);
    }
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
