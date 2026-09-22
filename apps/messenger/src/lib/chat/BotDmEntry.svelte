<script lang="ts">
	import type { Approval, Bot, PendingJudgement, SessionSummary, Turn } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import { sidebarStatus, type StatusLabels } from '../sidebar/session-status.ts';

	interface Props {
		sessions: readonly SessionSummary[];
		botsById: Map<string, Bot>;
		turns: readonly Turn[];
		approvals?: readonly Approval[];
		pendingJudgements?: readonly PendingJudgement[];
		isUser?: boolean;
		statusLabels: StatusLabels;
		rosterLabels: { deleted: string; archived: string };
		openedText: string;
		/** How many chips sit inline before the rest collapse into a +N. */
		inlineLimit?: number;
		onOpen: (sessionId: string) => void;
		/** Opens the job the message this entry hangs under belongs to. */
		onShowTrace?: () => void;
		traceLabel?: string;
	}

	let {
		sessions,
		botsById,
		turns,
		approvals = [],
		pendingJudgements = [],
		isUser = false,
		statusLabels,
		rosterLabels,
		openedText,
		inlineLimit = 3,
		onOpen,
		onShowTrace,
		traceLabel
	}: Props = $props();

	const shown = $derived(sessions.slice(0, inlineLimit));
	const overflow = $derived(sessions.length - shown.length);
	const newest = $derived(sessions[sessions.length - 1]);

	function titleOf(session: SessionSummary): string {
		return sessionTitle(session, botsById, rosterLabels);
	}

	function statusOf(session: SessionSummary) {
		return sidebarStatus(session, turns, approvals, statusLabels, pendingJudgements);
	}
</script>

{#if sessions.length > 0}
	<div class="bot-dm-block">
	{#if onShowTrace && traceLabel}
		<button type="button" class="bot-dm-trace" onclick={onShowTrace}>{traceLabel}</button>
	{/if}
	{#if sessions.length === 1}
		{@const session = sessions[0]}
		{@const status = statusOf(session)}
		<div class="bot-dm-card is-single" class:is-user={isUser}>
			<button
				type="button"
				class="bot-dm-chip"
				onclick={() => onOpen(session.id)}
				title={titleOf(session)}
			>
				<SessionAvatar {session} bots={botsById} size="sm" class="bot-dm-avatar" />
				<span class="bot-dm-name">{titleOf(session)}</span>
			</button>
			{#if status.isBusy}
				<span class="bot-dm-live" aria-hidden="true"></span>
				<span class="bot-dm-status text-11p5 text-muted font-normal">{status.label}</span>
			{/if}
		</div>
	{:else}
		<div class="bot-dm-card is-multiple" class:is-user={isUser}>
			<div class="bot-dm-header flex items-center gap-3 py-0 px-1 leading-none select-none">
				<span class="bot-dm-glyph" aria-hidden="true">↔</span>
				<span class="bot-dm-title text-11p5 font-medium text-muted tracking-[0.01em]">{openedText}</span>
				<span class="bot-dm-count mono">{sessions.length}</span>
			</div>
			<div class="bot-dm-roster flex flex-wrap gap-[5px] items-center">
				{#each shown as session (session.id)}
					{@const status = statusOf(session)}
					<button
						type="button"
						class="bot-dm-chip"
						onclick={() => onOpen(session.id)}
						title={titleOf(session)}
					>
						<SessionAvatar {session} bots={botsById} size="sm" class="bot-dm-avatar" />
						<span class="bot-dm-name">{titleOf(session)}</span>
						{#if status.isBusy}
							<span class="bot-dm-live" aria-hidden="true"></span>
						{/if}
					</button>
				{/each}
				{#if overflow > 0 && newest}
					<button
						type="button"
						class="bot-dm-chip is-overflow"
						onclick={() => onOpen(newest.id)}
						title={titleOf(newest)}
					>
						<span class="bot-dm-name">+{overflow}</span>
					</button>
				{/if}
			</div>
		</div>
	{/if}
	</div>
{/if}

<style>
	.bot-dm-block {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.bot-dm-trace {
		border: 0;
		background: transparent;
		padding: 0 4px;
		font-size: 11.5px;
		color: var(--accent);
		cursor: pointer;
	}

	.bot-dm-card {
		box-sizing: border-box;
		animation: botDmFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.bot-dm-card.is-single {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px 3px 4px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: 9999px;
		box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
		font-size: 12px;
		color: var(--muted);
		line-height: 1;
	}

	.bot-dm-card.is-single .bot-dm-chip {
		background: transparent;
		border: none;
		padding: 0;
		box-shadow: none;
		gap: 6px;
	}

	.bot-dm-card.is-multiple {
		display: inline-flex;
		flex-direction: column;
		gap: 7px;
		padding: 7px 10px 9px 10px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: 0 2px 6px rgba(15, 23, 42, 0.06);
		max-width: 100%;
	}

	.bot-dm-glyph {
		font-size: 12px;
		color: var(--accent);
		line-height: 1;
	}

	.bot-dm-count {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
		letter-spacing: 0.01em;
		line-height: 1.2;
	}

	.bot-dm-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2.5px 8px 2.5px 3px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 9999px;
		font-size: 12px;
		line-height: 1;
		color: var(--ink);
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
		user-select: none;
		cursor: pointer;
		outline: none;
		font: inherit;
		transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
	}

	.bot-dm-chip.is-overflow {
		padding: 2.5px 8px;
		color: var(--muted);
	}

	.bot-dm-chip:hover {
		background: var(--line-hover);
		border-color: var(--muted-light);
		transform: translateY(-0.5px);
	}

	.bot-dm-chip:active {
		transform: translateY(0.5px) scale(0.98);
	}

	.bot-dm-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.bot-dm-chip :global(.bot-dm-avatar) {
		flex-shrink: 0;
	}

	.bot-dm-name {
		font-size: 12px;
		font-weight: 500;
		color: var(--ink);
		white-space: nowrap;
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bot-dm-live {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 4px var(--accent-glow);
		flex-shrink: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.bot-dm-card {
			animation: none;
		}
	}

	@keyframes botDmFadeIn {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
