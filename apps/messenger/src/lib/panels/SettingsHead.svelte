<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import GroupIdentity from './GroupIdentity.svelte';
	import SettingsSubject from './SettingsSubject.svelte';
	import type { GroupDetailDraft } from './group-edit.ts';

	type Props = {
		group: boolean;
		/** A Bot opened from a group's settings. */
		nested: boolean;
		onBack: () => void;
		onClose: () => void;
		groupSession?: SessionSummary | null;
		subjectBot?: Bot | null;
		subjectSession?: SessionSummary | null;
		t: Copy;
		/** A phone's screen fills with one section at a time; a wider window keeps them beside it. */
		narrow: boolean;
		runtime: MessengerRuntime;
		botsById: ReadonlyMap<string, Bot>;
		detail: GroupDetailDraft;
	};

	let {
		group,
		nested,
		onBack,
		onClose,
		groupSession = null,
		subjectBot = null,
		subjectSession = null,
		t,
		narrow,
		runtime,
		botsById,
		detail = $bindable()
	}: Props = $props();
</script>

<!--
	The head of a conversation's settings, in the narrow drawer and beside a workbench pane alike.
	`nested` is a Bot opened from a group's settings. On a phone that page's way out is the
	conversation; a wider window still steps back to the group's settings.
	On a phone the page fills the screen, so the head says whose settings these are: the Bot, or
	for a Bot↔Bot direct both of them. A group's head already does, with its editable name.
-->
<div class="sheet-head">
	{#if nested}
		<button
			type="button"
			class="sheet-back"
			aria-label={narrow ? t.common.back : (group ? t.detail.backToGroup : t.detail.backToBot)}
			onclick={onBack}
		>
			<Icon name="chevron-left" size={20} />
			<span class="sheet-back-label">{group ? t.detail.backToGroup : t.detail.backToBot}</span>
		</button>
		{#if narrow && subjectBot}
			<SettingsSubject variant="head" bot={subjectBot} {t} caption={t.detail.titleBot} />
		{/if}
	{:else if group && groupSession}
		<GroupIdentity {runtime} session={groupSession} bind:detail {t} />
	{:else if narrow && (subjectBot || subjectSession)}
		<SettingsSubject
			variant="head"
			bot={subjectBot}
			session={subjectBot ? null : subjectSession}
			bots={botsById}
			{t}
			caption={t.detail.titleBot}
		/>
	{:else}
		<div class="panel-header-title-wrap flex items-center gap-5">
			<div class="panel-header-icon" aria-hidden="true">
				<Icon name="settings" />
			</div>
			<h2>{t.detail.titleBot}</h2>
		</div>
	{/if}
	<button
		type="button"
		class="sheet-close"
		title={t.common.close}
		onclick={onClose}
	>
		<Icon name="x" />
	</button>
</div>

<style>
	.sheet-back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
		justify-content: flex-start;
		border: 0;
		background: transparent;
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
		box-shadow: none;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.sheet-back:hover {
		color: var(--accent-hover);
		background: var(--accent-tint);
	}

	/*
	 * A phone already has a back chevron on every other settings page. The words ("返回群组设置")
	 * stay for a wider window, where this control is a labelled link, and for the button's name.
	 */
	@media (max-width: 680px) {
		.sheet-back {
			flex: 0 0 44px;
			width: 44px;
			height: 44px;
			justify-content: center;
			gap: 0;
			padding: 0;
			border-radius: var(--radius-md);
		}

		.sheet-back-label {
			display: none;
		}
	}

	.panel-header-icon {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		background: var(--accent-tint);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--accent-border);
	}
</style>
