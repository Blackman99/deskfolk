<script lang="ts">
	import { tick } from 'svelte';
	import { formatDateDivider, formatMessageTime } from './chat-view.ts';
	import type { IndexMark } from './message-index.ts';

	type Props = {
		marks: readonly IndexMark[];
		activeId: string | null;
		locale: 'zh' | 'en';
		label: string;
		emptyLabel: string;
		sender: (mark: IndexMark) => string;
		hasEarlier?: boolean;
		loading?: boolean;
		earlierLabel?: string;
		onLoadEarlier?: () => void;
		onJump: (mark: IndexMark) => void;
	};
	let { marks, activeId, locale, label, emptyLabel, sender, hasEarlier = false,
		loading = false, earlierLabel = '', onLoadEarlier, onJump }: Props = $props();
	let root = $state<HTMLElement | null>(null);
	let list = $state<HTMLElement | null>(null);
	let previewId = $state<string | null>(null);
	let previewTop = $state(0);
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	const preview = $derived(marks.find((mark) => mark.id === previewId));
	const previewIndex = $derived(marks.findIndex((mark) => mark.id === previewId));

	function close(): void {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
		previewId = null;
	}

	$effect(() => () => close());

	$effect(() => {
		const id = activeId;
		const container = list;
		if (!id || !container) return;
		void tick().then(() => {
			if (previewId || !container.isConnected) return;
			const button = container.querySelector<HTMLElement>(`[data-index-id="${CSS.escape(id)}"]`);
			if (!button) return;
			const top = button.offsetTop;
			if (top < container.scrollTop) container.scrollTop = top;
			else if (top + button.offsetHeight > container.scrollTop + container.clientHeight) {
				container.scrollTop = top + button.offsetHeight - container.clientHeight;
			}
		});
	});

	function show(mark: IndexMark, button: HTMLElement, immediate = false): void {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
		const reveal = () => {
			if (!root || !button.isConnected) return;
			const stage = root.parentElement!.getBoundingClientRect();
			const rect = root.getBoundingClientRect();
			const anchor = button.getBoundingClientRect();
			previewTop = Math.max(stage.top + 80, Math.min(stage.bottom - 80, anchor.top + anchor.height / 2)) - rect.top;
			previewId = mark.id;
		};
		if (immediate || previewId) reveal();
		else openTimer = setTimeout(reveal, 120);
	}

	function leave(): void {
		clearTimeout(openTimer);
		closeTimer = setTimeout(close, 160);
	}

	function jump(mark: IndexMark): void {
		onJump(mark);
		close();
	}

	function keydown(event: KeyboardEvent, index: number): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}
		const target = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1
			: event.key === 'Home' ? 0 : event.key === 'End' ? marks.length - 1 : null;
		if (target === null) return;
		event.preventDefault();
		const buttons = list?.querySelectorAll<HTMLButtonElement>('[data-index-id]');
		buttons?.[Math.max(0, Math.min(marks.length - 1, target))]?.focus();
	}
</script>

<nav class="message-index" bind:this={root} aria-label={label}>
	{#if hasEarlier}
		<button class="index-earlier" title={earlierLabel} aria-label={earlierLabel}
			disabled={loading} onclick={onLoadEarlier}>{loading ? '⋯' : '↑'}</button>
	{/if}
	<div class="message-index-list" bind:this={list} onscroll={close}>
		{#each marks as mark, index (mark.id)}
			<button class="index-entry" data-index-id={mark.id}
				aria-label={`${sender(mark)} · ${mark.preview || emptyLabel}`}
				aria-current={mark.id === activeId ? 'location' : undefined}
				class:is-active={mark.id === activeId}
				class:is-preview={mark.id === previewId}
				style:--proximity={previewIndex < 0 ? 0 : Math.max(0, 3 - Math.abs(index - previewIndex))}
				onpointerenter={(event) => show(mark, event.currentTarget)}
				onpointerleave={leave}
				onfocus={(event) => show(mark, event.currentTarget, true)}
				onblur={leave}
				onkeydown={(event) => keydown(event, index)}
				onclick={() => jump(mark)}>
				<span class="message-index-mark" aria-hidden="true"></span>
			</button>
		{/each}
	</div>
	{#if preview}
		<button class="message-index-card" style:top="{previewTop}px"
			onpointerenter={() => clearTimeout(closeTimer)} onpointerleave={leave}
			onfocus={() => clearTimeout(closeTimer)} onblur={leave}
			onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
			onclick={() => jump(preview)}>
			<span class="index-preview-body">{preview.preview || emptyLabel}</span>
			<span class="index-preview-meta"><strong>{sender(preview)}</strong>
				<span>{formatDateDivider(preview.created_at, locale)} {formatMessageTime(preview.created_at)}</span>
				<span>{previewIndex + 1} / {marks.length}</span>
			</span>
		</button>
	{/if}
</nav>

<style>
	.message-index {
		position: absolute;
		z-index: 6;
		left: 6px;
		top: 50%;
		transform: translateY(-50%);
		width: 28px;
		max-height: min(360px, calc(100% - var(--composer-height, 140px) - 48px));
		display: flex;
		flex-direction: column;
	}
	.message-index-list {
		position: relative;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: none;
		padding: 4px 0;
	}
	.message-index-list::-webkit-scrollbar { display: none; }
	.index-entry, .index-earlier {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 10px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}
	.index-earlier { height: 24px; flex-shrink: 0; color: var(--muted); font-size: 12px; }
	.message-index-mark {
		width: calc(6px + var(--proximity, 0) * 3px);
		height: 2px;
		border-radius: 2px;
		background: var(--muted-light);
		transition: width 100ms ease, background 100ms ease;
		pointer-events: none;
	}
	.is-active .message-index-mark { background: var(--ink-secondary); width: 12px; }
	.is-preview .message-index-mark, .index-entry:focus-visible .message-index-mark {
		width: 18px;
		height: 4px;
		background: var(--ink);
	}
	.index-entry:focus-visible, .index-earlier:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; border-radius: 3px; }
	.message-index-card {
		position: absolute;
		left: 100%;
		transform: translateY(-50%);
		width: min(320px, calc(100vw - 80px));
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-md);
		text-align: left;
		cursor: pointer;
	}
	.message-index-card:hover { border-color: var(--line-hover); }
	.message-index-card:focus-visible { outline: 2px solid var(--accent); }
	.index-preview-body {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		overflow: hidden;
		overflow-wrap: anywhere;
		font-size: 13px;
		line-height: 1.5;
	}
	.index-preview-meta { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 10px; color: var(--muted); }
	.index-preview-meta strong { max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
	.index-preview-meta span:last-child { margin-left: auto; white-space: nowrap; }
	@media (prefers-reduced-motion: reduce) { .message-index-mark { transition: none; } }
	@media (max-width: 680px) { .message-index { display: none; } }
</style>
