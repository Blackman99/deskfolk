<script lang="ts">
  import type { Bot, GroupLeadState } from '@real-bot/protocol';
  import type { Copy } from '../copy.ts';

  let { leadState, bots, t, disabled = false, loading = false, loadError = false, onReload, onConfirm }: {
    leadState: GroupLeadState | null;
    bots: readonly Bot[];
    t: Copy;
    disabled?: boolean;
    loading?: boolean;
    loadError?: boolean;
    onReload: () => Promise<unknown>;
    onConfirm: (botId: string | null) => Promise<unknown>;
  } = $props();

  let dismissed = $state(false);
  let chosen = $state('');
  let pending = $state(false);
  let failed = $state(false);
  const suggested = $derived(leadState?.suggestion ? bots.find((bot) => bot.id === leadState.suggestion?.bot_id) ?? null : null);
  const confirmed = $derived(leadState?.confirmed_bot_id ? bots.find((bot) => bot.id === leadState.confirmed_bot_id)?.name ?? t.top.deleted : null);

  async function confirm(botId: string | null): Promise<void> {
    if (pending || disabled) return;
    pending = true;
    failed = false;
    try { failed = Boolean(await onConfirm(botId)); }
    catch { failed = true; }
    finally { pending = false; }
  }
</script>

<section class="group-lead-card" aria-label={t.groupLead.title}>
  <strong>{t.groupLead.title}</strong>
  <p>{confirmed ? t.groupLead.confirmed(confirmed) : t.groupLead.unconfirmed}</p>
  {#if loading}<p role="status">{t.groupLead.loading}</p>{/if}
  {#if loadError}
    <p class="error" role="status">{t.groupLead.loadFailed}</p>
    <button type="button" disabled={disabled || pending} onclick={() => void onReload()}>{t.groupLead.retry}</button>
  {/if}
  {#if suggested && leadState?.suggestion && !dismissed && leadState.confirmed_bot_id !== suggested.id}
    <div class="suggestion">
      <p>{t.groupLead.suggested(suggested.name, leadState.suggestion.handoffs)}</p>
      <p class="hint">{t.groupLead.suggestionHint}</p>
      <div class="actions">
        <button type="button" disabled={disabled || pending} onclick={() => { dismissed = true; }}>{t.groupLead.decline}</button>
        <button type="button" class="primary" disabled={disabled || pending} onclick={() => void confirm(suggested.id)}>{t.groupLead.confirmSuggestion(suggested.name)}</button>
      </div>
    </div>
  {/if}
  <div class="actions">
    <label>{t.groupLead.choose}
      <select aria-label={t.groupLead.title} value={chosen} onchange={(event) => { chosen = event.currentTarget.value; }} disabled={disabled || pending || !leadState}>
        <option value="">{t.groupLead.choose}</option>
        {#each bots as bot (bot.id)}<option value={bot.id}>{bot.name}</option>{/each}
      </select>
    </label>
    <button type="button" class="primary" disabled={disabled || pending || !leadState || !chosen} aria-busy={pending} onclick={() => void confirm(chosen)}>{t.groupLead.confirm}</button>
    {#if leadState?.confirmed_bot_id}<button type="button" disabled={disabled || pending} onclick={() => void confirm(null)}>{t.groupLead.clear}</button>{/if}
  </div>
  {#if failed}<p class="error" role="status">{t.groupLead.failed}</p>{/if}
</section>

<style>
  .group-lead-card { padding: 12px; margin-bottom: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--pane); color: var(--ink-secondary); font-size: var(--text-caption); }
  p { margin: 6px 0; }
  .hint { color: var(--muted); }
  .suggestion { border-top: 1px solid var(--line); padding: 6px 0; margin-top: 8px; }
  .actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px; }
  label { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  button, select { min-height: 28px; padding: 0 8px; background: var(--pane); color: var(--ink-secondary); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  button { cursor: pointer; }
  button:hover:not(:disabled) { color: var(--accent); border-color: var(--accent-border); }
  button:disabled, select:disabled { opacity: .5; cursor: default; }
  .primary { color: var(--accent); border-color: var(--accent-border); background: var(--accent-tint); }
  .error { color: var(--danger-text); }
  @media (pointer: coarse) { button, select { min-height: 36px; } }
</style>
