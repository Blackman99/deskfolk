<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import {
		mapCreateGroupError,
		planCreateGroup,
		type CreateGroupFieldErrors
	} from '../create-form.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';

	type Props = {
		runtime: MessengerRuntime;
		bots: Bot[];
		t: Copy;
		onClose: () => void;
	};

	let { runtime, bots, t, onClose }: Props = $props();

	// The sheet is mounted only while it is open, so a fresh mount is the reset.
	let name = $state('');
	let members = $state<string[]>([]);
	let errors = $state<CreateGroupFieldErrors>({});
	let failed = $state(false);

	function onNameInput(): void {
		if (errors.name) errors = { ...errors, name: undefined };
		failed = false;
	}

	function toggleMember(id: string): void {
		members = members.includes(id)
			? members.filter((member) => member !== id)
			: [...members, id];
		if (errors.members) errors = { ...errors, members: undefined };
		failed = false;
	}

	async function save(): Promise<void> {
		failed = false;
		errors = {};
		const plan = planCreateGroup({ name, members });
		if (!plan.ok) {
			errors = plan.errors;
			return;
		}
		const error = await runtime.createGroup(plan.body);
		if (!error) return;
		const mapped = mapCreateGroupError(error.status, error.message);
		if ('top' in mapped) failed = true;
		else errors = mapped;
	}
</script>

<div class="sheet">
	<div class="sheet-head">
		<h2>{t.sidebar.addGroup}</h2>
		<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>✕</button>
	</div>
	{#if failed}
		<p class="field-error">{t.sidebar.saveFailed}</p>
	{/if}
	<label for="group-name">{t.sidebar.groupName}</label>
	<input id="group-name" type="text" bind:value={name} oninput={onNameInput} />
	{#if errors.name}
		<p class="field-error">{t.sidebar.groupNameEmpty}</p>
	{/if}
	<p class="field-head">{t.sidebar.groupMembers}</p>
	<div class="members">
		{#each bots as bot (bot.id)}
			<label>
				<input
					type="checkbox"
					checked={members.includes(bot.id)}
					onchange={() => toggleMember(bot.id)}
				/>
				{bot.name}
			</label>
		{/each}
	</div>
	{#if errors.members}
		<p class="field-error">{t.sidebar.membersTooFew}</p>
	{/if}
	<div class="actions">
		<button type="button" onclick={() => void save()}>{t.sidebar.create}</button>
		<button type="button" onclick={onClose}>{t.common.close}</button>
	</div>
</div>
