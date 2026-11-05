<script lang="ts">
	import type { InterfaceBehaviour, InterfaceBehaviourKey } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { focusMode } from '../chat/focus-mode.svelte.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { INTERFACE_CODE_THEMES } from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import Switch from '../Switch.svelte';
	import { CODE_THEME_LABELS } from '../interface/code-theme.ts';
	import { editInterfaceOrToast } from './interface-edit.ts';
	import SettingsCard from './SettingsCard.svelte';
	import SettingsRow from './SettingsRow.svelte';

	/** The closed list of how the app works (ADR 0106); each row has the app's default as its first choice. */
	type Props = { runtime: MessengerRuntime; t: Copy; behaviour: InterfaceBehaviour; phone: boolean };

	let { runtime, t, behaviour, phone }: Props = $props();
	const c = $derived(t.ui.behaviour);

	type Choice = { key: InterfaceBehaviourKey; value: string; label: string };
	const rows = $derived<{ key: 'send_key' | 'time_format' | 'motion' | 'content_glass'; name: string; titleId: string; values: string[]; labels: Record<string, string>; hint?: string; desktopOnly?: boolean }[]>([
		{ key: 'send_key', name: c.send_key.name, titleId: 'interface-send-key', values: ['enter', 'mod_enter'], labels: { enter: c.send_key.enter, mod_enter: c.send_key.mod_enter } },
		{ key: 'time_format', name: c.time_format.name, titleId: 'interface-time-format', values: ['24h', '12h'], labels: { '24h': c.time_format['24h'], '12h': c.time_format['12h'] } },
		{ key: 'motion', name: c.motion.name, titleId: 'interface-motion', values: ['system', 'reduce'], labels: { system: c.motion.system, reduce: c.motion.reduce } },
		{ key: 'content_glass', name: c.content_glass.name, titleId: 'interface-content-glass', values: ['frosted', 'clear'], labels: { frosted: c.content_glass.frosted, clear: c.content_glass.clear }, hint: c.content_glass.hint, desktopOnly: true }
	]);

	function choose(key: Choice['key'], value: string | null): void {
		void editInterfaceOrToast(runtime, { behaviour: { [key]: value } as never });
	}

	/** Code colours, one per look (ADR 0106); the first choice is the app's own. */
	const codeLooks = $derived([
		{ look: 'light' as const, label: c.code_theme.light, themes: INTERFACE_CODE_THEMES.light },
		{ look: 'dark' as const, label: c.code_theme.dark, themes: INTERFACE_CODE_THEMES.dark }
	]);

	function codeOptions(themes: readonly string[]): { value: string; label: string }[] {
		return [{ value: '', label: c.code_theme.appDefault }, ...themes.map((theme) => ({ value: theme, label: CODE_THEME_LABELS[theme as keyof typeof CODE_THEME_LABELS] ?? theme }))];
	}

	function chooseCode(look: 'light' | 'dark', value: string): void {
		void editInterfaceOrToast(runtime, { behaviour: { code_theme: { [look]: value || null } } as never });
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
		{#each rows.filter((row) => !(row.desktopOnly && phone)) as row (row.key)}
			{@const current = behaviour[row.key] ?? null}
			<SettingsRow title={row.name} titleId={row.titleId} desc={row.hint ?? ''}>
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
		<SettingsRow title={c.code_theme.name} titleId="interface-code-theme" desc={c.code_theme.hint}>
			<div class="code-theme-pickers" role="group" aria-labelledby="interface-code-theme" data-behaviour="code_theme">
				{#each codeLooks as row (row.look)}
					<label class="code-theme-picker">
						<span class="code-theme-look">{row.label}</span>
						<Select
							size="sm"
							value={behaviour.code_theme?.[row.look] ?? ''}
							options={codeOptions(row.themes)}
							ariaLabel={`${c.code_theme.name} · ${row.label}`}
							title={`${c.code_theme.name} · ${row.label}`}
							onchange={(value) => chooseCode(row.look, value)}
						/>
					</label>
				{/each}
			</div>
		</SettingsRow>
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

	.code-theme-pickers {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		justify-content: flex-end;
	}

	.code-theme-picker {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.code-theme-look {
		font-size: var(--text-caption);
		color: var(--muted);
		white-space: nowrap;
	}

	@media (max-width: 540px) {
		.code-theme-pickers {
			justify-content: stretch;
			width: 100%;
		}

		.code-theme-picker {
			flex: 1;
		}
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
