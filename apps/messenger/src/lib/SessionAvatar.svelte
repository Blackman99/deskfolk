<script lang="ts">
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import { compositeAvatarLayout, sessionAvatars } from './avatar.ts';
	import { botAvatarColor } from './chat/chat-view.ts';
	import { rosterLetter } from './sidebar/roster-letter.ts';
	import { youBotPeer } from './sidebar/session-groups.ts';
	import type { SessionStatusResult } from './sidebar/session-status.ts';

	let {
		session,
		bots,
		size = 'md',
		class: customClass = '',
		botStatus
	}: {
		session: SessionSummary;
		bots: ReadonlyMap<string, Bot>;
		size?: 'sm' | 'md' | 'top' | 'hero';
		class?: string;
		botStatus?: (botId: string) => SessionStatusResult | undefined;
	} = $props();

	const avatars = $derived(sessionAvatars(session, bots));
	const plan = $derived(compositeAvatarLayout(avatars));
	let failedSources = $state<Record<string, string>>({});

	const overflowTooltip = $derived(
		plan.overflowCount > 0 ? `+${plan.overflowCount} (${plan.overflowNames.join(', ')})` : ''
	);

	const peerBotId = $derived(youBotPeer(session));
	const targetBotId = $derived(
		peerBotId ?? (plan.layout === 'single' && avatars.length === 1 && bots.has(avatars[0].id) ? avatars[0].id : null)
	);
	const targetBot = $derived(targetBotId ? (bots.get(targetBotId) ?? null) : null);
	const statusResult = $derived(
		targetBotId && targetBot && !targetBot.archived_at && botStatus
			? botStatus(targetBotId)
			: undefined
	);
</script>

<span
	class="row-avatar size-{size} layout-{plan.layout} {customClass}"
	class:is-group={session.kind === 'group'}
	class:is-stack={avatars.length > 1}
	class:has-overflow={plan.overflowCount > 0}
	aria-hidden="true"
>
	{#if plan.layout === 'empty'}
		<span class="row-avatar-bot is-empty">
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
				<circle cx="9" cy="7" r="4" />
				<path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
			</svg>
		</span>
	{:else}
		{#each plan.visible as avatar, i (avatar.id)}
			{@const palette = botAvatarColor(avatar.id)}
			<span
				class="row-avatar-bot slot-{i}"
				style="background: {palette.bg}; color: {palette.text}; border-color: {palette.border};"
				title={avatar.name ?? 'Bot'}
			>
				{#if avatar.src && failedSources[avatar.id] !== avatar.src}
					<img
						src={avatar.src}
						alt={avatar.name ?? ''}
						class="avatar-img"
						onerror={() => { failedSources[avatar.id] = avatar.src!; }}
					/>
				{:else}
					{avatar.name ? rosterLetter(avatar.name) : '?'}
				{/if}
			</span>
		{/each}
		{#if plan.overflowCount > 0}
			<span
				class="row-avatar-bot is-overflow slot-overflow"
				title={overflowTooltip}
			>
				+{plan.overflowCount > 99 ? '99' : plan.overflowCount}
			</span>
		{/if}
		{#if statusResult}
			<span
				class="avatar-status-dot is-{statusResult.kind}"
				class:is-busy={statusResult.isBusy}
				title="{targetBot?.name ?? 'Bot'}: {statusResult.label}"
			></span>
		{/if}
	{/if}
</span>

<style>
	.row-avatar.size-top :global(.avatar-status-dot) {
		width: 9px;
		height: 9px;
	}

	.row-avatar.size-hero :global(.avatar-status-dot) {
		width: 12px;
		height: 12px;
		border-width: 2.5px;
	}

	.row-avatar.size-md {
		--avatar-size: 40px;
	}

	.row-avatar.size-top {
		--avatar-size: 36px;
	}

	.row-avatar.size-hero {
		--avatar-size: 44px;
	}

	/* 2-bot pair stack */
	.row-avatar.layout-pair :global(.row-avatar-bot),
	.row-avatar.is-stack:not(.layout-triad):not(.layout-quad) :global(.row-avatar-bot) {
		position: absolute;
		width: 62%;
		height: 62%;
		font-size: calc(var(--avatar-size) * 0.28);
	}

	.row-avatar.layout-pair .slot-0,
	.row-avatar.is-stack:not(.layout-triad):not(.layout-quad) :global(.row-avatar-bot:first-child) {
		top: 0;
		left: 0;
		z-index: 1;
	}

	.row-avatar.layout-pair .slot-1,
	.row-avatar.is-stack:not(.layout-triad):not(.layout-quad) :global(.row-avatar-bot:last-child) {
		bottom: 0;
		right: 0;
		z-index: 2;
		box-shadow: 0 0 0 calc(var(--avatar-size) * 0.045) var(--avatar-ring, var(--sidebar-bg));
	}

	/* 3-bot triad cluster (matches user reference image: 1 top center, 2 bottom left/right) */
	.row-avatar.layout-triad :global(.row-avatar-bot) {
		position: absolute;
		width: 58%;
		height: 58%;
		font-size: calc(var(--avatar-size) * 0.26);
	}

	.row-avatar.layout-triad .slot-0 {
		top: 0;
		left: 50%;
		transform: translateX(-50%);
		z-index: 1;
	}

	.row-avatar.layout-triad .slot-1 {
		bottom: 0;
		left: 0;
		z-index: 2;
		box-shadow: 0 0 0 calc(var(--avatar-size) * 0.045) var(--avatar-ring, var(--sidebar-bg));
	}

	.row-avatar.layout-triad .slot-2 {
		bottom: 0;
		right: 0;
		z-index: 3;
		box-shadow: 0 0 0 calc(var(--avatar-size) * 0.045) var(--avatar-ring, var(--sidebar-bg));
	}

	/* 4-bot & 5+ bot quad cluster */
	.row-avatar.layout-quad :global(.row-avatar-bot) {
		position: absolute;
		width: 52%;
		height: 52%;
		font-size: calc(var(--avatar-size) * 0.24);
	}

	.row-avatar.layout-quad .slot-0 {
		top: 0;
		left: 0;
		z-index: 1;
	}

	.row-avatar.layout-quad .slot-1 {
		top: 0;
		right: 0;
		z-index: 2;
		box-shadow: 0 0 0 calc(var(--avatar-size) * 0.045) var(--avatar-ring, var(--sidebar-bg));
	}

	.row-avatar.layout-quad .slot-2 {
		bottom: 0;
		left: 0;
		z-index: 3;
		box-shadow: 0 0 0 calc(var(--avatar-size) * 0.045) var(--avatar-ring, var(--sidebar-bg));
	}

	.row-avatar.layout-quad .slot-3,
	.row-avatar.layout-quad .slot-overflow {
		bottom: 0;
		right: 0;
		z-index: 4;
		box-shadow: 0 0 0 calc(var(--avatar-size) * 0.045) var(--avatar-ring, var(--sidebar-bg));
	}
</style>
