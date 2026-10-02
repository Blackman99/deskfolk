<script lang="ts">
  import type { Copy } from '../copy.ts';
  import { filingLabel, filingParts, messageFilings, type AttributedMessage, type AttributionPlan } from './attribution.ts';

  /**
   * What a message is filed under, as one quiet tag: the first job in words (cut to the line if it is
   * long — a job is named after the request that opened it), the ticket after it, and how many more.
   * The whole tag is the way in to changing it; the choosing itself happens in the attribution dialog.
   */
  let { message, t, plans = [], disabled = false, onOpen }: {
    message: AttributedMessage;
    t: Copy;
    plans?: readonly AttributionPlan[];
    disabled?: boolean;
    onOpen: () => void;
  } = $props();

  const filings = $derived(messageFilings(message));
  const first = $derived(filings[0] ? filingParts(filings[0], plans) : null);
  const detail = $derived(first ? [first.ticket, first.part].filter(Boolean).join(' · ') : '');
  const full = $derived(
    filings.length
      ? t.attribution.filed(filings.map((row) => filingLabel(row, plans, t.attribution.unknownPlan)).join(' / '))
      : t.attribution.undetermined,
  );
</script>

<div class="message-attribution">
  <button
    type="button"
    class="attribution-chip"
    class:is-unfiled={filings.length === 0}
    {disabled}
    aria-haspopup="dialog"
    aria-label={`${full} — ${t.attribution.chipHint}`}
    title={`${full}\n${t.attribution.chipHint}`}
    onclick={onOpen}
  >
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><circle cx="7" cy="7" r="1.5"></circle></svg>
    {#if first}
      <span class="plan">{first.plan ?? t.attribution.unknownPlan}</span>
      {#if detail}<span class="detail">› {detail}</span>{/if}
      {#if filings.length > 1}<span class="more">{t.attribution.more(filings.length - 1)}</span>{/if}
    {:else}
      <span class="plan">{t.attribution.undetermined}</span>
      <span class="detail">· {t.attribution.choose}</span>
    {/if}
  </button>
</div>

<style>
  .message-attribution { display: flex; margin-top: 4px; max-width: 100%; font-size: var(--text-caption); }
  .attribution-chip { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: min(100%, 440px); min-height: 22px; padding: 0 8px; background: transparent; color: var(--muted); border: 1px solid var(--line-subtle); border-radius: var(--radius-full); font: inherit; cursor: pointer; transition: color .15s ease, border-color .15s ease, background-color .15s ease; }
  .attribution-chip svg { flex: none; }
  .attribution-chip:hover:not(:disabled), .attribution-chip:focus-visible { color: var(--accent); border-color: var(--accent-border); background: var(--accent-tint); }
  .attribution-chip:disabled { cursor: default; opacity: .6; }
  .plan, .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plan { flex: 0 1 auto; color: var(--ink-secondary); }
  .detail { flex: 0 2 auto; }
  .more { flex: none; }
  .is-unfiled { border-style: dashed; }
  .is-unfiled .plan { color: inherit; }
  .is-unfiled .detail { color: var(--accent); }
  @media (pointer: coarse) { .attribution-chip { min-height: 32px; } }
</style>
