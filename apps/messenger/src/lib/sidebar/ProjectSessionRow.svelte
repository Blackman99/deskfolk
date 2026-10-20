<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { unreadBadge } from './unread.ts';

	/**
	 * One project session under its directory (ADR 0095): its name and time, a pulse while the agent
	 * is at work in it, and the unread count. No avatar: it has no Bot, and the directory row says where.
	 */
	type Props = {
		t: Copy;
		/** The open conversation. */
		on: boolean;
		/** The row the context menu belongs to. */
		contextOpen: boolean;
		title: string;
		time: string;
		/** The agent is running or waiting on you in it. */
		live: boolean;
		unread: number;
		onSelect: () => void;
		onContextMenu: (e: MouseEvent) => void;
		/** A press that may become a drag into the workbench: only where there is one. */
		onPointerDown?: (e: PointerEvent) => void;
	};

	let { t, on, contextOpen, title, time, live, unread, onSelect, onContextMenu, onPointerDown }: Props = $props();
</script>

<button
	type="button"
	class="project-row"
	class:is-on={on}
	class:is-context-open={contextOpen}
	class:is-unread={unread > 0}
	data-project-session
	onclick={onSelect}
	oncontextmenu={onContextMenu}
	onpointerdown={onPointerDown}
>
	<span class="pulse-slot">
		{#if live}<span class="project-pulse" title={t.project.live} role="img" aria-label={t.project.live}></span>{/if}
	</span>
	<span class="name">{title}</span>
	<span class="time">{time}</span>
	{#if unread > 0}
		<span class="unread-dot" title={t.sidebar.unread}>{unreadBadge(unread)}</span>
	{/if}
</button>

<style>
	.project-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 34px;
		padding: 5px 10px 5px 8px;
		margin: 1px 0;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: inherit;
		text-align: left;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.project-row:hover {
		background: var(--row-hover);
	}

	/* The open one is lifted the way the other rows' is. */
	.project-row.is-on,
	.project-row.is-on:hover {
		background: var(--pane);
		border-color: var(--line);
		box-shadow: var(--shadow-sm);
	}

	.pulse-slot {
		flex: 0 0 8px;
		display: inline-flex;
		justify-content: center;
	}

	.project-pulse {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		animation: project-pulse 1.4s ease-in-out infinite;
	}

	@keyframes project-pulse {
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.project-pulse {
			animation: none;
		}
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
	}

	.project-row.is-unread .name {
		font-weight: 750;
	}

	.time {
		flex: none;
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
	}

	.unread-dot {
		flex: none;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 9px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
	}

	@media (max-width: 680px) {
		.project-row {
			min-height: 44px;
		}
	}
</style>
