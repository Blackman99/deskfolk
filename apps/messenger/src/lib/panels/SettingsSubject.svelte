<script lang="ts">
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import type { Copy } from '../copy.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';

	/**
	 * Whose settings a phone screen is showing. There every settings screen fills the phone, and a
	 * section or an editor two levels in had nothing on it saying whose skills or memory these were.
	 * The drawer's own head carries it large, the way a group's already did; a section or an editor
	 * carries it as a line under its own title.
	 */
	type Props = {
		/** One Bot's settings: a you↔Bot conversation's, or a Bot opened from a group. */
		bot?: Bot | null;
		/** A conversation's own settings: a group, or a Bot↔Bot direct. */
		session?: SessionSummary | null;
		bots?: ReadonlyMap<string, Bot>;
		t: Copy;
		/** `head` stands in for the drawer's title; `line` sits under a page's own title. */
		variant: 'head' | 'line';
		/** Under the name in the head: what these settings are. */
		caption?: string;
	};

	let { bot = null, session = null, bots = new Map(), t, variant, caption }: Props = $props();

	const name = $derived(
		bot
			? bot.name
			: session
				? sessionTitle(session, bots, { deleted: t.top.deleted, archived: t.top.archived })
				: ''
	);
	const src = $derived(bot ? avatarSrc(bot.avatar) : null);
	const palette = $derived(bot ? botAvatarColor(bot.id) : null);
	let failedSrc = $state<string | null>(null);
</script>

<span class="settings-subject is-{variant}">
	{#if bot && palette}
		<span class="row-avatar layout-single subject-avatar" aria-hidden="true">
			<span
				class="row-avatar-bot slot-0"
				style="background: {palette.bg}; color: {palette.text}; border-color: {palette.border};"
			>
				{#if src && failedSrc !== src}
					<img {src} alt="" class="avatar-img" onerror={() => (failedSrc = src)} />
				{:else}
					{rosterLetter(bot.name)}
				{/if}
			</span>
		</span>
	{:else if session}
		<SessionAvatar {session} {bots} size={variant === 'head' ? 'top' : 'tab'} class="subject-avatar" />
	{/if}
	<span class="settings-subject-copy">
		{#if variant === 'head'}
			<h2 class="settings-subject-name">{name}</h2>
			{#if caption}<span class="settings-subject-caption">{caption}</span>{/if}
		{:else}
			<span class="settings-subject-name">{name}</span>
		{/if}
	</span>
</span>

<style>
	.settings-subject {
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.settings-subject.is-head {
		flex: 1;
		gap: 12px;
	}

	.settings-subject.is-line {
		gap: 6px;
		color: var(--muted);
	}

	/* Not in the roster's grid here; the shared avatar rules place it in one. */
	.settings-subject :global(.subject-avatar) {
		grid-column: auto;
		grid-row: auto;
		flex-shrink: 0;
		--avatar-ring: var(--pane);
	}

	.settings-subject.is-head :global(.subject-avatar) {
		--avatar-size: 36px;
	}

	.settings-subject.is-line :global(.subject-avatar) {
		--avatar-size: 18px;
	}

	.settings-subject-copy {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.settings-subject-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.is-head .settings-subject-name {
		margin: 0;
		color: var(--ink);
		font: 700 15px/1.3 var(--font);
		letter-spacing: -0.01em;
	}

	.is-line .settings-subject-name {
		font-size: 12.5px;
		font-weight: 500;
		line-height: 1.3;
	}

	.settings-subject-caption {
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
	}
</style>
