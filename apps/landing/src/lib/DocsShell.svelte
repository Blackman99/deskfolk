<script lang="ts">
  import { base } from '$app/paths';
  import Seo from '$lib/Seo.svelte';
  import { DOCS_NAV, docsNeighbors, docsPath, type DocsPageKey, type TocEntry } from '$lib/docs';
  import { DICT, type Lang } from '$lib/i18n';
  import { GITHUB_BLOB_MAIN } from '$lib/site';
  import type { Snippet } from 'svelte';

  let {
    lang,
    pageKey,
    description,
    tag,
    sourceFile,
    toc = [],
    suffix,
    children
  }: {
    lang: Lang;
    pageKey: DocsPageKey;
    description: string;
    tag: string;
    sourceFile: string;
    toc?: TocEntry[];
    suffix: string;
    children: Snippet;
  } = $props();

  const t = $derived(DICT[lang]);
  const copy = $derived(t.docs.pages[pageKey]);
  const neighbors = $derived(docsNeighbors(pageKey));

  /** The section being read, lit in "On this page". */
  let activeId = $state('');
  let tocSide: HTMLElement | undefined = $state();

  /**
   * The last heading that has scrolled above a reading line just under the nav (a heading jumped
   * to lands 16px under it). Once the page cannot scroll any further, the sections at the bottom
   * never reach that line: then the one jumped to, if it is in view, or else the last.
   */
  function readingSection(ids: string[]): string {
    const headings = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return '';
    const root = document.documentElement;
    const nav = parseFloat(getComputedStyle(root).getPropertyValue('--nav-h')) || 60;
    if (root.scrollTop + window.innerHeight >= root.scrollHeight - 2) {
      const target = decodeURIComponent(window.location.hash.slice(1));
      const el = headings.find((h) => h.id === target);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top >= nav && r.top < window.innerHeight) return target;
      }
      return headings[headings.length - 1].id;
    }
    // Sections side by side (the manifesto's topic cards) share a top: the row counts as one step,
    // lit on its first card unless the one jumped to sits in the same row.
    let current: HTMLElement | null = null;
    let currentTop = -Infinity;
    for (const el of headings) {
      const top = el.getBoundingClientRect().top;
      if (top > nav + 80) break;
      if (top > currentTop + 2) {
        current = el;
        currentTop = top;
      }
    }
    if (!current) return '';
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target && ids.includes(target.id) && Math.abs(target.getBoundingClientRect().top - currentTop) <= 2) {
      return target.id;
    }
    return current.id;
  }

  $effect(() => {
    const ids = toc.map((entry) => entry.id);
    if (ids.length < 2) return;
    const update = () => (activeId = readingSection(ids));
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('hashchange', update);
    };
  });

  // A long list scrolls on its own: keep the lit entry inside it, without moving the page.
  $effect(() => {
    const id = activeId;
    if (!id || !tocSide || tocSide.scrollHeight <= tocSide.clientHeight) return;
    const link = tocSide.querySelector<HTMLElement>(`a[data-id="${CSS.escape(id)}"]`);
    if (!link) return;
    const box = tocSide.getBoundingClientRect();
    const r = link.getBoundingClientRect();
    const pad = 32;
    if (r.top < box.top + pad) tocSide.scrollTop -= box.top + pad - r.top;
    else if (r.bottom > box.bottom - pad) tocSide.scrollTop += r.bottom - (box.bottom - pad);
  });

  function hrefFor(key: DocsPageKey): string {
    return `${base}/${lang}${docsPath(key)}`;
  }

  function tocHref(id: string): string {
    return `${hrefFor(pageKey)}#${id}`;
  }

  function isCurrent(key: DocsPageKey): boolean {
    return key === pageKey;
  }

  const isTopic = $derived(DOCS_NAV[0].pages.includes(pageKey) && pageKey !== 'manifesto');
  const section = $derived(
    pageKey === 'roadmap' ? t.nav.roadmap : pageKey === 'remote' ? t.docs.navGroup.guides : t.nav.manifesto
  );
</script>

<Seo
  {lang}
  title="{copy.title} — {section} — Deskfolk"
  {description}
  {suffix}
  imageAlt={t.seo.imageAlt}
/>

