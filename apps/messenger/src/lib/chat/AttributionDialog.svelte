<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { backdropClick } from '../click-outside.ts';
  import type { Copy } from '../copy.ts';
  import { pageSlide } from '../mobile-page-slide.ts';
  import { messageFilings, rankPlans, type AttributedMessage, type AttributionInput, type AttributionPlan } from './attribution.ts';

  /**
   * Changing what a message is filed under. The daemon offers every job in the workspace, so the
   * list is cut to where you are: what is chosen on top, then the jobs this conversation has used,
   * then the rest folded behind a count — or all of them the moment you search. Choosing is one
   * click on a row; a job with tickets then offers which one, and the part is only asked for once a
   * ticket is. Save and Cancel stay in view however long the list is.
   */
  let { message, t, plans = [], inConversation, disabled = false, loading = false, loadError = false, onLoad, onSave, onClose }: {
    message: AttributedMessage;
    t: Copy;
    plans?: readonly AttributionPlan[];
    /** The jobs this conversation's lines are already filed under. */
    inConversation: ReadonlySet<string>;
    disabled?: boolean;
    loading?: boolean;
    loadError?: boolean;
    onLoad?: () => Promise<unknown>;
    onSave: (filings: AttributionInput[]) => Promise<unknown>;
    onClose: () => void;
  } = $props();

  const backdrop = backdropClick();
  // The dialog opens on one message and is kept for it: the draft starts from what it is filed under now.
  const filings = untrack(() => messageFilings(message));
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
  let query = $state('');
  let showAll = $state(false);
  let pending = $state(false);
  let failed = $state(false);
  let searchEl = $state<HTMLInputElement | null>(null);

  const changed = $derived(JSON.stringify(draft) !== JSON.stringify(initial));
  const ranked = $derived(rankPlans({ plans: options, chosen: draft.map((row) => row.plan_id), inConversation, query }));
  const searching = $derived(query.trim().length > 0);
  const othersShown = $derived(searching || showAll);

  onMount(() => {
    void onLoad?.();
    // A thumb would meet the keyboard before the list; a pointer can type straight away.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return;
    searchEl?.focus();
  });

  function toggle(planId: string, checked: boolean): void {
    draft = checked ? [...draft, { plan_id: planId }] : draft.filter((row) => row.plan_id !== planId);
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
  }

  async function save(): Promise<void> {
    if (pending || disabled || !changed) return;
    pending = true;
    failed = false;
    try {
      failed = Boolean(await onSave(draft.map((row) => ({ ...row }))));
      if (!failed) onClose();
    } catch { failed = true; }
    finally { pending = false; }
  }

  function dismiss(): void {
    if (!pending) onClose();
  }
</script>

