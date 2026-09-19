<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import MultiSelect from '../MultiSelect.svelte';
	import { avatarSrc } from '../avatar.ts';
	import { botAvatarColor } from '../chat/chat-view.ts';
	import type { Copy } from '../copy.ts';
	import {
		mapCreateGroupError,
		planCreateGroup,
		type CreateGroupFieldErrors
	} from '../panels/create-form.ts';
	import { rosterLetter } from './roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { NormalizedSelectOption, SelectOption } from '../select-options.ts';

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

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const memberOptions = $derived<SelectOption[]>(
		bots.map((bot) => ({ value: bot.id, label: bot.name, hint: bot.duties }))
	);

	function onNameInput(): void {
		if (errors.name) errors = { ...errors, name: undefined };
		failed = false;
	}

	function onMembersChange(): void {
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

<!--
  The same avatar the roster, the transcript and the group panel draw: the Bot's own image when it
  has one, its letter on its own colour when it does not.
-->
{#snippet memberAvatar(option: NormalizedSelectOption, where: 'chip' | 'option')}
	{@const bot = botsById.get(option.value)}
	{@const palette = botAvatarColor(option.value)}
	{@const src = bot ? avatarSrc(bot.avatar) : null}
	<span
		class="member-avatar is-{where}"
		style="background: {palette.bg}; color: {palette.text}; border-color: {palette.border};"
		aria-hidden="true"
	>
		{#if src}
			<img {src} alt="" class="avatar-img" />
		{:else}
			{rosterLetter(option.label)}
		{/if}
	</span>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="modal-backdrop"
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	onclick={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose();
	}}
>
	<div class="modal-dialog create-group-modal">
		<div class="modal-head">
			<h2>{t.sidebar.addGroup}</h2>
			<button type="button" class="modal-close" title={t.common.close} onclick={onClose}>✕</button>
		</div>
		<div class="modal-body">
			{#if failed}
				<p class="field-error">{t.sidebar.saveFailed}</p>
			{/if}
			<div class="modal-section">
				<label for="group-name">{t.sidebar.groupName}</label>
				<input id="group-name" type="text" bind:value={name} oninput={onNameInput} />
				{#if errors.name}
					<p class="field-error">{t.sidebar.groupNameEmpty}</p>
				{/if}
			</div>
			<div class="modal-section">
				<label for="group-members">{t.sidebar.groupMembers}</label>
				<MultiSelect
					id="group-members"
					bind:values={members}
					options={memberOptions}
					placeholder={t.sidebar.groupMembersPlaceholder}
					searchPlaceholder={t.sidebar.groupMemberSearch}
					emptyLabel={t.sidebar.groupMemberNone}
					noMatchLabel={t.sidebar.groupMemberNoMatch}
					removeLabel={t.sidebar.groupMemberRemove}
					media={memberAvatar}
					error={!!errors.members}
					onchange={onMembersChange}
				/>
				{#if errors.members}
					<p class="field-error">{t.sidebar.membersTooFew}</p>
				{/if}
			</div>
		</div>
		<div class="modal-foot actions">
			<button type="button" onclick={() => void save()}>{t.sidebar.create}</button>
			<button type="button" onclick={onClose}>{t.common.close}</button>
		</div>
	</div>
</div>

<style>
	/*
	 * Two fields, so this dialog never scrolls — and it must not, because the member list opens
	 * out of the body and a scroll box would cut it off at the fold. The overflow the frame
	 * normally carries is off here; the head and foot round their own corners in its place.
	 */
	.modal-dialog.create-group-modal {
		width: 440px;
		max-width: 95vw;
		overflow: visible;
	}

	.create-group-modal :global(.modal-head) {
		border-radius: var(--radius-xl) var(--radius-xl) 0 0;
	}

	.create-group-modal :global(.modal-body) {
		overflow: visible;
		padding: 20px 24px;
		gap: 16px;
	}

	.create-group-modal :global(.modal-foot) {
		border-radius: 0 0 var(--radius-xl) var(--radius-xl);
	}

	.member-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid;
		border-radius: 50%;
		overflow: hidden;
		font-weight: 700;
		line-height: 1;
	}

	.member-avatar.is-option {
		width: 22px;
		height: 22px;
		font-size: 11px;
	}

	.member-avatar.is-chip {
		width: 17px;
		height: 17px;
		font-size: 9px;
	}
</style>
