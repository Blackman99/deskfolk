<script lang="ts">
  import { base } from '$app/paths';
  import DocsShell from '$lib/DocsShell.svelte';
  import DocsSearch from '$lib/DocsSearch.svelte';
  import { DOCS_NAV, MANIFESTO_TOPICS, docsPath } from '$lib/docs';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const groups = $derived(
    DOCS_NAV.map((g) => ({
      ...g,
      pages: g.pages.filter((key) => key !== 'docs' && !(MANIFESTO_TOPICS as readonly string[]).includes(key))
    }))
  );
  const toc = $derived(groups.map((g) => ({ id: g.group, text: t.docs.navGroup[g.group], level: 2 })));
</script>

<DocsShell {lang} pageKey="docs" {toc}>
  <div class="home-search">
    <DocsSearch {lang} large />
  </div>

  {#each groups as group}
    <section class="group" id={group.group} aria-labelledby="{group.group}-heading">
      <h2 id="{group.group}-heading" class="serif">{t.docs.navGroup[group.group]}</h2>
      <div class="cards">
        {#each group.pages as key}
          <a class="card" href="{base}/{lang}{docsPath(key)}">
            <span class="title">{t.docs.pages[key].title}</span>
            <span class="blurb">{t.docs.pages[key].blurb}</span>
          </a>
        {/each}
        {#if group.group === 'glossary'}
          {#each MANIFESTO_TOPICS as topic}
            <a class="card topic" href="{base}/{lang}{docsPath(topic)}">
              <span class="title">{t.docs.pages[topic].title}</span>
              <span class="blurb">{t.docs.pages[topic].blurb}</span>
            </a>
          {/each}
        {/if}
      </div>
    </section>
  {/each}
</DocsShell>

<style>
  .home-search {
    margin: 28px 0 8px;
  }

  .group {
    margin-top: 36px;
    scroll-margin-top: calc(var(--nav-h) + 16px);
  }

  h2 {
    margin: 0 0 14px;
    font-size: 1.35rem;
    font-weight: 700;
  }

  .cards {
    display: grid;
    gap: 12px;
    grid-template-columns: 1fr;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--paper);
    color: var(--ink);
    text-decoration: none;
  }

  .card:hover {
    border-color: var(--teal-line);
  }

  .card:hover .title {
    color: var(--teal-2);
  }

  .title {
    font-weight: 650;
    font-size: 15.5px;
  }

  .blurb {
    color: var(--ink-2);
    font-size: 14px;
    line-height: 1.55;
  }

  .card.topic {
    padding: 12px 16px;
  }

  .card.topic .title {
    font-size: 14.5px;
  }

  .card.topic .blurb {
    font-size: 13px;
    color: var(--ink-3);
  }

  @media (min-width: 720px) {
    .cards {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
