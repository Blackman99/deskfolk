<script lang="ts">
	import type { Message } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import {
		computeContextMenuPosition,
		deriveMessageContextMenu
	} from './message-context-menu.ts';

	let {
		message,
		x,
		y,
		t,
		hasWorkspace = true,
		lockedComposer = false,
		selectedText = null,
		onClose,
		onReply,
		onCopy,
		onOpenFileTree,
		onCopyId,
		onReaction
	}: {
		message: Message;
		x: number;
		y: number;
		t: Copy;
		hasWorkspace?: boolean;
		lockedComposer?: boolean;
		selectedText?: string | null;
		onClose: () => void;
		onReply: () => void;
		onCopy: (text: string) => void;
		onOpenFileTree: (path: string | null) => void;
		onCopyId: () => void;
		onReaction: (emoji: string) => void;
	} = $props();

	let menuEl = $state<HTMLElement | null>(null);
	let adjustedPos = $state<{ x: number; y: number } | null>(null);
	const pos = $derived(adjustedPos ?? { x, y });

	const data = $derived(deriveMessageContextMenu(message, { lockedComposer, hasWorkspace }));

	const QUICK_EMOJIS = ['👍', '❤️', '🎉', '🚀', '👀'];

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
	class="msg-context-menu"
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
	<div class="msg-reaction-row flex items-center justify-between px-1 py-[3px]">
		{#each QUICK_EMOJIS as emoji}
			<button
				type="button"
				class="msg-reaction-btn"
				title={emoji}
				onclick={() => {
					onReaction(emoji);
					onClose();
				}}
			>
				{emoji}
			</button>
		{/each}
	</div>

	<div class="msg-context-divider" role="separator"></div>

	<button
		type="button"
		class="msg-context-menu-item"
		role="menuitem"
		disabled={!data.canReply}
		onclick={() => {
			if (data.canReply) {
				onReply();
				onClose();
			}
		}}
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="9 17 4 12 9 7"></polyline>
			<path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
		</svg>
		<span>{t.chat.replyMessage}</span>
	</button>

	<button
		type="button"
		class="msg-context-menu-item"
		role="menuitem"
		disabled={!data.canCopy}
		onclick={() => {
			if (data.canCopy) {
				onCopy(selectedText || message.body);
				onClose();
			}
		}}
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
		</svg>
		<span>{t.chat.copyMessage}</span>
	</button>

	<button
		type="button"
		class="msg-context-menu-item"
		role="menuitem"
		disabled={!data.canOpenWorkspace}
		onclick={() => {
			if (data.canOpenWorkspace) {
				onOpenFileTree(data.targetPath);
				onClose();
			}
		}}
		title={!data.canOpenWorkspace ? t.chat.noAssociatedFiles : (data.targetPath ?? '')}
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
		</svg>
		<span>{t.chat.openAssociatedFileTree}</span>
	</button>

	{#if data.associatedFiles.length > 1}
		<div class="msg-context-sublist flex flex-col gap-[1px] pl-6 pr-1 pb-1">
			{#each data.associatedFiles.slice(0, 4) as file}
				<button
					type="button"
					class="msg-context-subitem"
					role="menuitem"
					onclick={() => {
						onOpenFileTree(file);
						onClose();
					}}
					title={file}
				>
					<span class="subitem-bullet">›</span>
					<span class="subitem-name overflow-hidden text-ellipsis whitespace-nowrap">{file}</span>
				</button>
			{/each}
		</div>
	{/if}

	<div class="msg-context-divider" role="separator"></div>

	<button
		type="button"
		class="msg-context-menu-item"
		role="menuitem"
		onclick={() => {
			onCopyId();
			onClose();
		}}
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<line x1="4" y1="9" x2="20" y2="9"></line>
			<line x1="4" y1="15" x2="20" y2="15"></line>
			<line x1="10" y1="3" x2="8" y2="21"></line>
			<line x1="16" y1="3" x2="14" y2="21"></line>
		</svg>
		<span>{t.chat.copyMessageId}</span>
	</button>
</div>

<style>
	.msg-context-menu {
		position: fixed;
		z-index: 1000;
		min-width: 172px;
		max-width: 260px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: 0 12px 30px -4px rgba(15, 23, 42, 0.16), 0 4px 12px -2px rgba(15, 23, 42, 0.08);
		padding: 5px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		user-select: none;
		animation: context-menu-in 0.12s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.msg-reaction-row {
		border-radius: var(--radius-sm);
	}

	.msg-reaction-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		font-size: 16px;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: transform 0.12s ease, background 0.12s ease;
	}

	.msg-reaction-btn:hover {
		background: var(--line-subtle);
		transform: scale(1.2);
	}

	.msg-context-divider {
		height: 1px;
		background: var(--line-subtle);
		margin: 3px 8px;
	}

	.msg-context-menu-item {
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

	.msg-context-menu-item svg {
		flex-shrink: 0;
		opacity: 0.75;
		transition: opacity 0.12s ease;
	}

	.msg-context-menu-item:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.msg-context-menu-item:hover:not(:disabled) svg {
		opacity: 1;
		stroke: var(--accent);
	}

	.msg-context-menu-item:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.msg-context-sublist {
		margin-top: -1px;
	}

	.msg-context-subitem {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 6px;
		font-size: 11px;
		color: var(--ink-secondary);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		text-align: left;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.msg-context-subitem:hover {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.subitem-bullet {
		font-weight: 700;
		opacity: 0.6;
	}

	@keyframes context-menu-in {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(-2px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}
</style>
