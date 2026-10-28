<script lang="ts">
	/**
	 * Settings › General: the app's permission mode (ADR 0092), what every Bot without its own may do
	 * without asking you. One choice of four, saved as it is picked; the Bots that chose their own are
	 * named under it, so a Bot behaving otherwise is not a mystery.
	 */
	import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type Bot, type PermissionMode } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import SettingsCard from './SettingsCard.svelte';
	import SettingsCardHeader from './SettingsCardHeader.svelte';
	import type { Copy } from '../copy.ts';

	interface Props {
		t: Copy;
		mode: PermissionMode;
		bots: readonly Bot[];
		/** Resolves false when the mode could not be saved. */
		onChoose: (mode: PermissionMode) => Promise<boolean>;
	}

	let { t, mode, bots, onChoose }: Props = $props();

	let busy = $state(false);
	let failed = $state(false);
	/** The mode just picked, shown until the saved one catches up; dropped again if it did not save. */
	let picked = $state<PermissionMode | null>(null);
	const shown = $derived(picked ?? mode);

	$effect(() => {
		if (picked !== null && mode === picked) picked = null;
	});

	const overrides = $derived(
		bots
			.filter((bot) => !bot.archived_at && bot.permission_mode)
			.map((bot) => t.permissions.overrideItem(bot.name, t.permissions.modes[bot.permission_mode!]))
	);

	async function choose(next: PermissionMode): Promise<void> {
		if (busy || next === shown) return;
		busy = true;
		failed = false;
		picked = next;
		try {
			failed = !(await onChoose(next));
		} catch {
			failed = true;
		} finally {
			busy = false;
			if (failed) picked = null;
		}
	}
</script>

<SettingsCard class="settings-card-permission-mode">
	<SettingsCardHeader title={t.permissions.title} subtitle={t.permissions.subtitle}>
		{#snippet icon()}
			<div class="settings-header-icon-wrap" aria-hidden="true">
				<Icon name="shield-check" />
			</div>
		{/snippet}
	</SettingsCardHeader>

	<div class="permission-modes" role="radiogroup" aria-label={t.permissions.title} data-testid="permission-modes">
		{#each PERMISSION_MODES as option (option)}
			<label class="permission-mode" class:is-active={shown === option}>
				<input
					type="radio"
					name="app-permission-mode"
					value={option}
					checked={shown === option}
					disabled={busy}
					onchange={() => void choose(option)}
				/>
				<span class="permission-mode-text">
					<span class="permission-mode-name">
						<span class="permission-mode-label">{t.permissions.modes[option]}</span>
						{#if option === DEFAULT_PERMISSION_MODE}<span class="permission-mode-tag">{t.permissions.defaultTag}</span>{/if}
					</span>
					<span class="permission-mode-desc">{t.permissions.descriptions[option]}</span>
				</span>
			</label>
		{/each}
	</div>
	{#if failed}
		<p class="field-error" role="alert">{t.permissions.saveFailed}</p>
	{/if}
	{#if overrides.length > 0}
		<p class="permission-note" data-testid="permission-overrides">{t.permissions.overrides(overrides)}</p>
	{/if}
	<p class="permission-note">{t.permissions.alwaysRefused}</p>
</SettingsCard>

<style>
	.permission-modes {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 4px;
	}

	.permission-mode {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 9px 12px;
		border: 1px solid var(--line-subtle);
		border-radius: var(--radius-md);
		cursor: pointer;
	}

	.permission-mode:hover {
		border-color: var(--line-hover);
	}

	.permission-mode.is-active {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.permission-mode input {
		margin: 3px 0 0;
		flex: none;
		accent-color: var(--accent);
	}

	.permission-mode-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.permission-mode-name {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.permission-mode-tag {
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
	}

	.permission-mode-desc {
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	/* `--muted` on the accent tint is 4.3:1 in dark. */
	.permission-mode.is-active .permission-mode-desc {
		color: var(--ink-secondary);
	}

	.permission-note {
		margin: 8px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}
</style>
