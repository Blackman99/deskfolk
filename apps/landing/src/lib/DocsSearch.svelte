<script lang="ts">
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { DICT, type Lang } from '$lib/i18n';

  type Entry = { page: string; title: string; href: string; text: string };
  type Part = { text: string; hit: boolean };
  type Result = { entry: Entry; title: Part[]; snippet: Part[] };

  let { lang, large = false }: { lang: Lang; large?: boolean } = $props();
  const t = $derived(DICT[lang]);

  const LIMIT = 12;
  /** Characters of context kept before the first hit in a snippet. */
  const LEAD = 24;
  const SNIPPET = 96;

  let query = $state('');
  let index: Entry[] | null = $state(null);
  let loading = $state(false);
  let open = $state(false);
  let active = $state(0);
  const uid = $props.id();
  const listId = `docs-search-${uid}`;

  /** The index is fetched once, the first time a search box is used. */
  let pending: Promise<void> | null = null;
  function load() {
    if (index || pending) return;
    loading = true;
    pending = fetch(`${base}/${lang}/docs/search.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Entry[]) => {
        index = rows;
      })
      .catch(() => {
        index = [];
      })
      .finally(() => (loading = false));
  }

  function words(q: string): string[] {
    return q.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function split(text: string, terms: string[]): Part[] {
    const lower = text.toLowerCase();
    const marks: [number, number][] = [];
    for (const term of terms) {
      let at = lower.indexOf(term);
      while (at >= 0) {
        marks.push([at, at + term.length]);
        at = lower.indexOf(term, at + term.length);
      }
    }
    marks.sort((a, b) => a[0] - b[0]);
    const parts: Part[] = [];
    let pos = 0;
    for (const [from, to] of marks) {
      if (to <= pos) continue;
      const start = Math.max(from, pos);
      if (start > pos) parts.push({ text: text.slice(pos, start), hit: false });
      parts.push({ text: text.slice(start, to), hit: true });
      pos = to;
    }
    if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
    return parts;
  }

  function snippet(text: string, terms: string[]): string {
    const lower = text.toLowerCase();
    const first = Math.min(...terms.map((w) => lower.indexOf(w)).filter((i) => i >= 0));
    if (!Number.isFinite(first) || first < LEAD) {
      return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
    }
    const start = first - LEAD;
    const end = start + SNIPPET;
    return `…${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }

  const results: Result[] = $derived.by(() => {
    const terms = words(query);
    if (!index || terms.length === 0) return [];
    const scored: { entry: Entry; score: number; order: number }[] = [];
    index.forEach((entry, order) => {
      const title = entry.title.toLowerCase();
      const hay = `${title} ${entry.page.toLowerCase()} ${entry.text.toLowerCase()}`;
      if (!terms.every((w) => hay.includes(w))) return;
      let score = 0;
      if (title.includes(query.trim().toLowerCase())) score += 10;
      if (title.startsWith(terms[0])) score += 4;
      for (const w of terms) if (title.includes(w)) score += 3;
      scored.push({ entry, score, order });
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.slice(0, LIMIT).map(({ entry }) => ({
      entry,
      title: split(entry.title, terms),
      snippet: split(snippet(entry.text, terms), terms)
    }));
  });

  $effect(() => {
    void query;
    active = 0;
  });

  function hrefOf(entry: Entry): string {
    return `${base}/${lang}${entry.href}`;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (query) query = '';
      else (event.currentTarget as HTMLInputElement).blur();
      open = false;
      return;
    }
    if (!results.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = (active + 1) % results.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active - 1 + results.length) % results.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(results[active].entry);
    }
  }

  function pick(entry: Entry) {
    open = false;
    query = '';
    goto(hrefOf(entry));
  }

  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !(event.currentTarget as HTMLElement).contains(next)) open = false;
  }
</script>

<div class="search" class:large role="search" {onfocusout}>
  <svg class="icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" />
    <path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
  <input
    type="search"
    data-docs-search
    bind:value={query}
    placeholder={t.docs.searchPlaceholder}
    aria-label={t.docs.searchLabel}
    role="combobox"
    aria-expanded={open && query.trim() !== ''}
    aria-controls={listId}
    aria-autocomplete="list"
    aria-activedescendant={open && results.length ? `${listId}-${active}` : undefined}
    autocomplete="off"
    spellcheck="false"
    onfocus={() => {
      load();
      open = true;
    }}
    oninput={() => {
      load();
      open = true;
    }}
    {onkeydown}
  />
  <kbd class="hint" aria-hidden="true">/</kbd>

  {#if open && query.trim()}
    <div class="panel">
      {#if loading && !index}
        <p class="note">{t.docs.searchLoading}</p>
      {:else if results.length === 0}
        <p class="note">{t.docs.searchEmpty.replace('{q}', query.trim())}</p>
      {:else}
        <ul id={listId} role="listbox" aria-label={t.docs.searchLabel}>
          {#each results as result, i (result.entry.href + i)}
            <li id="{listId}-{i}" role="option" aria-selected={i === active}>
              <a
                href={hrefOf(result.entry)}
                class:active={i === active}
                tabindex="-1"
                onmouseenter={() => (active = i)}
                onclick={(event) => {
                  event.preventDefault();
                  pick(result.entry);
                }}
              >
                <span class="where">{result.entry.page}</span>
                <span class="title">
                  {#each result.title as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
                </span>
                {#if result.entry.text}
                  <span class="snippet">
                    {#each result.snippet as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
                  </span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .search {
    position: relative;
  }

  .icon {
    position: absolute;
    left: 11px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--ink-3);
    pointer-events: none;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-size: 14px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 8px 34px 8px 32px;
    min-height: 38px;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }

  input::-webkit-search-cancel-button {
    display: none;
  }

  input::placeholder {
    color: var(--ink-3);
  }

  input:focus {
    border-color: var(--teal-line);
    box-shadow: 0 0 0 3px var(--teal-tint);
  }

  .hint {
    position: absolute;
    right: 9px;
    top: 50%;
    transform: translateY(-50%);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0 5px;
    line-height: 17px;
    pointer-events: none;
  }

  input:focus + .hint {
    display: none;
  }

  .large input {
    font-size: 16px;
    min-height: 46px;
    padding-left: 38px;
    border-radius: var(--radius-md);
  }

  .large .icon {
    left: 14px;
  }

  .panel {
    position: absolute;
    z-index: 30;
    top: calc(100% + 6px);
    left: 0;
    width: max(100%, min(26rem, calc(100vw - 32px)));
    max-height: min(70vh, 32rem);
    overflow-y: auto;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.14);
    padding: 6px;
  }

  .large .panel {
    width: 100%;
  }

  .note {
    margin: 0;
    padding: 12px;
    font-size: 14px;
    color: var(--ink-3);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  a {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    color: var(--ink);
    text-decoration: none;
  }

  a.active {
    background: var(--teal-tint);
  }

  .where {
    font-size: 12px;
    color: var(--ink-3);
  }

  .title {
    font-weight: 650;
    font-size: 14px;
    line-height: 1.4;
  }

  .snippet {
    font-size: 13px;
    color: var(--ink-2);
    line-height: 1.5;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  mark {
    background: var(--mustard-tint);
    color: inherit;
    border-radius: var(--radius-xs);
    padding: 0 1px;
  }
</style>
