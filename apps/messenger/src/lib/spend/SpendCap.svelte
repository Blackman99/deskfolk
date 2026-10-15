<script lang="ts">
	import type { SpendCopy } from './spend-copy.ts';

	/**
	 * The day's spend cap on the overview (ADR 0088): a USD amount, saved when you leave the field or
	 * press Enter, or cleared for none. Reaching it is the daemon's to notice; this only sets it.
	 */
	interface Props {
		copy: SpendCopy;
		capUsd: number | null;
		/** Resolves to a refusal (an `ApiError`) or nothing. */
		onSetCap: (usd: number | null) => Promise<unknown>;
	}

	let { copy, capUsd, onSetCap }: Props = $props();
	const fieldId = `spend-cap-${Math.random().toString(36).slice(2, 8)}`;
	let draft = $state('');
	let editing = $state(false);
	let saving = $state(false);
	let issue = $state<'failed' | 'invalid' | null>(null);

	$effect(() => {
		if (!editing && !saving) draft = capUsd === null ? '' : String(capUsd);
	});

	async function save(value: number | null): Promise<void> {
		saving = true;
		issue = null;
		try {
			if (await onSetCap(value)) issue = 'failed';
		} catch {
			issue = 'failed';
		} finally {
			saving = false;
		}
	}

	function commit(): void {
		editing = false;
		const raw = draft.trim();
		if (raw === '') {
			issue = null;
			if (capUsd !== null) void save(null);
			return;
		}
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) {
			issue = 'invalid';
			return;
		}
		issue = null;
		if (value !== capUsd) void save(value);
	}
</script>

<section class="surface cap-card" aria-label={copy.cap.title}>
	<div class="cap-row">
		<label class="cap-title" for={fieldId}>{copy.cap.title}</label>
		<div class="cap-field" class:is-invalid={issue === 'invalid'}>
			<span class="cap-unit" aria-hidden="true">$</span>
			<input
				id={fieldId}
				type="text"
				inputmode="decimal"
				autocomplete="off"
				aria-label={copy.cap.inputLabel}
				aria-invalid={issue === 'invalid'}
				placeholder={copy.cap.off}
				disabled={saving}
				bind:value={draft}
				onfocus={() => (editing = true)}
				onblur={commit}
				onkeydown={(event) => {
					if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
				}}
			/>
		</div>
		{#if capUsd !== null}
			<button type="button" class="cap-clear" disabled={saving} onclick={() => void save(null)}>{copy.cap.clear}</button>
		{/if}
	</div>
	<p class="cap-hint" class:is-error={issue !== null} role={issue ? 'status' : undefined}>
		{issue === 'failed' ? copy.cap.failed : issue === 'invalid' ? copy.cap.invalid : copy.cap.hint}
	</p>
</section>

<style>
	/* The card itself is the ledger's shared `.surface` (SpendView); only its insides are drawn here. */
	.cap-card {
		padding: 14px 20px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.cap-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.cap-title {
		color: var(--muted);
		font-size: 12px;
		font-weight: 550;
	}

	.cap-field {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 32px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
	}

	.cap-field:focus-within {
		border-color: var(--field-focus-border);
		box-shadow: var(--field-focus-ring);
	}

	.cap-field input:focus-visible {
		box-shadow: none;
	}

	.cap-field.is-invalid {
		border-color: var(--danger);
	}

	.cap-unit {
		color: var(--muted);
		font-size: 13px;
	}

	.cap-field input {
		width: 88px;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-variant-numeric: tabular-nums;
	}

	.cap-clear {
		height: 32px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font-size: 13px;
		cursor: pointer;
	}

	.cap-clear:hover:not(:disabled) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.cap-hint {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.5;
	}

	.cap-hint.is-error {
		color: var(--danger);
	}

	@container spend (max-width: 620px) {
		.cap-card {
			padding: 12px 16px;
		}
	}
</style>
