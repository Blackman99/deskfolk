<script lang="ts">
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import Icon from '../Icon.svelte';
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
		/** A press that may become a drag into the workbench: only where there is one. */
		onPointerDown?: (e: PointerEvent) => void;
		/** Whether the row is pinned; with `onTogglePin`, the row offers pin and ⋯ under the pointer. */
		pinned?: boolean;
		onTogglePin?: () => void;
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
		onContextMenu,
		onPointerDown,
		pinned = false,
		onTogglePin
	}: Props = $props();
</script>

<!--
	Under the pointer a row offers its two most used actions without a right-click: pin, and ⋯ for
	the rest of its menu (archiving a direct archives its Bot, so that stays one step further away).
	They sit beside the row's button, never inside it: a button in a button is not a button.
-->
<div class="row-shell" class:has-actions={Boolean(onTogglePin)}>

<button
	type="button"
	class="row{archived ? ' is-archived-row opacity-85' : ''}"
	class:is-on={on}
	class:is-context-open={contextOpen}
	class:is-unread={unread > 0}
	onclick={onSelect}
	oncontextmenu={onContextMenu}
	onpointerdown={onPointerDown}
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
{#if onTogglePin}
	<div class="row-actions">
		<button
			type="button"
			class="row-act"
			class:is-on={pinned}
			aria-pressed={pinned}
			title={pinned ? t.sidebar.unpin : t.sidebar.pin}
			aria-label={pinned ? t.sidebar.unpin : t.sidebar.pin}
			onclick={onTogglePin}
		>
			<Icon name="pin" size={14} />
		</button>
		<button
			type="button"
			class="row-act"
			title={t.chat.moreActions}
			aria-label={t.chat.moreActions}
			onclick={onContextMenu}
		>
			<Icon name="more" size={14} />
		</button>
	</div>
{/if}
</div>


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
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.row:hover {
		background: var(--row-hover);
	}

	/* A pressed row gives a little, so a click reads as landing. */
	.row:active {
		transform: scale(0.985);
		transition-duration: var(--dur-fast);
	}

	/*
	 * The open conversation is lifted off the list: the pane's own white with a hairline and a soft
	 * shadow, as if it were the card the pane on the right is showing. Shape, not colour, says which.
	 */
	.row.is-on,
	.row.is-on:hover {
		background: var(--pane);
		border-color: var(--line);
		box-shadow: var(--shadow-sm);
	}

	/* Ring colors according to active / hover / container contexts */
	.row :global(.row-avatar) {
		--avatar-ring: var(--sidebar-bg);
	}

	.row:hover :global(.row-avatar) {
		--avatar-ring: var(--sidebar-bg);
	}

	.row.is-on :global(.row-avatar) {
		--avatar-ring: var(--pane);
	}

	.row-shell {
		position: relative;
	}

	.row-actions {
		position: absolute;
		top: 50%;
		right: 8px;
		display: flex;
		gap: 2px;
		padding: 2px;
		border-radius: 9px;
		background: var(--pane);
		box-shadow: inset 0 0 0 1px var(--line), var(--shadow-md);
		opacity: 0;
		transform: translate(4px, -50%);
		pointer-events: none;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: opacity, transform;
	}

	.row-act {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 7px;
		color: var(--muted);
		transition-duration: var(--dur-fast);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.row-act:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.row-act:active {
		transform: scale(0.9);
	}

	.row-act.is-on {
		color: var(--accent);
	}

	.row-act:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.row-time,
	.unread-dot {
		transition: opacity var(--dur-base) var(--ease-out);
	}

	/* Only where there is a pointer to hover with; a phone keeps its long-press menu. */
	@media (hover: hover) and (min-width: 681px) {
		.row-shell.has-actions:hover .row-actions,
		.row-shell.has-actions:focus-within .row-actions {
			opacity: 1;
			transform: translate(0, -50%);
			pointer-events: auto;
		}

		.row-shell.has-actions:hover .row-time,
		.row-shell.has-actions:hover .unread-dot,
		.row-shell.has-actions:focus-within .row-time,
		.row-shell.has-actions:focus-within .unread-dot {
			opacity: 0;
		}
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

		:global(.row-flip + .row-flip) .row::before {
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
