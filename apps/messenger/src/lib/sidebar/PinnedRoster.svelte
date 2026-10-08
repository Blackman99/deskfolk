<script lang="ts">
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { isFileDropSession } from './session-groups.ts';
	import type { SessionStatusResult } from './session-status.ts';
	import { unreadBadge } from './unread.ts';

	/**
	 * The pinned conversations, as a band above the list. Nothing pinned is not news worth the top
	 * of the sidebar: the sidebar only mounts it once something is.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		pinnedSessions: SessionSummary[];
		/** Marks the pin the context menu belongs to. */
		contextMenuSessionId: string | null;
		onOpenContextMenu: (e: MouseEvent, session: SessionSummary) => void;
		botsById: ReadonlyMap<string, Bot>;
		botStatusOf: (botId: string) => SessionStatusResult | undefined;
		statusOf: (session: SessionSummary) => SessionStatusResult;
		unreadOf: (session: SessionSummary) => number;
		titleOf: (session: SessionSummary) => string;
		archivedSuffix: (session: SessionSummary) => string;
	};

	let {
		runtime,
		t,
		pinnedSessions,
		contextMenuSessionId,
		onOpenContextMenu,
		botsById,
		botStatusOf,
		statusOf,
		unreadOf,
		titleOf,
		archivedSuffix
	}: Props = $props();

	let pinnedExpanded = $state(false);
</script>

