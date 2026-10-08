<script lang="ts">
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import type { Copy } from '../copy.ts';
	import { unreadBadge } from './unread.ts';
	import type { SessionStatusResult } from './session-status.ts';

	/**
	 * One row of the session list: avatar, title, time, status and the last line. The five lists
	 * (archived, file drop, groups, you↔Bot, Bot↔Bot) differ only in what they pass: the text, whether
	 * the status carries its count, and whether unread is marked (a Bot↔Bot direct passes none).
	 */
	type Props = {
		session: SessionSummary;
		t: Copy;
		/** The open conversation. */
		on: boolean;
		/** The row the context menu belongs to. */
		contextOpen: boolean;
		/** The archived list dims its rows. */
		archived?: boolean;
		/** The file drop's row has a mark of its own where the avatar goes. */
		fileDrop?: boolean;
		title: string;
		time: string;
		status: SessionStatusResult;
		/** The file drop's status has no count beside it. */
		showCount?: boolean;
		preview: string;
		unread: number;
		bots: ReadonlyMap<string, Bot>;
		botStatus: (botId: string) => SessionStatusResult | undefined;
		onSelect: () => void;
		onContextMenu: (e: MouseEvent) => void;
	};

	let {
		session,
		t,
		on,
		contextOpen,
		archived = false,
		fileDrop = false,
		title,
		time,
		status,
		showCount = true,
		preview,
		unread,
		bots,
		botStatus,
		onSelect,
		onContextMenu
	}: Props = $props();
</script>

<button
	type="button"
	class="row{archived ? ' is-archived-row opacity-85' : ''}"
	class:is-on={on}
	class:is-context-open={contextOpen}
	class:is-unread={unread > 0}
	onclick={onSelect}
	oncontextmenu={onContextMenu}
