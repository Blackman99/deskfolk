<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import Select from '../Select.svelte';
	import { playbookName, Playbooks } from '../settings/playbooks.svelte.ts';

	/**
	 * The engine a conversation runs (ADR 0085): one of the engines, or follow the default. A row of
	 * a group's actions, or of a Bot's actions in your direct; the engines themselves are on Roles.
	 * Not shown where the Mac has no engines yet.
	 */
	interface Props {
		runtime: MessengerRuntime;
		sessionId: string;
		t: Copy;
	}

	let { runtime, sessionId, t }: Props = $props();
	const c = $derived(t.playbooks);

	const playbooks = new Playbooks(() => runtime.client);
	$effect(() => {
		void runtime.client;
		void runtime.playbooksRevision;
		void playbooks.load();
	});

	const chosen = $derived(runtime.snapshot.sessions.find((session) => session.id === sessionId)?.playbook_id ?? null);
	const defaultName = $derived(playbookName(playbooks.find(playbooks.defaultId), c.builtin));
	const options = $derived([
		{ value: '', label: c.followDefault(defaultName) },
		...playbooks.items.map((item) => ({ value: item.id, label: playbookName(item, c.builtin) }))
	]);
	let failed = $state(false);

	async function choose(value: string): Promise<void> {
		const api = runtime.client;
		if (!api) return;
		failed = false;
		try {
			await api.setSessionPlaybook(sessionId, value || null);
		} catch {
			failed = true;
		}
	}
</script>

{#if playbooks.list}
	<div class="action-list-row playbook-picker" data-playbook-picker>
		<div class="action-list-info">
			<span class="action-list-title">{c.label}</span>
			<span class="action-list-desc">{c.pickerHint}</span>
			{#if failed}<span class="field-error" role="alert">{c.failed}</span>{/if}
		</div>
		<span class="playbook-picker-select">
			<Select value={chosen ?? ''} {options} size="sm" ariaLabel={c.label} onchange={(value) => void choose(value)} />
		</span>
	</div>
{/if}

<style>
	.playbook-picker-select {
		flex: none;
		width: 148px;
	}
</style>