{#snippet tree()}
  {#each DOCS_NAV as group}
    <p class="group">{t.docs.navGroup[group.group]}</p>
    <ul>
      {#each group.pages as key}
        <li>
          <a href={hrefFor(key)} class:current={isCurrent(key)} aria-current={isCurrent(key) ? 'page' : undefined}>
            {t.docs.pages[key].title}
          </a>
        </li>
      {/each}
    </ul>
  {/each}
{/snippet}

<div class="docs page">
  <details class="rail rail-mobile">
    <summary>{t.docs.navLabel}</summary>
    <nav class="tree" aria-label={t.docs.navLabel}>
      {@render tree()}
    </nav>
  </details>

  <aside class="rail rail-side" aria-label={t.docs.navLabel}>
    <nav class="tree">
      {@render tree()}
    </nav>
  </aside>

  <div class="main">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="{base}/{lang}">Deskfolk</a>
      <span aria-hidden="true">/</span>
      {#if isTopic}
        <a href={hrefFor('manifesto')}>{t.nav.manifesto}</a>
        <span aria-hidden="true">/</span>
        <span>{copy.title}</span>
      {:else if pageKey === 'manifesto'}
        <span>{t.nav.manifesto}</span>
      {:else}
        <span>{copy.title}</span>
      {/if}
    </nav>

    <header class="head">
      <div class="kicker">
        <span class="tag mono" class:mustard={pageKey === 'roadmap' || pageKey === 'remote'}>{tag}</span>
        <a class="src" href="{GITHUB_BLOB_MAIN}/{sourceFile}" target="_blank" rel="noreferrer">{t.docs.source}</a>
      </div>
      <h1 class="serif">{copy.title}</h1>
      <p>{description}</p>
    </header>

    {#if toc.length > 1}
      <details class="toc toc-inline">
        <summary>{t.docs.onThisPage}</summary>
        <ol>
          {#each toc as entry}
            <li class="lv{entry.level}">
              <a href={tocHref(entry.id)} class:here={activeId === entry.id} aria-current={activeId === entry.id ? 'location' : undefined}>{entry.text}</a>
            </li>
          {/each}
        </ol>
      </details>
    {/if}

    {@render children()}

    <nav class="pager" aria-label="Pagination">
      {#if neighbors.prev}
        <a class="step prev" href={hrefFor(neighbors.prev)}>
          <span class="dir">{t.docs.pagerPrev}</span>
          <span class="name">{t.docs.pages[neighbors.prev].title}</span>
        </a>
      {/if}
      {#if neighbors.next}
        <a class="step next" href={hrefFor(neighbors.next)}>
          <span class="dir">{t.docs.pagerNext}</span>
          <span class="name">{t.docs.pages[neighbors.next].title}</span>
        </a>
      {/if}
    </nav>
  </div>

  {#if toc.length > 1}
    <nav class="toc toc-side" aria-label={t.docs.onThisPage} bind:this={tocSide}>
      <p class="toc-title">{t.docs.onThisPage}</p>
      <ol>
        {#each toc as entry}
          <li class="lv{entry.level}">
            <a
              href={tocHref(entry.id)}
              data-id={entry.id}
              class:here={activeId === entry.id}
              aria-current={activeId === entry.id ? 'location' : undefined}
            >{entry.text}</a>
          </li>
        {/each}
      </ol>
    </nav>
  {/if}
</div>

<style>
  .docs {
    display: grid;
    gap: 8px 40px;
    padding-block: 28px 96px;
    align-items: start;
  }

  .rail-side,
  .toc-side {
    display: none;
  }

  .rail-mobile {
    margin-bottom: 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    padding: 10px 14px;
  }

  .rail-mobile summary,
  .toc-inline summary {
    cursor: pointer;
    font-weight: 650;
    font-size: 14px;
  }

  .tree {
    font-size: 14px;
  }

  .group {
    margin: 16px 0 6px;
    font-size: 11.5px;
    font-weight: 650;
    letter-spacing: 0.04em;
    color: var(--ink-3);
  }

  .rail-mobile .group:first-child,
  .rail-side .group:first-child {
    margin-top: 4px;
  }

  .tree ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tree a {
    display: block;
    padding: 6px 10px;
    margin: 1px 0;
    border-radius: 7px;
    color: var(--ink-2);
    text-decoration: none;
    line-height: 1.35;
  }

  .tree a:hover {
    color: var(--teal-2);
    background: var(--teal-tint);
  }

  .tree a.current {
    color: var(--teal-2);
    background: var(--teal-tint);
    font-weight: 650;
  }

  .crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 13.5px;
    color: var(--ink-3);
    margin-bottom: 22px;
  }

  .crumbs a {
    color: var(--ink-2);
    text-decoration: none;
  }

  .crumbs a:hover {
    color: var(--teal-2);
  }

  .head {
    padding-bottom: 24px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--ink);
  }

  .kicker {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }

  .tag {
    display: inline-block;
    font-size: 12.5px;
    color: var(--teal-ink, var(--teal-2));
    background: var(--teal-tint);
    border: 1px solid var(--teal-line);
    border-radius: 6px;
    padding: 2px 8px;
  }

  .tag.mustard {
    color: var(--mustard-ink, var(--teal-2));
    background: var(--mustard-tint);
    border-color: var(--mustard-line);
  }

  .src {
    font-size: 13px;
    color: var(--ink-3);
    text-decoration: none;
  }

  .src:hover {
    color: var(--teal-2);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  h1 {
    margin: 0 0 12px;
    font-size: clamp(1.85rem, 3.4vw, 2.6rem);
    line-height: 1.2;
    font-weight: 700;
  }

  .head p {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.75;
    max-width: 42em;
  }

  .toc ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .toc a {
    display: block;
    padding: 4px 0;
    color: var(--ink-2);
    text-decoration: none;
    font-size: 13.5px;
    line-height: 1.45;
  }

  .toc a:hover,
  .toc a.here {
    color: var(--teal-2);
  }

  .toc a.here {
    font-weight: 600;
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

  .toc-inline ol {
    margin-top: 8px;
  }

  .toc-title {
    margin: 0 0 6px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--ink-3);
  }

  .main {
    min-width: 0;
    max-width: 44rem;
  }

  .pager {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid var(--line);
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 12rem;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    text-decoration: none;
    color: var(--ink);
    min-height: 72px;
  }

  .step:hover {
    border-color: var(--teal-line);
    color: var(--teal-2);
  }

  .step.next {
    margin-left: auto;
    text-align: right;
  }

  .dir {
    font-size: 12.5px;
    color: var(--ink-3);
  }

  .name {
    font-weight: 650;
    font-size: 15px;
  }

  :global(.markdown-body .term),
  :global(.markdown-body h2),
  :global(.markdown-body h3) {
    scroll-margin-top: calc(var(--nav-h) + 16px);
  }

  :global(.markdown-body > h2:first-child) {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }

  :global(.markdown-body p.avoid) {
    color: var(--ink-3);
    font-size: 0.92em;
    border-left: 2px solid var(--line);
    padding: 0.15em 0 0.15em 0.85em;
    margin: 0.35rem 0 1.7rem;
  }

  @media (min-width: 980px) {
    .docs {
      grid-template-columns: 220px minmax(0, 1fr);
    }

    .rail-mobile,
    .toc-inline {
      display: none;
    }

    .rail-side {
      display: block;
      position: sticky;
      top: calc(var(--nav-h) + 20px);
      max-height: calc(100vh - var(--nav-h) - 40px);
      overflow-y: auto;
      padding-right: 8px;
    }
  }

  @media (min-width: 1240px) {
    .docs {
      grid-template-columns: 220px minmax(0, 1fr) 200px;
    }

    .toc-side {
      display: block;
      position: sticky;
      top: calc(var(--nav-h) + 20px);
      max-height: calc(100vh - var(--nav-h) - 40px);
      overflow-y: auto;
      padding-left: 16px;
      border-left: 1px solid var(--line);
    }

    /* The lit entry marks the rail it hangs on, just inside it: the list clips what sticks out. */
    .toc-side a {
      position: relative;
    }

    .toc-side a.here::before {
      content: '';
      position: absolute;
      left: -16px;
      top: 4px;
      bottom: 4px;
      width: 2px;
      border-radius: 1px;
      background: var(--teal);
    }
  }
</style>
