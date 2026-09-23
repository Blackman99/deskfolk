<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { backdropClick } from '../click-outside.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import type { RouteLogRow } from './route-log.ts';
	import RouteLogView from './RouteLogView.svelte';

	/**
	 * The narrow host for the model-choice log: a page that arrives from the right, dims what is
	 * behind it and closes on a click outside. On a wide desktop window the same `RouteLogView` is
	 * a pane, closed by its own tab rather than by a ✕ inside the content.
	 */
	interface Props {
		rows: RouteLogRow[];
		sessionTitle: string;
		loading: boolean;
		showEndpoint: boolean;
		t: Copy;
		onClose: () => void;
		onJump: (messageId: string) => void;
	}

	let { rows, sessionTitle, loading, showEndpoint, t, onClose, onJump }: Props = $props();
	/** A click outside closes it; a text-selection drag that starts inside never does. */
	const routeLogBackdrop = backdropClick();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="route-log-overlay"
	transition:pageSlide
	role="dialog"
	aria-modal="true"
	aria-label={t.routes.title}
	tabindex="-1"
	onmousedowncapture={routeLogBackdrop.press}
	onclick={(e) => {
		if (routeLogBackdrop.isOutside(e)) onClose();
	}}
>
	<div class="route-log-overlay-pane">
		<RouteLogView {rows} {sessionTitle} {loading} {showEndpoint} {t} {onClose} {onJump} />
	</div>
</div>

<style>
	.route-log-overlay {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: flex;
		justify-content: flex-end;
		background: var(--modal-backdrop);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		animation: backdropFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.route-log-overlay-pane {
		width: min(560px, calc(100vw - 72px));
		height: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-left: 1px solid var(--line);
		box-shadow: -16px 0 36px -6px rgba(15, 23, 42, 0.18);
		animation: slideInRight 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@media (max-width: 680px) {
		.route-log-overlay {
			background: transparent;
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
			animation: none;
		}

		.route-log-overlay-pane {
			width: 100%;
			border-left: 0;
			box-shadow: none;
			animation: none;
		}

		/* Tighter gutters and room for the notch. This is about the device, not about how wide
		   the content happens to be, so it belongs to the phone host rather than to the content —
		   inside a pane a window-width query would be answering the wrong question anyway. */
		.route-log-overlay-pane :global(.route-log-header) {
			padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
		}

		.route-log-overlay-pane :global(.route-log-body) {
			padding: 12px 12px calc(20px + env(safe-area-inset-bottom));
		}
	}
</style>
