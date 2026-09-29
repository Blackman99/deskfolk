<script lang="ts">
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import DocsShell from '$lib/DocsShell.svelte';
  import { decodeHash, docsPath, resolveTermHash } from '$lib/docs';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const toc = $derived(
    data.index.map((entry) => ({
      id: entry.topic,
      text: t.docs.pages[entry.topic].title,
      level: 2
    }))
  );

  // A term linked on the hub (CONTEXT.md#term, or an anchor from before the rename) lives on its
  // topic page; a topic card's own anchor (#workspace) stays here.
  onMount(() => {
    if (document.getElementById(decodeHash(window.location.hash))) return;
    const term = resolveTermHash(window.location.hash, data.termTargets, data.termAliases);
    if (!term) return;
    window.location.replace(`${base}/${lang}${term.path}#${term.id}`);
  });
</script>

<DocsShell {lang} pageKey="manifesto" sourceFile={data.source} {toc}>
  <article class="markdown-body">
    {@html data.preambleHtml}
  </article>

  <section class="index" aria-labelledby="topic-index">
    <h2 id="topic-index" class="display">{t.docs.manifestoIndexHeading}</h2>
    <p class="lead">{t.docs.manifestoIndexLead}</p>
    <div class="cards">
      {#each data.index as entry}
        <section class="card" id={entry.topic}>
          <h3>
            <a href="{base}/{lang}{docsPath(entry.topic)}">{t.docs.pages[entry.topic].title}</a>
          </h3>
          <p>{t.docs.pages[entry.topic].blurb}</p>
          <ul>
            {#each entry.terms as term}
              <li>
                <a class="term-name" href="{base}/{lang}{docsPath(entry.topic)}#{term.id}">{term.name}</a>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </section>
</DocsShell>

<style>
  .index {
    margin-top: 40px;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 1.45rem;
    font-weight: 700;
  }

  .lead {
    margin: 0 0 22px;
    color: var(--ink-2);
    max-width: 40em;
  }

  .cards {
    display: grid;
    gap: 12px;
    grid-template-columns: 1fr;
  }

  .card {
    padding: 16px 18px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--paper);
    scroll-margin-top: calc(var(--nav-h) + 16px);
  }

  .card h3 {
    margin: 0 0 4px;
    font-size: 1.05rem;
    font-weight: 650;
  }

  .card h3 a {
    color: inherit;
    text-decoration: none;
  }

  .card h3 a:hover {
    color: var(--teal-2);
  }

  .card p {
    margin: 0 0 10px;
    color: var(--ink-2);
    font-size: 14px;
  }

  .card ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
  }

  .term-name {
    font-size: 13px;
    color: var(--ink-3);
    text-decoration: none;
  }

  .term-name:hover {
    color: var(--teal-2);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  @media (min-width: 720px) {
    .cards {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
