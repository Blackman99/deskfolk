<script lang="ts">
	import { pickWorkspaceFolder, workspacePickerAvailable } from './pick-workspace.ts';

	interface Props {
		id?: string;
		path: string;
		chooseLabel: string;
		changeLabel: string;
		emptyLabel: string;
		unavailableLabel: string;
		dialogTitle: string;
		onChange: (path: string) => void;
	}

	let {
		id = 'workspace',
		path,
		chooseLabel,
		changeLabel,
		emptyLabel,
		unavailableLabel,
		dialogTitle,
		onChange
	}: Props = $props();

	let busy = $state(false);
	let failed = $state(false);
	const canPick = $derived(workspacePickerAvailable());
	const display = $derived(path.trim());
	const actionLabel = $derived(display ? changeLabel : chooseLabel);

	async function choose(): Promise<void> {
		if (busy) return;
		if (!canPick) {
			failed = true;
			return;
		}
		busy = true;
		failed = false;
		try {
			const picked = await pickWorkspaceFolder(path, dialogTitle);
			if (picked) onChange(picked);
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

<div class="workspace-picker" role="group" aria-labelledby={id ? `${id}-label` : undefined}>
	<button
		type="button"
		{id}
		class="workspace-picker-path"
		class:is-empty={!display}
		title={display || emptyLabel}
		aria-label={display || emptyLabel}
		aria-busy={busy}
		disabled={busy}
		onclick={() => void choose()}
	>
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
		</svg>
		<span class="mono">{display || emptyLabel}</span>
	</button>
	<button
		type="button"
		class="btn-preset-workspace"
		disabled={busy}
		onclick={() => void choose()}
	>
		{actionLabel}
	</button>
</div>
{#if !canPick || failed}
	<p class="muted field-hint">{unavailableLabel}</p>
{/if}

<style>
	.workspace-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: stretch;
	}

	.workspace-picker-path {
		flex: 1 1 12rem;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		text-align: left;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 8px 12px;
		background: var(--input-bg);
		color: var(--ink);
		cursor: pointer;
		box-shadow: var(--shadow-xs);
		transition: all 0.15s ease;
	}

	.workspace-picker-path svg {
		flex-shrink: 0;
		color: var(--muted);
	}

	.workspace-picker-path span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workspace-picker-path.is-empty {
		color: var(--muted);
	}

	.workspace-picker-path:hover:not(:disabled) {
		border-color: var(--line-hover);
	}

	.workspace-picker-path:focus-visible {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	.workspace-picker-path:disabled,
	.workspace-picker .btn-preset-workspace:disabled {
		opacity: 0.7;
		cursor: wait;
	}
</style>
