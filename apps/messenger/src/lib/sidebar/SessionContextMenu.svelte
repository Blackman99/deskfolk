<script lang="ts">
	import Icon from '../Icon.svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import BottomSheet from '../BottomSheet.svelte';
	import { PHONE_SHEET_QUERY } from '../bottom-sheet.ts';
	import type { Copy } from '../copy.ts';
	import { computeContextMenuPosition, deriveSessionContextMenu } from './session-context-menu.ts';
	import { sessionTitle } from './session-title.ts';

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
		/** Open the conversation's latest job: its one flow tab on a wide window, its page on a phone. */
		onShowJobView?: () => void;
	} = $props();


	let menuEl = $state<HTMLElement | null>(null);
	let adjustedPos = $state<{ x: number; y: number } | null>(null);
	const pos = $derived(adjustedPos ?? { x, y });

	const data = $derived(deriveSessionContextMenu(session, isPinned, botsById));
	/**
	 * A long press on a phone opens it as a sheet from the bottom (`BottomSheet`), named after the
	 * conversation, rather than a menu where the finger was. The sheet closes itself.
	 */
	const phone = new MediaQuery(PHONE_SHEET_QUERY);
	const title = $derived(sessionTitle(session, botsById, { deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop }));

	$effect(() => {
		if (menuEl && !phone.current) {
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
		if (phone.current) return;
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

{#snippet items(inSheet: boolean)}
	<button
		type="button"
		class={['session-context-menu-item', { 'sheet-item': inSheet }]}
		role="menuitem"
		onclick={() => {
			onTogglePin();
			onClose();
		}}
	>
		{#if data.isPinned}
			<Icon name="pin" filled />
			<span>{t.sidebar.unpin}</span>
		{:else}
			<Icon name="pin" />
			<span>{t.sidebar.pin}</span>
		{/if}
	</button>

	{#if data.canViewInfo}
	<button
		type="button"
		class={['session-context-menu-item', { 'sheet-item': inSheet }]}
		role="menuitem"
		onclick={() => {
			onViewInfo();
			onClose();
		}}
	>
		<Icon name="info" />
		<span>{t.sidebar.viewInfo}</span>
	</button>
	{/if}

	{#if data.canShowJob && onShowJobView}
		<div class={inSheet ? 'sheet-separator' : 'session-context-menu-divider h-[1px] bg-line-subtle my-[3px] mx-2'} role="separator"></div>
		<!-- The latest job's one tab: its tickets, flow and spec (ADR 0086). -->
		<button
			type="button"
			class={['session-context-menu-item', { 'sheet-item': inSheet }]}
			role="menuitem"
			data-job-view="trace"
			onclick={() => {
				onShowJobView();
				onClose();
			}}
		>
			<Icon name="hierarchy" />
			<span>{t.plan.segmentTrace}</span>
		</button>
	{/if}

	<div class={inSheet ? 'sheet-separator' : 'session-context-menu-divider h-[1px] bg-line-subtle my-[3px] mx-2'} role="separator"></div>

	<button
		type="button"
		class={['session-context-menu-item', { 'sheet-item': inSheet }]}
		role="menuitem"
		onclick={() => {
			onClearHistory();
			onClose();
		}}
	>
		<Icon name="rotate-ccw" />
		<span>{t.sidebar.clearHistory}</span>
	</button>

	<button
		type="button"
		class={['session-context-menu-item', { 'sheet-item': inSheet }]}
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
			<Icon name="rotate-ccw" />
			<span>{t.sidebar.unarchive}</span>
		{:else}
			<Icon name="archive" />
			<span>{t.sidebar.archive}</span>
		{/if}
	</button>

	<div class={inSheet ? 'sheet-separator' : 'session-context-menu-divider h-[1px] bg-line-subtle my-[3px] mx-2'} role="separator"></div>

	<button
		type="button"
		class={['session-context-menu-item', 'is-danger', { 'sheet-item': inSheet }]}
		role="menuitem"
		disabled={!data.delete.enabled}
		onclick={() => {
			if (data.delete.enabled) {
				onDelete();
				onClose();
			}
		}}
	>
		<Icon name="trash" />
		<span>{t.sidebar.delete}</span>
	</button>
{/snippet}

{#if phone.current}
	<BottomSheet {title} closeLabel={t.common.close} onClose={onClose}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="session-context-sheet"
			role="menu"
			tabindex="-1"
			aria-label={title}
			oncontextmenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
			onclick={(e) => e.stopPropagation()}
			onpointerdown={(e) => e.stopPropagation()}
		>
			{@render items(true)}
		</div>
	</BottomSheet>
{:else}
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
		{@render items(false)}
	</div>
{/if}

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
		animation: menuIn var(--dur-base) var(--ease-out);
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

	.session-context-menu-item :global(.icon) {
		flex-shrink: 0;
		opacity: 0.75;
		transition: opacity 0.12s ease;
	}

	.session-context-menu-item:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.session-context-menu-item:hover:not(:disabled) :global(.icon) {
		opacity: 1;
		stroke: var(--accent);
	}

	.session-context-menu-item.is-danger:hover:not(:disabled) {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.session-context-menu-item.is-danger:hover:not(:disabled) :global(.icon) {
		opacity: 1;
		stroke: var(--danger);
	}

	.session-context-menu-item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

</style>
