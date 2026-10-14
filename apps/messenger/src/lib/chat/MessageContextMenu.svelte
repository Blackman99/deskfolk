<script lang="ts">
	import Icon from '../Icon.svelte';
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
		lockedComposer = false,
		selectedText = null,
		onClose,
		onReply,
		onCopy,
		onOpenFileTree,
		onShowTrace,
		onCopyId,
		onReaction,
		onSelectText,
		onEdit,
		sheet = false
		}: {
		message: Message;
		x: number;
		y: number;
		t: Copy;
		lockedComposer?: boolean;
		selectedText?: string | null;
		onClose: () => void;
		onReply: () => void;
		onCopy: (text: string) => void;
		onOpenFileTree: (path: string | null) => void;
		/** Open the message's job on its card, the ticket it was filed under picked; or a line's own flow. */
		onShowTrace: () => void;
		onCopyId: () => void;
		onReaction: (emoji: string) => void;
		/** Present when this is a line of yours that can still be changed (ADR 0063). */
		onEdit?: () => void;
		/**
		 * Present when the menu came from a touch: the long-press that opened it could not select,
		 * so copying part of the message needs the text on a page of its own.
		 */
		onSelectText?: () => void;
		/**
		 * Opened by a touch: drawn as a sheet across the bottom, with emoji and rows a thumb can
		 * hit, instead of a small menu at the finger.
		 */
		sheet?: boolean;
	} = $props();

	let menuEl = $state<HTMLElement | null>(null);
	let adjustedPos = $state<{ x: number; y: number } | null>(null);
	const pos = $derived(adjustedPos ?? { x, y });

	const data = $derived(deriveMessageContextMenu(message, { lockedComposer }));

	const QUICK_EMOJIS = ['👍', '❤️', '🎉', '🚀', '👀'];

	$effect(() => {
		if (menuEl && !sheet) {
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

			const recordedScroll = new Map<EventTarget, { top: number; left: number }>();
			function getScroll(target: EventTarget) {
				if (target instanceof Element) {
					return { top: target.scrollTop, left: target.scrollLeft };
				}
				if (target instanceof Document || target === window) {
					return { top: window.scrollY, left: window.scrollX };
				}
				return null;
			}
			function recordTarget(target: EventTarget | null) {
				if (!target) return;
				const pos = getScroll(target);
				if (pos) recordedScroll.set(target, pos);
			}

			recordTarget(window);
			recordTarget(document);
			if (typeof document !== 'undefined' && document.scrollingElement) {
				recordTarget(document.scrollingElement);
			}
			if (typeof document !== 'undefined') {
				document.querySelectorAll('.stream').forEach((el) => recordTarget(el));
			}

			function onScroll(e: Event) {
				if (menuEl && menuEl.contains(e.target as Node)) return;
				const target = e.target;
				if (!target) {
					onClose();
					return;
				}
				const current = getScroll(target);
				if (!current) {
					onClose();
					return;
				}
				const initial = recordedScroll.get(target);
				if (!initial) {
					recordedScroll.set(target, current);
					return;
				}
				const deltaY = Math.abs(current.top - initial.top);
				const deltaX = Math.abs(current.left - initial.left);
				if (deltaY > 6 || deltaX > 6) {
					onClose();
				}
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

{#if sheet}
	<!-- Behind the sheet: a tap here lands outside the menu, which closes it. -->
	<div class="msg-sheet-scrim" aria-hidden="true"></div>
{/if}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={menuEl}
	class="msg-context-menu"
	class:is-sheet={sheet}
	style={sheet ? undefined : `left: ${pos.x}px; top: ${pos.y}px;`}
	role="menu"
	tabindex="-1"
	oncontextmenu={(e) => {
		e.preventDefault();
		e.stopPropagation();
	}}
	onclick={(e) => e.stopPropagation()}
	onpointerdown={(e) => e.stopPropagation()}
>
	{#if sheet}<span class="msg-sheet-grabber" aria-hidden="true"></span>{/if}
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
		<Icon name="reply" />
		<span>{t.chat.replyMessage}</span>
		</button>

		{#if onEdit}
			<button
				type="button"
				class="msg-context-menu-item"
				role="menuitem"
				onclick={() => {
					onEdit();
					onClose();
				}}
			>
				<Icon name="edit" />
				<span>{t.chat.editMessage}</span>
			</button>
		{/if}

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
		<Icon name="copy" />
		<span>{t.chat.copyMessage}</span>
	</button>

	{#if onSelectText && data.canCopy}
		<button
			type="button"
			class="msg-context-menu-item"
			role="menuitem"
			onclick={() => {
				onSelectText();
				onClose();
			}}
		>
			<Icon name="text-cursor" />
			<span>{t.chat.selectText}</span>
		</button>
	{/if}

	<button
		type="button"
		class="msg-context-menu-item"
		role="menuitem"
		disabled={!data.canOpenFileTree}
		onclick={() => {
			if (data.canOpenFileTree) {
				onOpenFileTree(data.targetPath);
				onClose();
			}
		}}
		title={!data.canOpenFileTree ? t.chat.noAssociatedFiles : (data.targetPath ?? '')}
	>
		<Icon name="folder" />
		<span>{t.chat.openAssociatedFileTree}</span>
	</button>

	{#if data.canShowTrace || data.canShowLine}
		<!-- The job this line is in, as one tab (ADR 0086), on this line's card; a line in no job has its own flow (ADR 0083). -->
		<button
			type="button"
			class="msg-context-menu-item"
			role="menuitem"
			data-job-view="trace"
			onclick={() => {
				onShowTrace();
				onClose();
			}}
		>
			<Icon name="hierarchy" />
			<span>{t.chat.jobView.trace}</span>
		</button>
	{/if}

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
		<Icon name="hash" />
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
		box-shadow: var(--shadow-menu);
		padding: 5px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		user-select: none;
		animation: menuIn var(--dur-base) var(--ease-out);
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

	.msg-context-menu-item :global(.icon) {
		flex-shrink: 0;
		opacity: 0.75;
		transition: opacity 0.12s ease;
	}

	.msg-context-menu-item:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.msg-context-menu-item:hover:not(:disabled) :global(.icon) {
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

	/* A touch's sheet: across the bottom, rows and emoji sized for a thumb. */
	.msg-sheet-scrim {
		position: fixed;
		inset: 0;
		z-index: 999;
		background: var(--modal-backdrop);
		animation: msg-sheet-fade var(--dur-base) ease-out;
	}

	.msg-context-menu.is-sheet {
		left: 0;
		right: 0;
		bottom: 0;
		top: auto;
		margin: 0 auto;
		min-width: 0;
		max-width: 560px;
		gap: 4px;
		padding: 8px 12px calc(14px + env(safe-area-inset-bottom, 0px));
		border-radius: 20px 20px 0 0;
		border-bottom: 0;
		box-shadow: var(--shadow-lg);
		animation: msg-sheet-up var(--dur-slow) var(--ease-out);
	}

	.msg-sheet-grabber {
		align-self: center;
		width: 36px;
		height: 5px;
		margin: 0 0 8px;
		border-radius: var(--radius-full);
		background: var(--line);
	}

	.is-sheet .msg-reaction-row {
		padding: 2px 2px 10px;
	}

	.is-sheet .msg-reaction-btn {
		width: 48px;
		height: 48px;
		font-size: 24px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
	}

	.is-sheet .msg-reaction-btn:active {
		transform: scale(0.92);
	}

	.is-sheet .msg-context-menu-item {
		min-height: 48px;
		gap: 14px;
		padding: 0 14px;
		font-size: 16px;
		border-radius: var(--radius-md);
	}

	.is-sheet .msg-context-menu-item :global(svg) {
		width: 20px;
		height: 20px;
	}

	.is-sheet .msg-context-menu-item:active:not(:disabled) {
		background: var(--row-hover);
	}

	@keyframes msg-sheet-up {
		from {
			transform: translateY(100%);
		}
		to {
			transform: none;
		}
	}

	@keyframes msg-sheet-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

</style>
