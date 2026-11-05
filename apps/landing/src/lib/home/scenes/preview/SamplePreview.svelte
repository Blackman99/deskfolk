<script lang="ts">
  import { base } from '$app/paths';
  import type { Lang } from '$lib/i18n';
  import type { SceneCopy } from '../../copy';

  /**
   * One of the five sample files, drawn in the page: a picture, a film, a PDF page, a spreadsheet
   * or a Markdown note. Everything is built from the copy's strings as plain elements.
   */
  let {
    which,
    copy,
    lang
  }: { which: 'poster' | 'film' | 'pdf' | 'sheet' | 'doc'; copy: SceneCopy['preview']; lang: Lang } = $props();

  // The kettle film a Bot really made in a demo run (scripts/reel/assets/kettle.mp4), and a frame of it.
  const poster = `${base}/media/sample-poster.jpg`;
  const letters = ['A', 'B', 'C'];
  const rows = $derived([copy.sheet.head, ...copy.sheet.rows]);
  const heading = $derived(copy.docLines[0].replace(/^#+\s*/, ''));
  const bullets = $derived(copy.docLines.slice(1).map((l) => l.replace(/^-\s+/, '')));
</script>

{#if which === 'poster'}
  <img class="media" src={poster} alt={copy.samples.poster} width="360" height="640" />
{:else if which === 'film'}
  <!-- svelte-ignore a11y_media_has_caption -->
  <video class="media" src="{base}/media/sample-kettle.mp4" {poster} preload="none" muted playsinline loop controls aria-label={copy.samples.film}></video>
{:else if which === 'pdf'}
  <div class="pdf">
    <div class="page">
      <p class="h">{copy.pdfLines[0]}</p>
      {#each copy.pdfLines.slice(1) as line}<p>{line}</p>{/each}
      <i class="rule"></i><i class="rule short"></i><i class="rule"></i>
    </div>
    <span class="counter">1 / 1</span>
  </div>
{:else if which === 'sheet'}
  <div class="sheet">
    <table aria-label={copy.samples.sheet}>
      <thead>
        <tr><th class="corner"></th>{#each letters as l}<th>{l}</th>{/each}</tr>
      </thead>
      <tbody>
        {#each rows as row, r}
          <tr>
            <th class="rown">{r + 1}</th>
            {#each row as cell, c}
              <td class:head={r === 0} class:sel={r === 2 && c === 1}>{cell}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="doc">
    <h4>{heading}</h4>
    <ul>{#each bullets as b}<li>{b}</li>{/each}</ul>
  </div>
{/if}

<style>
  .media {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: var(--ground-2);
  }

  .pdf {
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 14px;
    box-sizing: border-box;
    overflow: hidden;
    background: var(--ground-2);
    position: relative;
    container-type: size;
  }

  .page {
    /* A4 sheet; on a short area it is cut off at the bottom, as a page scrolled into view is. */
    width: max(200px, min(calc(100cqw - 24px), calc((100cqh - 28px) / 1.414)));
    aspect-ratio: 210 / 297;
    background: #fff;
    color: #121c20;
    box-shadow: 0 6px 18px -6px rgba(18, 28, 32, 0.4), 0 0 0 1px rgba(18, 28, 32, 0.08);
    padding: 9%;
    container-type: inline-size;
    overflow: hidden;
  }

  .page p {
    margin: 0 0 4.5cqw;
    font-size: 5.4cqw;
    line-height: 1.45;
  }

  .page .h {
    font-size: 7.4cqw;
    font-weight: 700;
    margin-bottom: 7cqw;
  }

  .rule {
    display: block;
    height: 1.4cqw;
    margin-top: 4cqw;
    border-radius: 2px;
    background: #d8e0e2;
  }

  .rule.short {
    width: 60%;
  }

  .counter {
    position: absolute;
    bottom: 6px;
    right: 8px;
    font: 11px var(--font-mono);
    padding: 1px 7px;
    border-radius: var(--radius-full);
    background: var(--paper);
    color: var(--ink-2);
    border: 1px solid var(--line);
  }

  .sheet {
    height: 100%;
    overflow: auto;
    background: var(--paper);
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12.5px;
    table-layout: fixed;
  }

  th,
  td {
    border: 1px solid var(--line);
    padding: 5px 8px;
    text-align: left;
    color: var(--ink);
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  thead th,
  .rown {
    background: var(--ground);
    color: var(--ink-3);
    font-size: 11px;
    text-align: center;
  }

  .corner,
  .rown {
    width: 32px;
  }

  td.head {
    font-weight: 600;
    background: var(--ground-2);
  }

  td.sel {
    outline: 2px solid var(--teal);
    outline-offset: -2px;
    background: var(--teal-tint);
  }

  .doc {
    height: 100%;
    overflow: auto;
    background: var(--paper);
    color: var(--ink);
    padding: 18px 22px;
  }

  h4 {
    margin: 0 0 10px;
    font: 700 20px/1.25 var(--font-display);
  }

  ul {
    margin: 0;
    padding-left: 20px;
    font-size: 14px;
    line-height: 1.9;
  }

  li::marker {
    color: var(--teal);
  }
</style>
