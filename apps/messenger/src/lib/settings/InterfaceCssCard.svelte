<script lang="ts">
	import { INTERFACE_CSS_MAX, UI_HOOKS, type InterfaceState } from '@real-bot/protocol';
	import { untrack } from 'svelte';
	import { Autosave } from '../autosave.svelte.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import AutosaveState from './AutosaveState.svelte';
	import { editInterface, newSitting } from './interface-edit.ts';
	import SettingsCard from './SettingsCard.svelte';

	/**
	 * The stylesheet of your own, saved as you type. Saves carry the revision this text was loaded
	 * at: when someone else (a Bot) changed it meanwhile, theirs is shown and yours stays here to copy.
	 */
	type Props = { runtime: MessengerRuntime; t: Copy; iface: InterfaceState; locale: 'zh' | 'en' };

	let { runtime, t, iface, locale }: Props = $props();
	const c = $derived(t.ui.css);

	const SAVE_AFTER_MS = 1000;
	const sitting = newSitting();
	const autosave = new Autosave();

	let text = $state(untrack(() => iface.profile.css));
	let loadedRevision = $state<string | null>(untrack(() => iface.revision_id));
	let dirty = $state(false);
	let failed = $state(false);
	let problem = $state<string | null>(null);
	let stale = $state<string | null>(null);
	let copied = $state(false);

	// What the profile says, when nothing of yours is waiting to be saved.
	$effect(() => {
		const revision = iface.revision_id;
		const css = iface.profile.css;
		if (untrack(() => dirty || autosave.saving) || revision === untrack(() => loadedRevision)) return;
		text = css;
		loadedRevision = revision;
	});

	// Leaving the page saves what was typed last.
	$effect(() => () => {
		if (untrack(() => dirty) && autosave.cancel()) void save();
	});

	function onInput(event: Event): void {
		text = (event.currentTarget as HTMLTextAreaElement).value;
		dirty = true;
		problem = null;
		stale = null;
		autosave.schedule(() => void save(), SAVE_AFTER_MS);
	}

	async function save(): Promise<void> {
		if (!dirty || autosave.saving) return;
		const sent = text;
		autosave.saving = true;
		failed = false;
		const result = await editInterface(runtime, { css: { set: sent } }, { if_revision: loadedRevision, edit_session: sitting });
		autosave.saving = false;
		if (result.ok) {
			loadedRevision = result.state.revision_id;
			autosave.savedTick += 1;
			problem = null;
			if (text === sent) dirty = false;
			else autosave.schedule(() => void save(), SAVE_AFTER_MS);
			return;
		}
		if (result.status === 409) {
			// Changed elsewhere: show that, keep yours to copy.
			stale = sent;
			const api = runtime.client;
			const latest = api ? await api.getInterface().catch(() => null) : null;
			const source = latest ?? iface;
			text = source.profile.css;
			loadedRevision = source.revision_id;
			dirty = false;
			return;
		}
		failed = true;
		problem = result.message;
	}

	async function copyStale(): Promise<void> {
		if (!stale) return;
		try {
			await navigator.clipboard.writeText(stale);
			copied = true;
		} catch {
			copied = false;
		}
	}

	let hooksOpen = $state(false);
</script>

<SettingsCard class="interface-css">
	<div class="css-head">
		<h3 class="interface-card-title">{t.ui.sections.css}</h3>
		<AutosaveState {t} saving={autosave.saving} {failed} saved={autosave.savedTick > 0} />
	</div>
	<textarea
		class="css-text"
		aria-label={t.ui.sections.css}
		value={text}
		oninput={onInput}
		placeholder={c.empty}
		spellcheck="false"
		autocapitalize="off"
		autocomplete="off"
		maxlength={INTERFACE_CSS_MAX}
		rows="10"
	></textarea>
	<div class="css-foot">
		<span class="css-length">{c.length.replace('{n}', String(text.length))} / {INTERFACE_CSS_MAX}</span>
		{#if problem}<span class="field-error" role="alert">{problem}</span>{/if}
	</div>
	{#if stale !== null}
		<div class="css-stale" role="status">
			<span>{t.prompts.changedElsewhere}</span>
			<button type="button" class="btn-xs" onclick={() => void copyStale()}>{copied ? t.prompts.copied : t.prompts.copyMine}</button>
		</div>
	{/if}
	<p class="css-hint">{c.hint}</p>
	<details class="css-hooks" bind:open={hooksOpen}>
		<summary>{c.hooks}</summary>
		<ul>
			{#each UI_HOOKS as hook (hook[0])}
				<li><code>[data-ui="{hook[0]}"]</code> <span>{locale === 'en' ? hook[2] : hook[1]}</span></li>
			{/each}
		</ul>
	</details>
</SettingsCard>

<style>
	.css-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.interface-card-title {
		margin: 0;
		font-size: var(--text-body);
		font-weight: 650;
		color: var(--ink);
	}

	.css-text {
		width: 100%;
		box-sizing: border-box;
		min-height: 180px;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		font: var(--text-small) / 1.5 var(--mono);
		resize: vertical;
		tab-size: 2;
	}

	.css-text:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	.css-foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		font-size: var(--text-caption);
	}

	.css-length {
		color: var(--muted);
	}

	.field-error {
		color: var(--danger-text);
	}

	.css-stale {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border-radius: var(--radius-md);
		border: 1px solid var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
		font-size: var(--text-caption);
	}

	.css-hint {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--muted);
	}

	.css-hooks summary {
		cursor: pointer;
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.css-hooks ul {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.css-hooks li {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		font-size: var(--text-caption);
		color: var(--ink-secondary);
	}

	.css-hooks code {
		font-family: var(--mono);
		color: var(--ink);
	}
</style>