{#snippet row(plan: AttributionPlan, checked: boolean)}
  <label class="plan-row" class:is-chosen={checked}>
    <input type="checkbox" value={plan.id} {checked} onchange={(event) => toggle(plan.id, event.currentTarget.checked)} />
    <span class="plan-title" title={plan.title}>{plan.title}</span>
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
    <fieldset class="modal-body attribution-body" disabled={disabled || pending}>
      <input
        bind:this={searchEl}
        bind:value={query}
        type="search"
        class="attribution-search"
        placeholder={t.attribution.search}
        aria-label={t.attribution.search}
        autocomplete="off"
      />
      {#if loading}<p class="note" role="status">{t.attribution.loading}</p>{/if}
      {#if loadError}
        <p class="note error" role="status">{t.attribution.loadFailed} <button type="button" class="link" onclick={() => void onLoad?.()}>{t.attribution.retry}</button></p>
      {/if}

      {#if ranked.chosen.length > 0 || !searching}
        <h3>{t.attribution.chosen}</h3>
        {#if ranked.chosen.length === 0}
          <p class="note">{t.attribution.unfiled}</p>
        {/if}
        {#each ranked.chosen as plan (plan.id)}
          <div class="chosen-plan">
            {@render row(plan, true)}
            {#each draft as entry, index}
              {#if entry.plan_id === plan.id && (plan.tickets.length > 0 || entry.ticket_id)}
                <div class="filing-fields">
                  <label>{t.attribution.ticket}
                    <select aria-label={`${t.attribution.ticket} · ${plan.title}`} value={entry.ticket_id ?? ''} onchange={(event) => change(index, 'ticket_id', event.currentTarget.value)}>
                      <option value="">{t.attribution.wholePlan}</option>
                      {#if entry.ticket_id && !plan.tickets.some((ticket) => ticket.id === entry.ticket_id)}<option value={entry.ticket_id}>{t.attribution.unknownPlan}</option>{/if}
                      {#each plan.tickets as ticket (ticket.id)}<option value={ticket.id}>{ticket.title}</option>{/each}
                    </select>
                  </label>
                  {#if entry.ticket_id}
                    <label>{t.attribution.part}
                      <input aria-label={`${t.attribution.part} · ${plan.title}`} value={entry.part_key ?? ''} oninput={(event) => change(index, 'part_key', event.currentTarget.value)} placeholder={t.attribution.partPlaceholder} />
                    </label>
                  {/if}
                  {#if draft.filter((item) => item.plan_id === plan.id).length > 1}
                    <button type="button" class="link" onclick={() => { draft = draft.filter((_, i) => i !== index); }}>{t.attribution.removeFiling}</button>
                  {/if}
                </div>
              {/if}
            {/each}
            {#if plan.tickets.length > 0}
              <button type="button" class="link add" onclick={() => { draft = [...draft, { plan_id: plan.id }]; }}>{t.attribution.addFiling}</button>
            {/if}
          </div>
        {/each}
      {/if}

      {#if ranked.here.length > 0}
        <h3>{t.attribution.here}</h3>
        {#each ranked.here as plan (plan.id)}{@render row(plan, false)}{/each}
      {/if}

      {#if ranked.others.length > 0}
        {#if othersShown}
          <h3>{t.attribution.others(ranked.others.length)}</h3>
          {#each ranked.others as plan (plan.id)}{@render row(plan, false)}{/each}
        {:else}
          <button type="button" class="link show-others" onclick={() => { showAll = true; }}>{t.attribution.showOthers(ranked.others.length)}</button>
        {/if}
      {/if}

      {#if searching && ranked.here.length === 0 && ranked.others.length === 0}
        <p class="note">{t.attribution.noMatch}</p>
      {/if}
      {#if options.length === 0 && !loading && !loadError}<p class="note">{t.attribution.noPlans}</p>{/if}
    </fieldset>
    <div class="attribution-foot">
      {#if failed}<span class="error" role="status">{t.attribution.failed}</span>{/if}
      <button type="button" class="unfile" disabled={disabled || pending || draft.length === 0} onclick={() => { draft = []; }}>{t.attribution.unfile}</button>
      <button type="button" class="cancel" disabled={pending} onclick={dismiss}>{t.attribution.cancel}</button>
      <button type="submit" class="primary" aria-busy={pending} disabled={disabled || pending || !changed}>{pending ? t.attribution.saving : t.attribution.save}</button>
    </div>
  </form>
</div>

<style>
  .attribution-modal { width: 480px; max-width: 92vw; max-height: min(680px, 88dvh); min-height: 0; }
  .attribution-body { flex: 1 1 auto; min-height: 0; margin: 0; border: 0; overflow-y: auto; padding: 12px 20px 8px; display: flex; flex-direction: column; gap: 2px; }
  .attribution-search { position: sticky; top: -12px; z-index: 1; margin: 0 0 6px; width: 100%; min-height: 34px; padding: 4px 10px; box-sizing: border-box; background: var(--pane); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-md); font: inherit; }
  h3 { margin: 12px 0 4px; font-size: var(--text-caption); font-weight: 600; color: var(--muted); }
  .note { margin: 6px 0; color: var(--muted); font-size: var(--text-caption); }
  .plan-row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 8px; border-radius: var(--radius-md); cursor: pointer; color: var(--ink-secondary); font-size: var(--text-small); line-height: 1.4; }
  .plan-row:hover { background: var(--row-hover); }
  .plan-row input { flex: none; margin: 3px 0 0; accent-color: var(--accent); }
  .plan-row.is-chosen { color: var(--ink); font-weight: 600; }
  .plan-title { min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .chosen-plan { border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--sidebar-bg); padding: 2px 4px 6px; margin-bottom: 6px; }
  .filing-fields { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; padding: 2px 8px 4px 32px; }
  .filing-fields label { display: flex; flex-direction: column; gap: 3px; flex: 1 1 140px; min-width: 0; font-size: var(--text-caption); color: var(--muted); }
  .filing-fields input, .filing-fields select { min-width: 0; width: 100%; min-height: 32px; padding: 4px 6px; background: var(--pane); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); box-sizing: border-box; font: inherit; }
  .link { background: none; border: 0; padding: 4px 8px; color: var(--accent); font: inherit; font-size: var(--text-caption); cursor: pointer; text-align: left; }
  .link:hover:not(:disabled) { text-decoration: underline; }
  .add { margin-left: 24px; }
  .show-others { align-self: flex-start; margin-top: 8px; }
  /*
   * Its own footer rather than `.modal-foot`: on a phone that one keeps only its first button, and
   * this dialog needs two — Save, and the way to file under nothing. Cancel is the back arrow there.
   */
  .attribution-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--line); background: var(--sidebar-bg); }
  .attribution-foot button { border: 1px solid var(--line); background: var(--btn-secondary-bg); border-radius: var(--radius-md); padding: 8px 18px; font-size: 13px; font-weight: 600; color: var(--ink); box-shadow: var(--shadow-xs); cursor: pointer; }
  .attribution-foot .unfile { margin-right: auto; background: transparent; border-color: transparent; box-shadow: none; color: var(--ink-secondary); font-weight: 500; padding-left: 8px; }
  .attribution-foot .primary { color: var(--accent); border-color: var(--accent-border); background: var(--accent-tint); }
  .attribution-foot button:disabled { opacity: .5; cursor: default; }
  .attribution-foot .error { flex: 1 0 100%; }
  .error { color: var(--danger-text); font-size: var(--text-caption); }
  @media (max-width: 680px) {
    .attribution-foot { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); }
    .attribution-foot .cancel { display: none; }
    .attribution-foot button { min-height: 46px; font-size: 15px; }
    .attribution-foot .primary { flex: 1; }
  }
  @media (pointer: coarse) { .plan-row { padding: 10px 8px; } .filing-fields input, .filing-fields select, .attribution-search { min-height: 40px; } }
</style>
