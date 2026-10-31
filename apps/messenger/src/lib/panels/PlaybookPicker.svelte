<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import DangerDialog from '../overlays/DangerDialog.svelte';
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
	/** Moving a conversation with open jobs to an engine with none leaves them where they are: said first (ADR 0103). */
	let moving = $state<{ value: string; jobs: number } | null>(null);
	/** A Select shows what you picked at once: a move you called off, or that failed, puts it back. */
	let resets = $state(0);

	async function choose(value: string): Promise<void> {
		const impact = await playbooks.impactOf(value || playbooks.defaultId, sessionId);
		if (impact && impact.open_jobs > 0) moving = { value, jobs: impact.open_jobs };
		else await move(value);
	}

	function confirmMove(): void {
		const target = moving;
		moving = null;
		if (target) void move(target.value);
	}

	async function move(value: string): Promise<void> {
		const api = runtime.client;
		if (!api) return;
		failed = false;
		try {
			await api.setSessionPlaybook(sessionId, value || null);
		} catch {
			failed = true;
			resets += 1;
		}
	}
</script>

{#if moving}
	<DangerDialog
		copy={{ title: c.moveTitle, body: c.moveBody(moving.jobs), confirm: c.moveConfirm, cancel: c.cancel }}
		{t}
		onDismiss={() => { moving = null; resets += 1; }}
		onConfirm={confirmMove}
	/>
{/if}

{#if playbooks.list}
	<div class="action-list-row playbook-picker" data-playbook-picker>
		<div class="action-list-info">
			<span class="action-list-title">{c.label}</span>
			<span class="action-list-desc">{c.pickerHint}</span>
			{#if failed}<span class="field-error" role="alert">{c.failed}</span>{/if}
		</div>
		<span class="playbook-picker-select">
			{#key resets}
				<Select value={chosen ?? ''} {options} size="sm" ariaLabel={c.label} onchange={(value) => void choose(value)} />
			{/key}
		</span>
	</div>
{/if}

<style>
	.playbook-picker-select {
		flex: none;
		width: 148px;
	}
</style>
