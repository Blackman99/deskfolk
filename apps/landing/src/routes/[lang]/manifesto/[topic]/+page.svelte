<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import DocsShell from '$lib/DocsShell.svelte';
  import { decodeHash } from '$lib/docs';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const topic = $derived(data.topic);

  const AVOID_KEY = 'deskfolk-docs-show-avoid';
  let showAvoid = $state(false);

  $effect(() => {
    try {
      showAvoid = localStorage.getItem(AVOID_KEY) === '1';
    } catch {
      // No storage (private window, blocked site data): the avoid lines stay folded.
    }
  });

  function toggleAvoid() {
    showAvoid = !showAvoid;
    try {
      localStorage.setItem(AVOID_KEY, showAvoid ? '1' : '0');
    } catch {
      // Remembering the choice is a convenience only.
    }
  }

  /**
   * A hash from before anchors were keyed by English name is swapped for the one the term has now;
   * a hash on a term's behavior details unfolds them.
   */
  function landOnHash() {
    const raw = decodeHash(window.location.hash);
    if (!raw) return;
    const current = data.doc.aliases[raw];
    if (current) {
      history.replaceState(history.state, '', `#${current}`);
      document.getElementById(current)?.scrollIntoView();
      return;
    }
    const target = document.getElementById(raw);
    if (target instanceof HTMLDetailsElement && !target.open) {
      target.open = true;
      target.scrollIntoView();
    }
  }

  afterNavigate(landOnHash);
  $effect(() => {
    window.addEventListener('hashchange', landOnHash);
    return () => window.removeEventListener('hashchange', landOnHash);
  });
</script>

<DocsShell {lang} pageKey={topic} sourceFile={data.source} toc={data.doc.toc}>
  <div class="tools">
    <button
      type="button"
      class="avoid-toggle"
      aria-pressed={showAvoid}
      title={t.docs.avoidToggleHint}
      onclick={toggleAvoid}
    >
      <span class="box" aria-hidden="true"></span>
      {t.docs.avoidToggle}
    </button>
  </div>
  <article class="markdown-body" class:hide-avoid={!showAvoid}>
    {@html data.doc.contentHtml}
  </article>
</DocsShell>

<style>
  .tools {
    display: flex;
    justify-content: flex-end;
    margin: 14px 0 -6px;
  }

  .avoid-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: inherit;
    font-size: 13px;
    color: var(--ink-3);
    background: none;
    border: 0;
    padding: 6px 2px;
    min-height: 32px;
    cursor: pointer;
  }

  .avoid-toggle:hover {
    color: var(--teal-2);
  }

  .box {
    width: 14px;
    height: 14px;
    border: 1.5px solid currentColor;
    border-radius: 4px;
    display: grid;
    place-items: center;
  }

  .avoid-toggle[aria-pressed='true'] {
    color: var(--ink-2);
  }

  .avoid-toggle[aria-pressed='true'] .box {
    border-color: var(--teal);
    background: var(--teal);
    box-shadow: inset 0 0 0 2px var(--paper);
  }

  .hide-avoid :global(p.avoid) {
    display: none;
  }
</style>
