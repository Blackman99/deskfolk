<script lang="ts">
	import { listRemoteHostDir, pickWorkspaceFolder, workspacePickerAvailable, type HostTreePage } from './pick-workspace.ts';
	import type { MessengerApi } from '../messenger-api.ts';

	interface Props {
		id?: string;
		path: string;
		chooseLabel: string;
		changeLabel: string;
		emptyLabel: string;
		unavailableLabel: string;
		dialogTitle: string;
		onChange: (path: string) => void;
		remote?: boolean;
		api?: MessengerApi | null;
		browseHint?: string;
		permissionHint?: string;
		truncatedHint?: string;
		confirmHint?: string;
		upLabel?: string;
		useLabel?: string;
		cancelLabel?: string;
	}

	let {
		id = 'workspace',
		path,
		chooseLabel,
		changeLabel,
		emptyLabel,
		unavailableLabel,
		dialogTitle,
		onChange,
		remote = false,
		api = null,
		browseHint = '',
		permissionHint = '',
		truncatedHint = '',
		confirmHint = '',
		upLabel = 'Up',
		useLabel = 'Use this folder',
		cancelLabel = 'Cancel',
	}: Props = $props();

	let busy = $state(false);
	let failed = $state(false);
	let permission = $state(false);
	let browsing = $state(false);
	let page = $state<HostTreePage | null>(null);
	let browseError = $state('');
	const canPick = $derived(workspacePickerAvailable(undefined, remote));
	const display = $derived(path.trim());
	const actionLabel = $derived(display ? changeLabel : chooseLabel);

	async function load(dir: string): Promise<void> {
		if (!api) return;
		busy = true;
		browseError = '';
		permission = false;
		try {
			page = await listRemoteHostDir(api, dir);
			browsing = true;
		} catch (error) {
			failed = true;
			permission = Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'host_permission');
			browseError = permission ? permissionHint : unavailableLabel;
		} finally {
			busy = false;
		}
	}

	async function choose(): Promise<void> {
		if (busy) return;
		if (remote) {
			if (!api) {
				failed = true;
				return;
			}
			await load(path.trim() || '');
			return;
		}
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

	function useCurrent(): void {
		if (!page) return;
		onChange(page.path);
		browsing = false;
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
{#if permission && permissionHint}
	<p class="muted field-hint">{permissionHint}</p>
{:else if !canPick || failed}
	<p class="muted field-hint">{browseError || unavailableLabel}</p>
{/if}
{#if browsing && page}
	<div class="host-browse" role="dialog" aria-label={dialogTitle}>
		<p class="mono host-browse-path">{page.path}</p>
		{#if browseHint}<p class="muted field-hint">{browseHint}</p>{/if}
		{#if confirmHint}<p class="muted field-hint">{confirmHint}</p>{/if}
		<div class="host-browse-actions">
			<button type="button" class="btn-preset-workspace" disabled={!page.parent || busy} onclick={() => void load(page?.parent ?? '')}>{upLabel}</button>
			<button type="button" class="btn-preset-workspace" onclick={useCurrent}>{useLabel}</button>
			<button type="button" class="btn-preset-workspace" onclick={() => (browsing = false)}>{cancelLabel}</button>
		</div>
		<ul class="host-browse-list">
			{#each page.items.filter((row) => row.kind === 'dir') as row (row.path)}
				<li>
					<button type="button" class="host-browse-item" onclick={() => void load(row.path)}>
						<span class="mono">{row.name}</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if page.truncated}<p class="muted field-hint">{truncatedHint}</p>{/if}
	</div>
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

	.host-browse {
		margin-top: 8px;
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 10px 12px;
		background: var(--input-bg);
	}

	.host-browse-path {
		margin: 0 0 6px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.host-browse-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 8px 0;
	}

	.host-browse-list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 12rem;
		overflow: auto;
	}

	.host-browse-item {
		width: 100%;
		text-align: left;
		padding: 6px 8px;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.host-browse-item:hover {
		background: var(--hover);
	}
</style>
