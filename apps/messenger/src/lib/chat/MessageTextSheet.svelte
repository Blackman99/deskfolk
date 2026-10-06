<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { holdBack } from './message-text-pages.ts';

	/**
	 * A message's text on a page of its own, to copy part of it. On a touch screen a long-press on
	 * a message opens its menu, so the bubble never selects and the menu's copy takes the message
	 * whole. Here nothing claims the press: the phone's own selection does the rest — the handles,
	 * then its Copy bar.
	 *
	 * Nothing on this page, or above it, may cancel `contextmenu`: Android shows that Copy bar
	 * through the event, so a cancelled one leaves a selection that cannot be copied. Nothing is
	 * selected for you either — a selection made by script gets no handles on Android, so it would
	 * be one you can see and not copy.
	 */
	let {
		t,
		subject,
		onClose,
		children
	}: {
		t: Copy;
		/** Whose line it is and when, under the title on a phone. */
		subject: string;
		onClose: () => void;
		/** The text, drawn as the conversation draws it. */
		children: Snippet;
	} = $props();

	const backdrop = backdropClick();
	let root = $state<HTMLElement | null>(null);

	onMount(() => {
		// The key listener is on the page itself, so it has to hold focus for Escape to close it.
		root?.focus({ preventScroll: true });
		// The page is in no URL: the phone's Back closes it and leaves the conversation open.
		return holdBack(() => onClose());
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={root}
	class="modal-backdrop page-on-phone"
	transition:pageSlide
	role="dialog"
	aria-modal="true"
	aria-labelledby="message-text-title"
	tabindex="-1"
	onmousedowncapture={backdrop.press}
	onclick={(event) => {
		if (backdrop.isOutside(event)) onClose();
	}}
	onkeydown={(event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onClose();
		}
	}}
>
	<div class="modal-dialog message-text-dialog">
		<div class="modal-head">
			<button type="button" class="modal-back" aria-label={t.common.back} onclick={onClose}>
				<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<div class="modal-head-titles">
				<h2 id="message-text-title">{t.chat.selectText}</h2>
				<span class="modal-head-subject"><span class="message-text-subject">{subject}</span></span>
			</div>
			<button type="button" class="modal-close" title={t.common.close} onclick={onClose}>✕</button>
		</div>
		<div class="modal-body message-text-body">
			<p class="message-text-hint">{t.chat.selectTextHint}</p>
			<div class="message-text">
				{@render children()}
			</div>
		</div>
	</div>
</div>

<style>
	.message-text-dialog {
		width: 560px;
		max-width: 92vw;
		max-height: min(720px, 88dvh);
		min-height: 0;
	}

	.message-text-body {
		gap: 10px;
	}

	.message-text-subject {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 500;
		line-height: 1.3;
		color: var(--muted);
	}

	.message-text-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	/* Said outright: the bubbles turn both off on a touch screen, and this is the one place they are on. */
	.message-text {
		-webkit-user-select: text;
		user-select: text;
		-webkit-touch-callout: default;
		font-size: 14px;
		line-height: 1.55;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
</style>
