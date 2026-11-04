<script lang="ts">
	import type { InterfaceBehaviour, InterfaceBehaviourKey } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { focusMode } from '../chat/focus-mode.svelte.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import Switch from '../Switch.svelte';
	import { editInterfaceOrToast } from './interface-edit.ts';
	import SettingsCard from './SettingsCard.svelte';
	import SettingsRow from './SettingsRow.svelte';

	/** The closed list of how the app works (ADR 0106); each row has the app's default as its first choice. */
	type Props = { runtime: MessengerRuntime; t: Copy; behaviour: InterfaceBehaviour; phone: boolean };

	let { runtime, t, behaviour, phone }: Props = $props();
	const c = $derived(t.ui.behaviour);

	type Choice = { key: InterfaceBehaviourKey; value: string; label: string };
	const rows = $derived<{ key: 'send_key' | 'time_format' | 'motion'; name: string; titleId: string; values: string[]; labels: Record<string, string> }[]>([
		{ key: 'send_key', name: c.send_key.name, titleId: 'interface-send-key', values: ['enter', 'mod_enter'], labels: { enter: c.send_key.enter, mod_enter: c.send_key.mod_enter } },
		{ key: 'time_format', name: c.time_format.name, titleId: 'interface-time-format', values: ['24h', '12h'], labels: { '24h': c.time_format['24h'], '12h': c.time_format['12h'] } },
		{ key: 'motion', name: c.motion.name, titleId: 'interface-motion', values: ['system', 'reduce'], labels: { system: c.motion.system, reduce: c.motion.reduce } }
	]);

	function choose(key: Choice['key'], value: string | null): void {
		void editInterfaceOrToast(runtime, { behaviour: { [key]: value } as never });
	}
</script>

<SettingsCard class="interface-behaviour">
	<h3 class="interface-card-title">{t.ui.sections.behaviour}</h3>
	<div class="interface-rows">
		<SettingsRow title={c.focus_mode.name} titleId="interface-focus-mode" desc={c.focus_mode.hint}>
			<Switch class="relative inline-flex items-center cursor-pointer select-none" for="interface-focus-mode-toggle" labelledby="interface-focus-mode">
				<input
					id="interface-focus-mode-toggle"
					type="checkbox"
					checked={focusMode.on}
					onchange={(event) => focusMode.set((event.currentTarget as HTMLInputElement).checked)}
				/>
			</Switch>
		</SettingsRow>
		{#each rows as row (row.key)}
			{@const current = behaviour[row.key] ?? null}
			<SettingsRow title={row.name} titleId={row.titleId} desc="">
				<div class="segmented-control" role="group" aria-labelledby={row.titleId} data-behaviour={row.key}>
					<button type="button" class="segmented-btn" class:is-active={current === null} onclick={() => choose(row.key, null)}>
						<span>{c.default}</span>
					</button>
					{#each row.values as value (value)}
						<button type="button" class="segmented-btn" class:is-active={current === value} data-value={value} onclick={() => choose(row.key, value)}>
							<span>{row.labels[value]}</span>
						</button>
					{/each}
				</div>
			</SettingsRow>
		{/each}
		{#if !phone}
			<SettingsRow title={c.open_placement.name} titleId="interface-open-placement" desc={c.open_placement.hint}>
				<span class="interface-note">{c.desktopOnly}</span>
			</SettingsRow>
		{/if}
	</div>
</SettingsCard>

<style>
	.interface-card-title {
		margin: 0;
		font-size: var(--text-body);
		font-weight: 650;
		color: var(--ink);
	}

	.interface-rows {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line-subtle);
	}

	.interface-note {
		font-size: var(--text-caption);
		color: var(--muted);
	}

	/* The same pill switcher as Settings › General's theme and language. */
	.segmented-control {
		display: inline-flex;
		align-items: center;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-md);
		padding: 3px;
		gap: 2px;
	}

	.segmented-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		user-select: none;
		-webkit-user-select: none;
		white-space: nowrap;
	}

	.segmented-btn:hover:not(.is-active) {
		color: var(--ink);
		background: var(--line-subtle);
	}

	.segmented-btn.is-active {
		background: var(--pane);
		color: var(--accent);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	@media (max-width: 540px) {
		.segmented-control {
			width: 100%;
			display: flex;
		}

		.segmented-btn {
			flex: 1;
			justify-content: center;
		}
	}
</style>
