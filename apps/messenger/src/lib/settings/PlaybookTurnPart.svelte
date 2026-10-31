<script lang="ts">
	import { ENGINE_TOOL_KINDS, type EngineToolKind, type Locale, type Playbook, type PlaybookDiff } from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import Switch from '../Switch.svelte';
	import type { PlaybookSaveError } from './playbooks.svelte.ts';

	/**
	 * What a Bot's turn is given in an engine (ADR 0103): the System section, as built in or written
	 * for this engine alone, and which groups of the app's tools it is offered. Each change is saved
	 * as the engine's new difference from its built-in, so it has a revision like any other. A text of
	 * your own stays as you wrote it: no update touches it, which is said where you write it.
	 */
	interface Props {
		playbook: Playbook;
		locale: Locale;
		api: MessengerApi | null;
		onsave: (diff: PlaybookDiff) => void | Promise<unknown>;
		saving: boolean;
		error: PlaybookSaveError | null;
		t: Copy;
	}

	let { playbook, locale, api, onsave, saving, error, t }: Props = $props();
	const c = $derived(t.playbooks.turn);

	const own = $derived(playbook.diff.system?.[locale] ?? null);
	/** The text being written; null while it is closed. */
	let draft = $state<string | null>(null);
	let loadFailed = $state(false);

	// Another engine shown, or the text changed under it: what is open was about the one before.
	$effect(() => {
		void playbook.id;
		draft = null;
		loadFailed = false;
	});

	async function write(): Promise<void> {
		loadFailed = false;
		if (own !== null) {
			draft = own;
			return;
		}
		try {
			draft = api ? (await api.playbookSystem(playbook.id, locale)).text : null;
		} catch {
			loadFailed = true;
		}
	}

	function withSystem(text: string | null): PlaybookDiff {
		const { [locale]: _gone, ...others } = playbook.diff.system ?? {};
		const system = text === null ? others : { ...others, [locale]: text };
		const { system: _before, ...diff } = playbook.diff;
		return Object.keys(system).length > 0 ? { ...diff, system } : diff;
	}

	async function save(): Promise<void> {
		if (draft === null || !draft.trim()) return;
		await onsave(withSystem(draft));
		draft = null;
	}

	async function restore(): Promise<void> {
		await onsave(withSystem(null));
		draft = null;
	}

	function setTool(kind: EngineToolKind, offered: boolean): void {
		const off = (playbook.diff.tools_off ?? []).filter((other) => other !== kind);
		const { tools_off: _before, ...diff } = playbook.diff;
		const next = offered ? off : [...off, kind];
		onsave(next.length > 0 ? { ...diff, tools_off: next } : diff);
	}
</script>

<div class="routing-turn-part" data-routing-part="engine-system">
	<h4 class="routing-turn-part-title">{c.system}</h4>
	<p class="turn-hint">{own === null ? c.systemBuiltin : c.systemOwn}</p>
	{#if draft === null}
		<div class="turn-actions">
			<Button size="sm" disabled={saving} data-engine-system-write onclick={() => void write()}>{own === null ? c.write : c.edit}</Button>
			{#if own !== null}
				<Button size="sm" variant="ghost" disabled={saving} data-engine-system-restore onclick={() => void restore()}>{c.restore}</Button>
			{/if}
		</div>
		{#if loadFailed}
			<p class="field-error" role="alert">{t.playbooks.failed}</p>
		{/if}
	{:else}
		<textarea class="turn-text" rows="14" spellcheck="false" aria-label={c.system} data-engine-system bind:value={draft}></textarea>
		<p class="turn-hint">{c.writeHint}</p>
		<div class="turn-actions">
			<Button size="sm" variant="primary" disabled={saving || !draft.trim()} data-engine-system-save onclick={() => void save()}>{c.save}</Button>
			<Button size="sm" variant="ghost" disabled={saving} onclick={() => (draft = null)}>{t.playbooks.cancel}</Button>
		</div>
	{/if}
	{#if error}
		<p class="field-error" role="alert">{error === 'conflict' ? t.playbooks.conflict : t.playbooks.failed}</p>
	{/if}
</div>

<div class="routing-turn-part" data-routing-part="engine-tools">
	<h4 class="routing-turn-part-title">{c.tools}</h4>
	<p class="turn-hint">{c.toolsHint}</p>
	{#each ENGINE_TOOL_KINDS as kind (kind)}
		{@const offered = !(playbook.diff.tools_off ?? []).includes(kind)}
		<label class="turn-tool">
			<span>{t.prompts.toolKinds[kind]}</span>
			<Switch disabled={saving}>
				<input type="checkbox" checked={offered} disabled={saving} aria-label={t.prompts.toolKinds[kind]} data-engine-tool={kind} onchange={(event) => setTool(kind, event.currentTarget.checked)} />
			</Switch>
		</label>
	{/each}
</div>

<style>
	.routing-turn-part {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}

	.routing-turn-part-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.turn-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--ink-secondary);
	}

	.turn-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.turn-text {
		width: 100%;
		box-sizing: border-box;
		min-height: 180px;
		resize: vertical;
		font-size: 12px;
		line-height: 1.6;
	}

	.turn-tool {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		font-size: 13px;
		color: var(--ink);
	}
</style>
