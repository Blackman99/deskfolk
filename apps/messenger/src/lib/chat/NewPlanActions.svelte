<script lang="ts">
	import type { ControlOffer, MessageControl } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	type Props = {
		control: Extract<MessageControl, { kind: 'plan_opened' }>;
		t: Copy;
		disabled?: boolean;
		onAct: (action: ControlOffer, taskId?: string) => Promise<unknown>;
	};
	let { control, t, disabled = false, onAct }: Props = $props();
	let choosing = $state<'undo_plan' | 'merge_plan' | null>(null);
	let target = $state('');
	let pending = $state(false);
	let failed = $state(false);

	async function confirm(): Promise<void> {
		if (!choosing || pending || disabled || (choosing === 'merge_plan' && !target)) return;
		pending = true;
		failed = false;
		try { failed = Boolean(await onAct(choosing, choosing === 'merge_plan' ? target : undefined)); }
		catch { failed = true; }
		finally { pending = false; }
	}
</script>

<div class="new-plan-actions" role="group" aria-label={t.control.planMergeTarget}>
	{#if control.acted?.length}
		<span role="status">{t.control.acted[control.acted.at(-1)!]}</span>
		{#if control.retained_effects?.length}<span>{t.control.planRetained}</span>{/if}
	{:else if choosing}
		<p>{choosing === 'undo_plan' ? t.control.planUndoWarning : t.control.planMergeWarning}</p>
		{#if choosing === 'merge_plan'}
			<label>{t.control.planMergeTarget}
				<select value={target} onchange={(event) => { target = event.currentTarget.value; }} disabled={disabled || pending}>
					<option value="">—</option>
					{#each control.merge_targets as job (job.task_id)}<option value={job.task_id}>{job.title}</option>{/each}
				</select>
			</label>
		{/if}
		<button type="button" disabled={disabled || pending || (choosing === 'merge_plan' && !target)} onclick={() => void confirm()}>
			{choosing === 'undo_plan' ? t.control.confirmUndoPlan : t.control.confirmMergePlan}
		</button>
		<button type="button" disabled={pending} onclick={() => { choosing = null; failed = false; }}>{t.control.cancelPlanAction}</button>
	{:else}
		{#if control.offer.includes('undo_plan')}<button type="button" disabled={disabled} onclick={() => choosing = 'undo_plan'}>{t.control.undoPlan}</button>{/if}
		{#if control.offer.includes('merge_plan')}
			<button type="button" disabled={disabled || !control.merge_targets.length} onclick={() => choosing = 'merge_plan'}>{t.control.mergePlan}</button>
			{#if !control.merge_targets.length}<span>{t.control.noMergeTargets}</span>{/if}
		{/if}
	{/if}
	{#if failed}<span role="status" class="control-error">{t.control.failed}</span>{/if}
</div>

<style>
	.new-plan-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; font-size: var(--text-caption); color: var(--muted); }
	p { flex-basis: 100%; margin: 0; }
	label { display: flex; align-items: center; gap: 6px; }
	button, select { min-height: 28px; padding: 0 10px; color: var(--ink-secondary); background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-sm); }
	button { cursor: pointer; }
	button:disabled { opacity: 0.5; cursor: default; }
	.control-error { color: var(--danger-text); }
	@media (pointer: coarse) { button, select { min-height: 36px; } }
</style>
