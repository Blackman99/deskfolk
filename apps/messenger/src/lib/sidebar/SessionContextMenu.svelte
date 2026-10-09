<script lang="ts">
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { TraceViewKind } from '../overlays/trace-view.ts';
	import { computeContextMenuPosition, deriveSessionContextMenu } from './session-context-menu.ts';

	let {
		session,
		botsById,
		isPinned,
		x,
		y,
		t,
		onClose,
		onTogglePin,
		onViewInfo,
		onClearHistory,
		onToggleArchive,
		onDelete,
		onShowJobView
	}: {
		session: SessionSummary;
		botsById: ReadonlyMap<string, Bot>;
		isPinned: boolean;
		x: number;
		y: number;
		t: Copy;
		onClose: () => void;
		onTogglePin: () => void;
		onViewInfo: () => void;
		onClearHistory: () => void;
		onToggleArchive: () => void;
		onDelete: () => void;
		/** Open one view of the conversation's latest job, each a tab of its own on a wide window. */
		onShowJobView?: (view: TraceViewKind) => void;
	} = $props();

	const JOB_VIEWS: readonly TraceViewKind[] = ['trace', 'board', 'spec'];
	const jobViewLabel = $derived<Record<TraceViewKind, string>>({
		trace: t.plan.segmentTrace,
		board: t.plan.segmentBoard,
		spec: t.plan.segmentSpec
	});

	let menuEl = $state<HTMLElement | null>(null);
	let adjustedPos = $state<{ x: number; y: number } | null>(null);
	const pos = $derived(adjustedPos ?? { x, y });

	const data = $derived(deriveSessionContextMenu(session, isPinned, botsById));

	$effect(() => {
		if (menuEl) {
			const rect = menuEl.getBoundingClientRect();
			adjustedPos = computeContextMenuPosition(
				x,
				y,
				rect.width,
				rect.height,
				window.innerWidth,
				window.innerHeight,
				8
			);
		} else {
			adjustedPos = null;
		}
	});

	$effect(() => {
		let cleanup: (() => void) | null = null;
		const timer = setTimeout(() => {
			function onPointerDown(e: PointerEvent) {
				if (menuEl && !menuEl.contains(e.target as Node)) {
					onClose();
				}
			}

			function onKeyDown(e: KeyboardEvent) {
				if (e.key === 'Escape') {
					e.preventDefault();
					onClose();
				}
			}

			function onScroll(e: Event) {
				if (menuEl && menuEl.contains(e.target as Node)) return;
				onClose();
			}

			window.addEventListener('pointerdown', onPointerDown);
			window.addEventListener('keydown', onKeyDown);
			window.addEventListener('scroll', onScroll, true);

			cleanup = () => {
				window.removeEventListener('pointerdown', onPointerDown);
				window.removeEventListener('keydown', onKeyDown);
				window.removeEventListener('scroll', onScroll, true);
			};
		}, 10);

		return () => {
			clearTimeout(timer);
			cleanup?.();
		};
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={menuEl}
	class="session-context-menu"
	style="left: {pos.x}px; top: {pos.y}px;"
	role="menu"
	tabindex="-1"
	oncontextmenu={(e) => {
		e.preventDefault();
		e.stopPropagation();
	}}
	onclick={(e) => e.stopPropagation()}
	onpointerdown={(e) => e.stopPropagation()}
>
	<button
		type="button"
		class="session-context-menu-item"
		role="menuitem"
		onclick={() => {
			onTogglePin();
			onClose();
		}}
	>
		{#if data.isPinned}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="12" y1="17" x2="12" y2="22"></line>
				<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
			</svg>
			<span>{t.sidebar.unpin}</span>
		{:else}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="12" y1="17" x2="12" y2="22"></line>
				<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
			</svg>
			<span>{t.sidebar.pin}</span>
		{/if}
	</button>

	{#if data.canViewInfo}
	<button
		type="button"
		class="session-context-menu-item"
		role="menuitem"
		onclick={() => {
			onViewInfo();
			onClose();
		}}
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="12" cy="12" r="10"></circle>
			<line x1="12" y1="16" x2="12" y2="12"></line>
			<line x1="12" y1="8" x2="12.01" y2="8"></line>
		</svg>
		<span>{t.sidebar.viewInfo}</span>
	</button>
	{/if}

	{#if data.canShowJob && onShowJobView}
		<div class="session-context-menu-divider h-[1px] bg-line-subtle my-[3px] mx-2" role="separator"></div>
		{#each JOB_VIEWS as view (view)}
			<button
				type="button"
				class="session-context-menu-item"
				role="menuitem"
				data-job-view={view}
				onclick={() => {
					onShowJobView(view);
					onClose();
				}}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					{#if view === 'board'}
						<rect x="3" y="3" width="5" height="18" rx="1"></rect>
						<rect x="10" y="3" width="5" height="12" rx="1"></rect>
						<rect x="17" y="3" width="4" height="8" rx="1"></rect>
					{:else if view === 'spec'}
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
						<polyline points="14 2 14 8 20 8"></polyline>
						<line x1="16" y1="13" x2="8" y2="13"></line>
						<line x1="16" y1="17" x2="8" y2="17"></line>
					{:else}
						<rect x="8" y="2" width="8" height="6" rx="1.5"></rect>
						<path d="M12 8v3"></path>
						<path d="M5.5 14v-3h13v3"></path>
						<rect x="2" y="14" width="7" height="6" rx="1.5"></rect>
						<rect x="15" y="14" width="7" height="6" rx="1.5"></rect>
					{/if}
				</svg>
				<span>{jobViewLabel[view]}</span>
			</button>
		{/each}
	{/if}

	<div class="session-context-menu-divider h-[1px] bg-line-subtle my-[3px] mx-2" role="separator"></div>

	<button
		type="button"
		class="session-context-menu-item"
		role="menuitem"
		onclick={() => {
			onClearHistory();
			onClose();
		}}
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="1 4 1 10 7 10"></polyline>
			<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
		</svg>
		<span>{t.sidebar.clearHistory}</span>
	</button>

	<button
		type="button"
		class="session-context-menu-item"
		role="menuitem"
		disabled={!data.archive.enabled}
		onclick={() => {
			if (data.archive.enabled) {
				onToggleArchive();
				onClose();
			}
		}}
	>
		{#if data.archive.isArchived}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="1 4 1 10 7 10"></polyline>
				<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
			</svg>
			<span>{t.sidebar.unarchive}</span>
		{:else}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="21 8 21 21 3 21 3 8"></polyline>
				<rect x="1" y="3" width="22" height="5"></rect>
				<line x1="10" y1="12" x2="14" y2="12"></line>
			</svg>
			<span>{t.sidebar.archive}</span>
		{/if}
	</button>

	<div class="session-context-menu-divider h-[1px] bg-line-subtle my-[3px] mx-2" role="separator"></div>

	<button
		type="button"
		class="session-context-menu-item is-danger"
		role="menuitem"
		disabled={!data.delete.enabled}
		onclick={() => {
			if (data.delete.enabled) {
				onDelete();
				onClose();
			}
		}}
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="3 6 5 6 21 6"></polyline>
			<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
		</svg>
		<span>{t.sidebar.delete}</span>
	</button>
</div>

<style>
	.session-context-menu {
		position: fixed;
		z-index: 1000;
		min-width: 168px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-menu);
		padding: 5px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		user-select: none;
		animation: context-menu-in 0.12s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.session-context-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		box-sizing: border-box;
		padding: 6px 10px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		text-align: left;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.session-context-menu-item svg {
		flex-shrink: 0;
		opacity: 0.75;
		transition: opacity 0.12s ease;
	}

	.session-context-menu-item:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.session-context-menu-item:hover:not(:disabled) svg {
		opacity: 1;
		stroke: var(--accent);
	}

	.session-context-menu-item.is-danger:hover:not(:disabled) {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.session-context-menu-item.is-danger:hover:not(:disabled) svg {
		opacity: 1;
		stroke: var(--danger);
	}

	.session-context-menu-item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@keyframes context-menu-in {
		from {
		opacity: 0;
		transform: scale(0.96) translateY(-4px);
		}
		to {
		opacity: 1;
		transform: scale(1) translateY(0);
		}
	}
</style>
