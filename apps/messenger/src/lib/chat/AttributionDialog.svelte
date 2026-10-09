<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { backdropClick } from '../click-outside.ts';
  import type { Copy } from '../copy.ts';
  import { pageSlide } from '../mobile-page-slide.ts';
  import { formatListTime } from '../sidebar/list-time.ts';
  import { plainPreview } from '../sidebar/preview-text.ts';
  import { messageFilings, rankPlans, type AttributedMessage, type AttributionInput, type AttributionPlan } from './attribution.ts';

  /**
   * Changing what a message is filed under. It opens on the line itself, so a dialog reached from a
   * menu still says which line. The daemon offers every job in the workspace, so the list is cut to
   * where you are: what is chosen on top, then the jobs this conversation has used (the latest first,
   * with when), then the rest folded behind a count — or all of them the moment you search. Choosing
   * is one click on a row, or Enter on the first match; the ticket is asked for only under a chosen
   * job that has tickets, and a part only once a ticket is chosen and you ask to set one. Save and
   * Cancel stay in view however long the list is. A line of yours that is about none of them can be
   * made a new job instead: 「新开一件事」 is a choice of its own, and choosing it lets go of the rest.
   */
  let { message, t, locale = 'zh', plans = [], lastUsed, disabled = false, loading = false, loadError = false, onLoad, onSave, onNewJob, onClose }: {
    message: AttributedMessage;
    t: Copy;
    locale?: 'zh' | 'en';
    plans?: readonly AttributionPlan[];
    /** When each job last had a line of this conversation filed under it. */
    lastUsed: ReadonlyMap<string, string>;
    disabled?: boolean;
    loading?: boolean;
    loadError?: boolean;
    onLoad?: () => Promise<unknown>;
    onSave: (filings: AttributionInput[]) => Promise<unknown>;
    /** Opens a job from this line and files it there; only offered for a line of yours. */
    onNewJob?: () => Promise<unknown>;
    onClose: () => void;
  } = $props();

  const backdrop = backdropClick();
  // The dialog opens on one message and is kept for it: the draft starts from what it is filed under now.
  const filings = untrack(() => messageFilings(message));
  // The line as read, not as written: no `**` or `#` showing, as in the chat list.
  const preview = untrack(() => {
    const text = plainPreview(message.body ?? '', 151);
    return text.length > 150 ? `${text.slice(0, 150)}…` : text;
  });
  // Keep current references even when a plan/ticket no longer appears in the loaded choices.
  const options = $derived<AttributionPlan[]>([
    ...plans,
    ...[...new Set(filings.map((row) => row.task_id))]
      .filter((id) => !plans.some((plan) => plan.id === id))
      .map((id) => ({ id, title: t.attribution.unknownPlan, tickets: [] })),
  ]);
  const initial: AttributionInput[] = filings.map((row) => ({
    plan_id: row.task_id,
    ...(row.ticket_id ? { ticket_id: row.ticket_id } : {}),
    ...(row.part_key ? { part_key: row.part_key } : {}),
  }));
  let draft = $state<AttributionInput[]>(initial.map((row) => ({ ...row })));
  /** 「新开一件事」 chosen: the line goes to a job of its own, and nothing else is chosen. */
  let newJob = $state(false);
  const canOpenJob = untrack(() => Boolean(onNewJob) && message.kind === 'user');
  let query = $state('');
  let showAll = $state(false);
  let pending = $state(false);
  let failed = $state(false);
  /** Entries whose part field was asked for; one that already has a part always shows it. */
  let askedPart = $state<number[]>([]);
  let searchEl = $state<HTMLInputElement | null>(null);
  let bodyEl = $state<HTMLElement | null>(null);
  const now = Date.now();

  const changed = $derived(newJob || JSON.stringify(draft) !== JSON.stringify(initial));
  const ranked = $derived(rankPlans({ plans: options, chosen: draft.map((row) => row.plan_id), lastUsed, query }));
  const searching = $derived(query.trim().length > 0);
  const othersShown = $derived(searching || showAll);

  onMount(() => {
    void onLoad?.();
    // A thumb would meet the keyboard before the list; a pointer can type straight away.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return;
    searchEl?.focus();
  });

  function meta(plan: AttributionPlan): string {
    const used = lastUsed.get(plan.id);
    return [
      used ? t.attribution.usedAt(formatListTime(used, now, locale)) : '',
      plan.tickets.length > 0 ? t.attribution.ticketCount(plan.tickets.length) : '',
    ].filter(Boolean).join(' · ');
  }

  function toggle(planId: string, checked: boolean): void {
    askedPart = [];
    if (checked) newJob = false;
    draft = checked ? [...draft, { plan_id: planId }] : draft.filter((row) => row.plan_id !== planId);
  }

  function chooseNewJob(checked: boolean): void {
    newJob = checked;
    if (checked) { askedPart = []; draft = []; }
    else draft = initial.map((row) => ({ ...row }));
  }

  function change(index: number, field: 'ticket_id' | 'part_key', value: string): void {
    draft = draft.map((row, i) => {
      if (i !== index) return row;
      const next = { ...row };
      if (field === 'ticket_id' && value !== (row.ticket_id ?? '')) delete next.part_key;
      if (field === 'part_key' && !row.ticket_id) return row;
      if (value) next[field] = value;
      else delete next[field];
      return next;
    });
    if (field === 'ticket_id') askedPart = askedPart.filter((i) => i !== index);
  }

  /** Enter on a search takes the first match, so finding a job is typing and Enter. */
  function onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      bodyEl?.querySelector<HTMLInputElement>('.plan-row input')?.focus();
    } else if (event.key === 'Enter' && searching) {
      event.preventDefault();
      const first = [...ranked.here, ...ranked.others][0];
      if (first) {
        toggle(first.id, true);
        query = '';
      }
    }
  }

  async function save(): Promise<void> {
    if (pending || disabled || !changed) return;
    pending = true;
    failed = false;
    try {
      failed = Boolean(newJob && onNewJob ? await onNewJob() : await onSave(draft.map((row) => ({ ...row }))));
      if (!failed) onClose();
    } catch { failed = true; }
    finally { pending = false; }
  }

  function dismiss(): void {
    if (!pending) onClose();
  }
