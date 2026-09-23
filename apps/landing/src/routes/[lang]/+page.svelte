<script lang="ts">
  import { base } from '$app/paths';
  import Walkthrough from '$lib/demo/Walkthrough.svelte';
  import Seo from '$lib/Seo.svelte';
  import CopyButton from '$lib/CopyButton.svelte';
  import { DICT, type Lang } from '$lib/i18n';
  import { GITHUB_URL, GITHUB_BLOB_MAIN, LATEST_RELEASE_URL } from '$lib/site';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const version: string = $derived(data.version);
  const cloneCommands = $derived(`git clone ${GITHUB_URL}.git\ncd real-bot\npnpm install\npnpm dev`);
</script>

<Seo {lang} title={t.seo.title} description={t.seo.description} imageAlt={t.seo.imageAlt} softwareSchema />

<Walkthrough {t} {lang} {version} />

<!-- Boundaries -->
<section class="boundaries" id="boundaries">
  <div class="page">
    <header class="sec-head">
      <h2 class="serif">{t.boundaries.heading}</h2>
      <p>{t.boundaries.intro}</p>
    </header>

    <div class="ledger" role="table">
      <div class="ledger-row head" role="row">
        <span role="columnheader" class="dim"></span>
        <span role="columnheader" class="col live"><i class="mark"></i>{t.boundaries.colLive}</span>
        <span role="columnheader" class="col wip"><i class="mark"></i>{t.boundaries.colWip}</span>
        <span role="columnheader" class="col avoid"><i class="mark"></i>{t.boundaries.colAvoid}</span>
      </div>
      {#each t.boundaries.rows as row}
        <div class="ledger-row" role="row">
          <span class="dim serif" role="rowheader">{row.dim}</span>
          <span class="col live" role="cell"><b>{t.boundaries.colLive}</b>{row.live}</span>
          <span class="col wip" role="cell"><b>{t.boundaries.colWip}</b>{row.wip}</span>
          <span class="col avoid" role="cell"><b>{t.boundaries.colAvoid}</b>{row.avoid}</span>
        </div>
      {/each}
    </div>
    <p class="footnote">
      {t.boundaries.footnote[0]}<a class="text-link" href="{base}/{lang}/roadmap">{t.nav.roadmap}</a>{t.boundaries.footnote[1]}<a class="text-link" href="{base}/{lang}/manifesto">CONTEXT.md</a>{t.boundaries.footnote[2]}
    </p>
  </div>
</section>

<!-- Quickstart -->
<section class="quickstart" id="quickstart">
  <div class="page qs-grid">
    <div class="qs-copy">
      <h2 class="serif">{t.quickstart.heading}</h2>
      <p>{t.quickstart.intro}</p>
      <p class="req">{t.quickstart.requirements}</p>
      <ol class="first-run">
        {#each t.quickstart.firstRun as item}
          <li>{item}</li>
        {/each}
      </ol>
      <div class="qs-links">
        <a class="text-link" href="{GITHUB_BLOB_MAIN}/docs/development.md" target="_blank" rel="noreferrer">{t.quickstart.linkDocs}</a>
        <a class="text-link" href="{base}/{lang}/manifesto">{t.quickstart.linkManifesto}</a>
        <a class="text-link" href="{base}/{lang}/roadmap">{t.quickstart.linkRoadmap}</a>
        <a class="text-link" href={GITHUB_URL} target="_blank" rel="noreferrer">{t.nav.github}</a>
      </div>
    </div>

    <div class="qs-side">
      <div class="download">
        <div class="dl-head">
          <h3 class="serif">{t.quickstart.download.title}</h3>
          <span class="version mono">v{version}</span>
        </div>
        <p>{t.quickstart.download.body}</p>
        <div class="dl-note-row">
          <pre class="mono dl-note">{t.quickstart.download.note}</pre>
          <CopyButton text={t.quickstart.download.note} label={t.hero.copy} doneLabel={t.hero.copied} compact />
        </div>
        <a class="btn btn-primary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">{t.quickstart.download.link}</a>
      </div>

    <div class="terminal" aria-label="Terminal">
      <div class="term-bar">
        <span class="l r"></span><span class="l y"></span><span class="l g"></span>
        <span class="term-title mono">zsh — real-bot</span>
        <span class="term-copy"><CopyButton text={cloneCommands} label={t.hero.copy} doneLabel={t.hero.copied} compact /></span>
      </div>
      <pre class="mono"><span class="c"># {t.quickstart.step1}</span>
<span class="p">$</span> git clone {GITHUB_URL}.git
<span class="p">$</span> cd real-bot
<span class="p">$</span> pnpm install

<span class="c"># {t.quickstart.step2}</span>
<span class="p">$</span> pnpm dev</pre>
    </div>
    </div>
  </div>
</section>

<style>
  .sec-head {
    max-width: 44em;
    margin-bottom: 36px;
  }

  h2 {
    margin: 0 0 14px;
    font-size: clamp(1.6rem, 2.8vw, 2.25rem);
    line-height: 1.28;
    font-weight: 700;
    text-wrap: balance;
  }

  .sec-head p,
  .qs-copy p {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.75;
  }

  /* ── Boundaries ledger ── */
  .boundaries {
    padding-block: 72px 80px;
    border-top: 1px solid var(--line);
  }

  .ledger {
    border-top: 1px solid var(--ink);
  }

  .ledger-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px 28px;
    padding-block: 20px;
    border-bottom: 1px solid var(--line);
  }

  .ledger-row.head {
    display: none;
  }

  .dim {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--ink);
  }

  .col {
    display: block;
    font-size: 15px;
    line-height: 1.65;
    color: var(--ink-2);
    padding-left: 14px;
    border-left: 2px solid var(--line);
  }

  .col b {
    display: block;
    font-size: 12.5px;
    font-weight: 650;
    margin-bottom: 2px;
  }

  .col.live { border-left-color: var(--teal); }
  .col.live b { color: var(--teal); }
  .col.wip { border-left-color: var(--mustard); }
  .col.wip b { color: var(--mustard-ink); }
  .col.avoid { border-left-color: var(--ink-3); }
  .col.avoid b { color: var(--ink-3); }

  .footnote {
    margin: 18px 0 0;
    font-size: 13.5px;
    color: var(--ink-3);
  }

  @media (min-width: 900px) {
    .ledger-row {
      grid-template-columns: 1.1fr 2fr 1.6fr 1.5fr;
      padding-block: 22px;
    }

    .ledger-row.head {
      display: grid;
      padding-block: 12px;
      border-bottom-color: var(--ink);
    }

    .head .col {
      border-left: 0;
      padding-left: 0;
      font-size: 13px;
      font-weight: 650;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .head .col.live { color: var(--teal); }
    .head .col.wip { color: var(--mustard-ink); }
    .head .col.avoid { color: var(--ink-3); }

    .mark {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      background: currentColor;
      display: inline-block;
    }

    .col b {
      display: none;
    }

    .col {
      border-left: 0;
      padding-left: 0;
    }

    .dim {
      font-size: 1.1rem;
      padding-right: 12px;
    }
  }

  /* ── Quickstart ── */
  .quickstart {
    padding-block: 72px 96px;
    border-top: 1px solid var(--line);
  }

  .qs-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 36px;
    align-items: start;
  }

  .qs-copy p + p {
    margin-top: 12px;
  }

  .req {
    font-size: 14.5px;
    color: var(--ink-3);
  }

  .first-run {
    list-style: decimal;
    margin: 22px 0 0;
    padding-left: 1.4em;
    color: var(--ink-2);
    line-height: 1.7;
    font-size: 15px;
  }

  .first-run li + li {
    margin-top: 6px;
  }

  .first-run li::marker {
    font-family: var(--font-serif);
    color: var(--teal);
  }

  .qs-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 22px;
    margin-top: 26px;
    font-size: 15px;
  }

  .qs-side {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .download {
    padding: 22px 24px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--paper);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .dl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .download h3 {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 700;
    line-height: 1.3;
  }

  .version {
    font-size: 12.5px;
    color: var(--ink-3);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 2px 8px;
  }

  .dl-note-row {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }

  .dl-note-row .dl-note {
    flex: 1;
    min-width: 0;
  }

  .download p {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.7;
    font-size: 15px;
  }

  .dl-note {
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--ground);
    border: 1px solid var(--line);
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink);
  }

  .download .btn {
    align-self: flex-start;
    margin-top: 4px;
  }

  .terminal {
    border-radius: 12px;
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: var(--shadow-float);
    overflow: hidden;
  }

  .term-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 12px 14px;
    background: #182236;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .l { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  .l.r { background: #ff5f57; }
  .l.y { background: #febc2e; }
  .l.g { background: #28c840; }

  .term-title {
    margin-left: 8px;
    font-size: 12px;
    color: #94a3b8;
    flex: 1;
  }

  .term-copy :global(.copy) {
    color: #cbd5e1;
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.14);
  }

  .term-copy :global(.copy:hover) {
    color: #fff;
    border-color: rgba(255, 255, 255, 0.3);
  }

  pre {
    margin: 0;
    padding: 18px 20px 22px;
    font-size: 13.5px;
    line-height: 1.8;
    overflow-x: auto;
  }

  pre .c { color: #7c8a9e; }
  pre .p { color: #5ebbcc; }

  @media (min-width: 900px) {
    .qs-grid {
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
      gap: 56px;
    }

    .qs-side {
      position: sticky;
      top: calc(var(--nav-h) + 24px);
    }
  }
</style>