<div class="roster-panel">
	<div class="roster" class:is-expanded={pinnedExpanded} title={t.sidebar.pinned}>
			{#each pinnedSessions as pSession (pSession.id)}
				{@const pStatus = statusOf(pSession)}
				{@const pUnread = unreadOf(pSession)}
				<button
					type="button"
					title="{titleOf(pSession)}{archivedSuffix(pSession)}"
					class="pinned-session-btn"
					class:is-active={runtime.selectedId === pSession.id}
					class:is-context-open={contextMenuSessionId === pSession.id}
					class:is-run={pStatus.isBusy}
					class:is-unread={pUnread > 0}
					onclick={() => void runtime.selectSession(pSession.id)}
					oncontextmenu={(e) => onOpenContextMenu(e, pSession)}
				>
					<span class="pinned-avatar-wrap relative flex items-center justify-center w-17 h-17 shrink-0">
						{#if isFileDropSession(pSession)}
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
							<SessionAvatar session={pSession} bots={botsById} botStatus={botStatusOf} />
						{/if}
						{#if pStatus.count}
							<span class="pinned-badge">{pStatus.count}</span>
						{:else if pUnread > 0}
							<span class="pinned-unread" title={t.sidebar.unread}>{unreadBadge(pUnread)}</span>
						{/if}
					</span>
					<span class="pinned-session-name text-11 font-medium text-ink leading-[1.2] w-full max-w-27 overflow-hidden text-ellipsis whitespace-nowrap text-center block select-none">{titleOf(pSession)}</span>
				</button>
			{/each}
	</div>
	{#if pinnedSessions.length > 5}
		<button
			type="button"
			class="pinned-expand-btn"
			title={pinnedExpanded ? t.sidebar.collapse : t.sidebar.expand}
			onclick={() => (pinnedExpanded = !pinnedExpanded)}
		>
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class:is-rotated={pinnedExpanded}
			>
				<polyline points="6 9 12 15 18 9"></polyline>
			</svg>
		</button>
	{/if}
</div>

<style>
	.pinned-session-btn.is-context-open {
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.pinned-session-btn :global(img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
		display: block;
	}

	.file-drop-mark {
		background: var(--accent-tint);
		color: var(--accent);
		border-color: transparent;
	}

	/* Pinned Bar / Roster Row (Top of Sidebar) */
	.roster-panel {
		position: relative;
		display: flex;
		align-items: center;
		border-bottom: 1px solid var(--line);
		background: var(--glass-sidebar-header);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
	}

	.roster {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 8px 10px;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
		scrollbar-color: var(--line-hover) transparent;
		min-height: 72px;
		flex: 1;
		min-width: 0;
		transition: 0.2s ease;
		transition-property: max-height, gap;
	}

	.roster::-webkit-scrollbar {
		height: 4px;
	}

	.roster::-webkit-scrollbar-thumb {
		background: var(--line-hover);
		border-radius: var(--radius-xs);
	}

	.roster.is-expanded {
		flex-wrap: wrap;
		overflow-x: hidden;
		overflow-y: auto;
		max-height: 200px;
		gap: 8px 6px;
	}

	.pinned-expand-btn {
		width: 28px;
		height: 28px;
		margin-right: 10px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--muted);
		box-shadow: var(--shadow-xs);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.pinned-expand-btn:hover {
		color: var(--ink);
		border-color: var(--line-hover);
		background: var(--line-subtle);
	}

	.pinned-expand-btn :global(svg.is-rotated) {
		transform: rotate(180deg);
	}

	.pinned-session-btn {
		width: 58px;
		height: 60px;
		border-radius: var(--radius-md);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 3px;
		position: relative;
		flex: 0 0 58px;
		box-shadow: var(--shadow-xs);
		transition: 0.16s cubic-bezier(0.16, 1, 0.3, 1);
		transition-property: var(--transition-props);
		padding: 4px 2px 2px;
		cursor: pointer;
		box-sizing: border-box;
	}

	.pinned-session-btn:hover {
		transform: translateY(-1px);
		border-color: var(--line-hover);
		box-shadow: var(--shadow-sm);
		background: var(--btn-secondary-hover);
	}

	.pinned-session-btn:active {
		transform: translateY(0);
	}

	.pinned-session-btn.is-active {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-tint);
		background: var(--accent-tint);
	}

	.pinned-session-btn.is-run {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--sidebar-bg), 0 0 0 4px var(--accent);
		color: var(--accent);
	}

	.pinned-avatar-wrap :global(.row-avatar),
	.pinned-avatar-wrap :global(.row-avatar.size-md) {
		--avatar-size: 34px;
	}

	.pinned-session-btn.is-run .pinned-avatar-wrap::after {
		content: "";
		position: absolute;
		top: -2px;
		right: -2px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--ok);
		border: 2px solid var(--sidebar-bg);
		box-shadow: 0 0 6px var(--ok);
		animation: pulse-dot 1.4s ease-in-out infinite;
		z-index: 2;
	}

	.pinned-session-btn.is-active .pinned-session-name {
		color: var(--accent);
		font-weight: 600;
	}

	.pinned-badge {
		position: absolute;
		top: -4px;
		right: -4px;
		background: var(--warn);
		color: var(--on-warn);
		font-size: 10px;
		font-weight: 700;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: var(--radius-md);
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1.5px solid var(--sidebar-bg);
		z-index: 2;
	}

	.pinned-session-btn :global(.row-avatar) {
		--avatar-ring: var(--btn-secondary-bg);
	}

	.pinned-session-btn:hover :global(.row-avatar) {
		--avatar-ring: var(--btn-secondary-hover);
	}

	.pinned-session-btn.is-active :global(.row-avatar) {
		--avatar-ring: var(--accent-tint);
	}

	.pinned-session-btn.is-active :global(.row-avatar) :global(.slot-overflow) {
		background: var(--accent);
		color: var(--on-accent);
		border-color: var(--accent);
	}

	.pinned-unread {
		position: absolute;
		top: -5px;
		right: -5px;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: var(--radius-md);
		background: var(--mustard);
		color: var(--on-mustard);
		font-size: 10px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1.5px solid var(--sidebar-bg);
	}

	.pinned-session-btn.is-unread:not(.is-run) {
		border-color: var(--accent-border);
	}

	@keyframes pulse-dot {
		0%,
		100% {
		opacity: 1;
		transform: scale(1);
		}
		50% {
		opacity: 0.6;
		transform: scale(1.15);
		}
	}
</style>