</script>

{#snippet newJobRow()}
  <label class="plan-row new-job" class:is-chosen={newJob}>
    <input type="checkbox" checked={newJob} onchange={(event) => chooseNewJob(event.currentTarget.checked)} />
    <span class="plan-text">
      <span class="plan-title">{t.attribution.newJob}</span>
      <span class="plan-meta">{t.attribution.newJobHint}</span>
    </span>
  </label>
{/snippet}

{#snippet row(plan: AttributionPlan, checked: boolean)}
  <label class="plan-row" class:is-chosen={checked}>
    <input type="checkbox" value={plan.id} {checked} onchange={(event) => toggle(plan.id, event.currentTarget.checked)} />
    <span class="plan-text">
      <span class="plan-title" title={plan.title}>{plan.title}</span>
      {#if meta(plan)}<span class="plan-meta">{meta(plan)}</span>{/if}
    </span>
  </label>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="modal-backdrop page-on-phone"
  transition:pageSlide
  role="dialog"
  aria-modal="true"
  aria-labelledby="attribution-title"
  tabindex="-1"
  onmousedowncapture={backdrop.press}
  onclick={(event) => { if (backdrop.isOutside(event)) dismiss(); }}
  onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } }}
>
  <form class="modal-dialog attribution-modal" onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <div class="modal-head">
      <button type="button" class="modal-back" aria-label={t.common.back} onclick={dismiss}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <h2 id="attribution-title">{t.attribution.title}</h2>
      <button type="button" class="modal-close" title={t.common.close} onclick={dismiss}>✕</button>
    </div>
    <div class="attribution-context-wrapper">
      <p class="attribution-context" role="note" aria-label={t.attribution.message}>
        <span class="quote">{preview || t.attribution.noText}</span>
      </p>
    </div>
    <fieldset bind:this={bodyEl} class="modal-body attribution-body" disabled={disabled || pending}>
      <div class="search-wrap">
        <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          bind:this={searchEl}
          bind:value={query}
          type="search"
          class="attribution-search"
          placeholder={t.attribution.search}
          aria-label={t.attribution.search}
          autocomplete="off"
          onkeydown={onSearchKey}
        />
        {#if query}
          <button type="button" class="search-clear" aria-label={t.common.close} onclick={() => { query = ''; searchEl?.focus(); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        {/if}
      </div>

      {#if loading}<p class="note" role="status">{t.attribution.loading}</p>{/if}
      {#if loadError}
        <p class="note error" role="status">{t.attribution.loadFailed} <button type="button" class="link inline-retry" onclick={() => void onLoad?.()}>{t.attribution.retry}</button></p>
      {/if}

      {#if ranked.chosen.length > 0 || !searching}
        <div class="section-head">
          <h3>{t.attribution.chosen}</h3>
          {#if ranked.chosen.length > 0}
            <span class="count-pill">{ranked.chosen.length}</span>
          {/if}
        </div>
        {#if newJob}
          {@render newJobRow()}
        {:else if ranked.chosen.length === 0}
          <div class="empty-unfiled">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
            </svg>
            <p class="note">{t.attribution.unfiled}</p>
          </div>
        {/if}
        {#each ranked.chosen as plan (plan.id)}
          <div class="chosen-plan">
            {@render row(plan, true)}
            {#each draft as entry, index}
              {#if entry.plan_id === plan.id && (plan.tickets.length > 0 || entry.ticket_id)}
                <div class="filing-fields">
                  <div class="filing-card">
                    <div class="filing-card-top">
                      <label class="filing-control">
                        <span class="field-label">{t.attribution.ticket}</span>
                        <div class="filing-select">
                          <select aria-label={`${t.attribution.ticket} · ${plan.title}`} value={entry.ticket_id ?? ''} onchange={(event) => change(index, 'ticket_id', event.currentTarget.value)}>
                            <option value="">{t.attribution.wholePlan}</option>
                            {#if entry.ticket_id && !plan.tickets.some((ticket) => ticket.id === entry.ticket_id)}<option value={entry.ticket_id}>{t.attribution.unknownPlan}</option>{/if}
                            {#each plan.tickets as ticket (ticket.id)}<option value={ticket.id}>{ticket.title}</option>{/each}
                          </select>
                          <svg class="select-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9"></polyline>
                          </svg>
                        </div>
                      </label>
                      {#if draft.filter((item) => item.plan_id === plan.id).length > 1}
                        <button type="button" class="link remove" onclick={() => { askedPart = []; draft = draft.filter((_, i) => i !== index); }}>{t.attribution.removeFiling}</button>
                      {/if}
                    </div>
                    {#if entry.ticket_id && (entry.part_key || askedPart.includes(index))}
                      <label class="filing-control part-control">
                        <span class="field-label">{t.attribution.part}</span>
                        <input aria-label={`${t.attribution.part} · ${plan.title}`} value={entry.part_key ?? ''} oninput={(event) => change(index, 'part_key', event.currentTarget.value)} placeholder={t.attribution.partPlaceholder} />
                      </label>
                    {:else if entry.ticket_id}
                      <div class="part-action-row">
                        <button type="button" class="link add-part" onclick={() => { askedPart = [...askedPart, index]; }}>{t.attribution.addPart}</button>
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}
            {/each}
            {#if plan.tickets.length > 0 && draft.filter((item) => item.plan_id === plan.id).every((item) => item.ticket_id)}
              <button type="button" class="link add" onclick={() => { draft = [...draft, { plan_id: plan.id }]; }}>{t.attribution.addFiling}</button>
            {/if}
          </div>
        {/each}
      {/if}

      {#if canOpenJob && !newJob}{@render newJobRow()}{/if}

      {#if ranked.here.length > 0}
        <div class="section-head">
          <h3>{t.attribution.here}</h3>
          <span class="count-pill">{ranked.here.length}</span>
        </div>
        <div class="plan-list">
          {#each ranked.here as plan (plan.id)}{@render row(plan, false)}{/each}
        </div>
      {/if}

      {#if ranked.others.length > 0}
        {#if othersShown}
          <div class="section-head">
            <h3>{t.attribution.others(ranked.others.length)}</h3>
            <span class="count-pill">{ranked.others.length}</span>
          </div>
          <div class="plan-list">
            {#each ranked.others as plan (plan.id)}{@render row(plan, false)}{/each}
          </div>
        {:else}
          <button type="button" class="link show-others" onclick={() => { showAll = true; }}>{t.attribution.showOthers(ranked.others.length)}</button>
        {/if}
      {/if}

      {#if searching && ranked.here.length === 0 && ranked.others.length === 0}
        <div class="empty-unfiled">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <p class="note">{t.attribution.noMatch}</p>
        </div>
      {/if}
      {#if options.length === 0 && !loading && !loadError}<p class="note">{t.attribution.noPlans}</p>{/if}
    </fieldset>
    <div class="attribution-foot">
      {#if failed}<span class="error" role="status">{t.attribution.failed}</span>{/if}
      <button type="button" class="unfile" disabled={disabled || pending || draft.length === 0} onclick={() => { askedPart = []; draft = []; newJob = false; }}>{t.attribution.unfile}</button>
      <button type="button" class="cancel" disabled={pending} onclick={dismiss}>{t.attribution.cancel}</button>
      <button type="submit" class="primary" aria-busy={pending} disabled={disabled || pending || !changed}>{pending ? t.attribution.saving : t.attribution.save}</button>
    </div>
  </form>
</div>

<style>
  .attribution-modal {
    width: 530px;
    max-width: 92vw;
    max-height: min(720px, 88dvh);
    min-height: 0;
  }

  /* The line being filed: one quiet quote, a bar and the words — no card, no icon. */
  .attribution-context-wrapper {
    flex: none;
    padding: 12px 18px 0;
  }
  .attribution-context {
    margin: 0;
    padding: 2px 0 2px 10px;
    border-left: 2px solid var(--accent-border, var(--line));
    font-size: var(--text-caption);
    line-height: 1.5;
    color: var(--ink-secondary);
  }
  .quote {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  /* Main Body */
  .attribution-body {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    border: 0;
    overflow-y: auto;
    padding: 12px 18px 10px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  /* Sticky search bar */
  .search-wrap {
    position: sticky;
    top: -12px;
    z-index: 2;
    margin: 0 0 8px;
    padding: 2px 0 4px;
    background: var(--pane);
    display: flex;
    align-items: center;
  }
  .search-icon {
    position: absolute;
    left: 11px;
    pointer-events: none;
    color: var(--muted);
  }
  /* `.search-wrap` outranks modals.css `.modal-body input[type="search"]`, whose padding ran the text under the icon. */
  .search-wrap .attribution-search {
    width: 100%;
    min-height: 38px;
    padding: 6px 32px 6px 34px;
    box-sizing: border-box;
    background: var(--sidebar-bg);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    font: inherit;
    font-size: var(--text-small);
    box-shadow: none;
    transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
  }
  .attribution-search::-webkit-search-cancel-button {
    -webkit-appearance: none;
    appearance: none;
  }
  .search-wrap .attribution-search:focus {
    background: var(--pane);
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
    outline: none;
  }
  .search-clear {
    position: absolute;
    right: 8px;
    background: transparent;
    border: 0;
    color: var(--muted);
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: all 0.15s ease;
  }
  .search-clear:hover {
    color: var(--ink);
    background: var(--line-subtle);
  }

  /* Section heads */
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 14px 2px 5px;
  }
  h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .count-pill {
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--line-subtle);
    color: var(--muted);
    border: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
  }

  .note {
    margin: 4px 0;
    color: var(--muted);
    font-size: var(--text-caption);
  }
  .empty-unfiled {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--sidebar-bg);
    border: 1px dashed var(--line);
    color: var(--muted);
    margin: 4px 0 8px;
  }
  .empty-unfiled .note {
    margin: 0;
  }

  /* Plan list & rows */
  .plan-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .plan-row {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    cursor: pointer;
    color: var(--ink-secondary);
    font-size: var(--text-small);
    line-height: 1.45;
    border: 1px solid transparent;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  /* Not one of the jobs: a way to make one, so it reads as an action rather than another row. */
  .plan-row.new-job:not(.is-chosen) { border-style: dashed; border-color: var(--line); margin: 4px 0 2px; }
  .plan-row:hover {
    background: var(--row-hover);
    border-color: var(--line-subtle);
  }
  .plan-row input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    flex: none;
    width: 18px;
    height: 18px;
    margin: 2px 0 0;
    border: 1.5px solid var(--line-hover, var(--line));
    border-radius: 50%;
    background: var(--pane);
    cursor: pointer;
    display: inline-grid;
    place-content: center;
    transition: all 0.15s ease;
    box-sizing: border-box;
  }
  .plan-row input[type="checkbox"]:hover {
    border-color: var(--accent);
  }
  .plan-row input[type="checkbox"]:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  .plan-row input[type="checkbox"]:checked::after {
    content: "";
    width: 8px;
    height: 4.5px;
    border-left: 2px solid var(--on-accent, #ffffff);
    border-bottom: 2px solid var(--on-accent, #ffffff);
    transform: rotate(-45deg) translate(0.5px, -0.5px);
  }
  .plan-row input[type="checkbox"]:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-glow);
  }
  .plan-row.is-chosen {
    color: var(--ink);
    padding: 4px 4px 6px;
  }
  .plan-row.is-chosen:hover {
    background: transparent;
    border-color: transparent;
  }
  .plan-text {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .plan-title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    font-size: 13.5px;
    color: var(--ink);
  }
  .is-chosen .plan-title {
    font-weight: 600;
  }
  .plan-meta {
    font-size: var(--text-caption);
    color: var(--muted);
  }

  /* Chosen plan container */
  .chosen-plan {
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-lg);
    background: var(--accent-tint);
    padding: 8px 10px 10px;
    margin-bottom: 8px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
    transition: all 0.2s ease;
  }

  /* Filing sub-cards */
  .filing-fields {
    padding: 4px 0 2px 29px;
  }
  .filing-card {
    background: var(--pane);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  }
  .filing-card-top {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .filing-control {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .field-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
  }
  .filing-select {
    position: relative;
    width: 100%;
  }
  .filing-select select {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    min-height: 33px;
    padding: 5px 28px 5px 9px;
    background: var(--pane);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: var(--text-small);
    box-sizing: border-box;
    cursor: pointer;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .filing-select select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-glow);
    outline: none;
  }
  .select-arrow {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--muted);
  }

  .part-control input {
    width: 100%;
    min-height: 33px;
    padding: 5px 9px;
    background: var(--pane);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: var(--text-small);
    box-sizing: border-box;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .part-control input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-glow);
    outline: none;
  }
  .part-action-row {
    display: flex;
    align-items: center;
  }

  /* Links & action buttons */
  .link {
    background: none;
    border: 0;
    padding: 3px 6px;
    color: var(--accent);
    font: inherit;
    font-size: var(--text-caption);
    cursor: pointer;
    text-align: left;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: var(--radius-xs);
    transition: all 0.15s ease;
  }
  .link:hover:not(:disabled) {
    background: var(--line-subtle);
  }
  .inline-retry {
    padding: 0 2px;
    text-decoration: underline;
  }
  .add-part {
    padding: 2px 6px;
    color: var(--accent);
    font-weight: 500;
  }
  .add-part::before {
    content: "+";
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
  }
  .add {
    margin-left: 29px;
    margin-top: 6px;
    padding: 5px 10px;
    border: 1px dashed var(--accent-border);
    border-radius: var(--radius-sm);
    background: rgba(var(--pane), 0.5);
    color: var(--accent);
    font-weight: 500;
    font-size: 12px;
  }
  .add::before {
    content: "+";
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
  }
  .add:hover:not(:disabled) {
    background: var(--pane);
    border-color: var(--accent);
  }
  .remove {
    flex: none;
    color: var(--muted);
    font-size: 11.5px;
    padding: 3px 6px;
  }
  .remove:hover:not(:disabled) {
    color: var(--danger-text, #ef4444);
    background: var(--danger-bg, rgba(239, 68, 68, 0.1));
  }

  .show-others {
    margin-top: 8px;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    border: 1px dashed var(--line);
    background: var(--line-subtle);
    color: var(--ink-secondary);
    font-size: var(--text-caption);
    font-weight: 500;
    cursor: pointer;
    box-sizing: border-box;
    transition: all 0.15s ease;
  }
  .show-others::after {
    content: "";
    display: inline-block;
    width: 5px;
    height: 5px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg);
    margin-top: -2px;
  }
  .show-others:hover {
    background: var(--row-hover);
    border-color: var(--accent-border);
    color: var(--accent);
  }

  /* Modal Footer */
  .attribution-foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 13px 18px;
    border-top: 1px solid var(--line);
    background: var(--sidebar-bg);
  }
  .attribution-foot button {
    border: 1px solid var(--line);
    background: var(--btn-secondary-bg);
    border-radius: var(--radius-md);
    padding: 7px 16px;
    font-size: 13px;
    font-weight: 500;
    color: var(--ink);
    box-shadow: var(--shadow-xs);
    cursor: pointer;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .attribution-foot button:hover:not(:disabled) {
    background: var(--line-subtle);
    border-color: var(--line-hover);
  }
  .attribution-foot .unfile {
    margin-right: auto;
    background: transparent;
    border: 1px solid transparent;
    box-shadow: none;
    color: var(--muted);
    font-weight: 500;
    padding: 7px 10px;
  }
  .attribution-foot .unfile:hover:not(:disabled) {
    color: var(--danger-text, #ef4444);
    background: var(--danger-bg, rgba(239, 68, 68, 0.1));
    border-color: var(--danger-line, rgba(239, 68, 68, 0.25));
  }
  .attribution-foot .cancel {
    background: var(--btn-secondary-bg);
    color: var(--ink-secondary);
  }
  .attribution-foot .primary {
    color: var(--on-accent);
    border: 1px solid transparent;
    background: var(--accent);
    font-weight: 600;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .attribution-foot .primary:hover:not(:disabled) {
    background: var(--accent-hover);
    color: var(--on-accent);
  }
  .attribution-foot .primary:active:not(:disabled) {
    background: var(--accent-active);
  }
  .attribution-foot button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    box-shadow: none;
  }
  .attribution-foot .primary:disabled {
    background: var(--line);
    color: var(--muted-light);
    border-color: transparent;
  }
  .attribution-foot .error {
    flex: 1 0 100%;
    margin-bottom: 2px;
    padding: 6px 10px;
    background: var(--danger-bg, rgba(239, 68, 68, 0.1));
    border: 1px solid var(--danger-line, rgba(239, 68, 68, 0.25));
    border-radius: var(--radius-sm);
    color: var(--danger-text);
    font-size: var(--text-caption);
  }

  @media (max-width: 680px) {
    .attribution-context-wrapper { padding: 10px 14px 4px; }
    .attribution-body { padding: 12px 14px 8px; }
    .attribution-foot { padding: 12px 14px calc(12px + env(safe-area-inset-bottom)); }
    .attribution-foot .cancel { display: none; }
    .attribution-foot button { min-height: 44px; font-size: 14px; }
    .attribution-foot .primary { flex: 1; }
  }
  @media (pointer: coarse) {
    .plan-row { padding: 10px 8px; }
    .filing-control input, .filing-select select, .attribution-search { min-height: 40px; }
  }
</style>
