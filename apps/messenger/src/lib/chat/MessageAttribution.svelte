<script lang="ts">
  import type { Copy } from '../copy.ts';
  import { filingLabel, messageFilings, type AttributedMessage, type AttributionInput, type AttributionPlan } from './attribution.ts';

  let { message, t, plans = [], disabled = false, loading = false, loadError = false, onLoad, onSave }: {
    message: AttributedMessage;
    t: Copy;
    plans?: readonly AttributionPlan[];
    disabled?: boolean;
    loading?: boolean;
    loadError?: boolean;
    onLoad?: () => Promise<unknown>;
    onSave?: (filings: AttributionInput[]) => Promise<unknown>;
  } = $props();
  const filings = $derived(messageFilings(message));
  // Keep current references even when a plan/ticket no longer appears in the loaded choices.
  const options = $derived([
    ...plans,
    ...[...new Set(filings.map((row) => row.task_id))].filter((id) => !plans.some((plan) => plan.id === id))
      .map((id) => ({ id, title: id, tickets: [] })),
  ]);
  let editing = $state(false);
  let draft = $state<AttributionInput[]>([]);
  let pending = $state(false);
  let failed = $state(false);

  function open(): void {
    if (disabled) return;
    draft = filings.map((row) => ({ plan_id: row.task_id, ...(row.ticket_id ? { ticket_id: row.ticket_id } : {}), ...(row.part_key ? { part_key: row.part_key } : {}) }));
    failed = false;
    editing = true;
    void onLoad?.();
  }

  function select(planId: string, checked: boolean): void {
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
    if (pending || disabled || !onSave) return;
    pending = true;
    failed = false;
    try {
      failed = Boolean(await onSave(draft.map((row) => ({ ...row }))));
      if (!failed) editing = false;
    } catch { failed = true; }
    finally { pending = false; }
  }
</script>

<div class="message-attribution">
  <span>{filings.length ? t.attribution.filed(filings.map((row) => filingLabel(row, plans)).join(t.attribution.separator)) : t.attribution.undetermined}</span>
  <button type="button" disabled={disabled} aria-expanded={editing} onclick={open}>{filings.length ? t.attribution.change : t.attribution.choose}</button>
  {#if editing}
    <form class="attribution-editor" aria-label={t.attribution.editor} onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={disabled || pending}>
        <legend>{t.attribution.editor}</legend>
        <p>{t.attribution.hint}</p>
        {#if loading}<span role="status">{t.attribution.loading}</span>{/if}
        {#if loadError}
          <span role="status" class="error">{t.attribution.loadFailed}</span>
          <button type="button" onclick={() => void onLoad?.()}>{t.attribution.retry}</button>
        {/if}
        {#each options as plan (plan.id)}
          {@const row = draft.find((item) => item.plan_id === plan.id)}
          <label class="plan-option"><input type="checkbox" value={plan.id} checked={Boolean(row)} onchange={(event) => select(plan.id, event.currentTarget.checked)} />{plan.title}</label>
          {#each draft as entry, index}
          {#if entry.plan_id === plan.id}
            <div class="filing-fields">
              <label>{t.attribution.ticket}
                <select aria-label={`${t.attribution.ticket} · ${plan.title}`} value={entry.ticket_id ?? ''} onchange={(event) => change(index, 'ticket_id', event.currentTarget.value)}>
                  <option value="">{t.attribution.wholePlan}</option>
                  {#if entry.ticket_id && !plan.tickets.some((ticket) => ticket.id === entry.ticket_id)}<option value={entry.ticket_id}>{entry.ticket_id}</option>{/if}
                  {#each plan.tickets as ticket (ticket.id)}<option value={ticket.id}>{ticket.title}</option>{/each}
                </select>
              </label>
              <label>{t.attribution.part}<input aria-label={`${t.attribution.part} · ${plan.title}`} disabled={!entry.ticket_id} value={entry.part_key ?? ''} oninput={(event) => change(index, 'part_key', event.currentTarget.value)} placeholder={t.attribution.optional} /></label>
              <button type="button" aria-label={t.attribution.removeFiling} onclick={() => { draft = draft.filter((_, i) => i !== index); }}>{t.attribution.removeFiling}</button>
            </div>
          {/if}
          {/each}
          {#if row}<button type="button" onclick={() => { draft = [...draft, { plan_id: plan.id }]; }}>{t.attribution.addFiling}</button>{/if}
        {/each}
        {#if options.length === 0 && !loading}<p>{t.attribution.noPlans}</p>{/if}
        <div class="actions">
          <button type="button" onclick={() => { draft = []; }}>{t.attribution.unfile}</button>
          <button type="button" onclick={() => { editing = false; }}>{t.attribution.cancel}</button>
          <button type="submit" class="primary" aria-busy={pending} disabled={!onSave}>{pending ? t.attribution.saving : t.attribution.save}</button>
        </div>
      </fieldset>
      {#if failed}<span class="error" role="status">{t.attribution.failed}</span>{/if}
    </form>
  {/if}
</div>

<style>
  .message-attribution { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; color: var(--muted); font-size: var(--text-caption); max-width: 100%; }
  button { min-height: 28px; padding: 0 8px; background: var(--pane); color: var(--ink-secondary); border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer; }
  button:hover:not(:disabled) { color: var(--accent); border-color: var(--accent-border); }
  button:disabled { opacity: .5; cursor: default; }
  .attribution-editor { flex-basis: 100%; width: min(420px, 100%); padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--pane); color: var(--ink-secondary); }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { font-weight: 600; }
  p { margin: 6px 0; color: var(--muted); }
  .plan-option { display: flex; align-items: center; gap: 8px; min-height: 32px; }
  .filing-fields { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0 8px 24px; }
  .filing-fields label { display: flex; flex-direction: column; gap: 4px; flex: 1 1 140px; min-width: 0; }
  input:not([type=checkbox]), select { min-width: 0; width: 100%; min-height: 32px; padding: 4px 6px; background: var(--pane); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); box-sizing: border-box; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-top: 8px; }
  .primary { color: var(--accent); border-color: var(--accent-border); background: var(--accent-tint); }
  .error { color: var(--danger-text); display: block; margin-top: 6px; }
  @media (pointer: coarse) { button, .plan-option, input:not([type=checkbox]), select { min-height: 36px; } }
</style>