>
	{#if fileDrop}
		<span class="row-avatar size-md" aria-hidden="true">
			<span class="row-avatar-bot file-drop-mark">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
					<polyline points="14 2 14 8 20 8"></polyline>
					<line x1="12" y1="18" x2="12" y2="12"></line>
					<polyline points="9 15 12 18 15 15"></polyline>
				</svg>
			</span>
		</span>
	{:else}
		<SessionAvatar {session} {bots} {botStatus} />
	{/if}
	<span class="t">{title}</span>
	<span class="row-time">{time}</span>
	<span class="row-status is-{status.kind}">
		<span class="row-status-dot" class:is-busy={status.isBusy}></span>
		<span class="row-status-text">{status.label}</span>
		{#if showCount && status.count}
			<span class="badge">{status.count}</span>
		{/if}
	</span>
	<span class="s">{preview}</span>
	{#if unread > 0}
		<span class="unread-dot" title={t.sidebar.unread}>{unreadBadge(unread)}</span>
	{/if}
</button>


<style>
	.file-drop-mark {
		background: var(--accent-tint);
		color: var(--accent);
		border-color: transparent;
	}

	.row {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr) auto auto;
		grid-template-rows: auto auto;
		gap: 2px 10px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		margin: 1px 0;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		color: inherit;
		transition: 0.12s ease;
		transition-property: var(--transition-props);
	}

	.row:hover {
		background: var(--row-hover);
	}

	.row.is-on:hover {
		background: var(--accent-tint);
	}

	/* The tint alone marks the open conversation; an outline on top of it was one signal too many. */
	.row.is-on {
		background: var(--accent-tint);
	}

	/* Ring colors according to active / hover / container contexts */
	.row :global(.row-avatar) {
		--avatar-ring: var(--sidebar-bg);
	}

	.row:hover :global(.row-avatar) {
		--avatar-ring: var(--accent-tint);
	}

	.row.is-on :global(.row-avatar) {
		--avatar-ring: var(--accent-tint);
	}

	.row.is-on :global(.row-avatar) :global(.slot-overflow) {
		background: var(--accent);
		color: var(--on-accent);
		border-color: var(--accent);
	}

	.row.is-unread .t {
		font-weight: 750;
	}

	.row .t {
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		grid-column: 2;
		grid-row: 1;
		min-width: 0;
	}


	.row :global(.s) {
		font-size: 12px;
		color: var(--muted);
		grid-column: 2 / -1;
		grid-row: 2;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.4;
		min-height: 1.4em;
	}

	/* The time beside each name, the way a messenger shows it. */
	.row-time {
		grid-column: 3;
		grid-row: 1;
		justify-self: end;
		align-self: center;
		font-size: 11px;
		line-height: 1.3;
		color: var(--muted);
		white-space: nowrap;
	}

	.row.is-unread .row-time {
		color: var(--mustard-ink);
		font-weight: 600;
	}

	/*
	 * Idle is the normal state, so it carries no mark at all: a green "空闲" on every row drowned
	 * out the rows that did need a look. The label only appears when a Bot is doing something or
	 * waiting on you, and then it speaks in place of the last message, the way a messenger shows
	 * "typing…".
	 */
	.row-status {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		grid-column: 2 / 4;
		grid-row: 2;
		min-width: 0;
		font-size: 12px;
		line-height: 1.4;
		white-space: nowrap;
	}

	.row-status.is-idle {
		display: none;
	}

	.row:has(.row-status:not(.is-idle)) :global(.s) {
		display: none;
	}

	.row-status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: background 0.15s ease;
	}

	.row-status.is-running .row-status-dot {
		background: var(--accent);
		animation: pulse 1s infinite;
	}

	.row-status.is-running .row-status-text {
		color: var(--accent);
		font-weight: 600;
	}

	.row-status.is-replying .row-status-dot {
		background: var(--accent);
		animation: pulse 1s infinite;
	}

	.row-status.is-replying .row-status-text {
		color: var(--accent);
		font-weight: 600;
	}

	.row-status.is-waiting_approval .row-status-dot {
		background: var(--warn);
	}

	.row-status.is-waiting_approval .row-status-text {
		color: var(--warn-text);
		font-weight: 600;
	}

	.row-status.is-waiting_ask .row-status-dot {
		background: var(--purple);
	}

	.row-status.is-waiting_ask .row-status-text {
		color: var(--purple-text);
		font-weight: 600;
	}

	/* Stopped by you: not a state that needs a look, so it stays grey; the square says which. */
	.row-status.is-held .row-status-dot {
		background: var(--muted);
		border-radius: 1px;
	}

	.row-status.is-held .row-status-text {
		color: var(--muted);
	}

	.row-status.is-failed .row-status-dot,
	.row-status.is-interrupted .row-status-dot {
		background: var(--danger);
	}

	.row-status.is-failed .row-status-text,
	.row-status.is-interrupted .row-status-text {
		color: var(--danger-text);
		font-weight: 600;
	}

	.row-status .badge {
		margin-left: 2px;
		height: 16px;
		min-width: 16px;
		font-size: 10px;
		padding: 0 4px;
	}

	.unread-dot {
		grid-column: 4;
		grid-row: 1 / 3;
		align-self: center;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: var(--radius-full);
		/* Unread is the one place the mark's mustard marks the list: new, not working or selected. */
		background: var(--mustard);
		color: var(--on-mustard);
		font-size: 10px;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.badge {
		background: var(--warn);
		color: var(--on-warn);
		border-radius: var(--radius-full);
		font-size: 10px;
		font-weight: 700;
		min-width: 18px;
		height: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 5px;
		grid-column: 2;
		box-shadow: 0 1px 3px color-mix(in srgb, var(--warn) 30%, transparent);
	}

	/* Kept global: `.row` is the sidebar session row, but the context menu is what opens it. */
	.row.is-context-open {
		background: var(--line-subtle);
	}

	@media (max-width: 680px) {
		/*
		 * The roster reads like a messenger here: portrait, then the name with the time of the
		 * last thing said, then that message with the unread count beside it. No card behind the
		 * row — a hairline that starts where the text starts, so the eye follows one column.
		 */
		.row {
			grid-template-columns: 48px minmax(0, 1fr) auto;
			gap: 3px 12px;
			align-items: center;
			padding: 10px 14px;
			margin: 0;
			border: 0;
			border-radius: 0;
			position: relative;
		}

		:global(.row) + .row::before {
			content: '';
			position: absolute;
			left: 74px;
			right: 0;
			top: 0;
			height: 1px;
			background: var(--line-subtle);
		}

		.row :global(.row-avatar) {
			--avatar-size: 48px;
			grid-row: 1 / 3;
			align-self: center;
		}

		.row .t {
			font-size: 16px;
			font-weight: 600;
			grid-column: 2;
			grid-row: 1;
		}

		.row-time {
			font-size: 12px;
		}

		.row :global(.s) {
			grid-column: 2;
			grid-row: 2;
			font-size: 13px;
			line-height: 1.35;
		}

		.row-status {
			grid-column: 2;
			font-size: 13px;
		}

		.unread-dot {
			grid-column: 3;
			grid-row: 2;
			justify-self: end;
			align-self: center;
			min-width: 18px;
			height: 18px;
			padding: 0 5px;
			font-size: 11px;
		}

		/* Tapping a row leaves the list, so the selected one only needs a tint, not a frame. */
		.row.is-on {
			background: var(--accent-tint);
			border-color: transparent;
			box-shadow: none;
		}
	}
</style>
