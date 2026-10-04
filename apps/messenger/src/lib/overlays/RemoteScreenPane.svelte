<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import RemoteScreenView from './RemoteScreenView.svelte';
	import { rememberedSignIn } from '../remote/screen-sign-in.ts';
	import { keyboardViewport } from './terminal-viewport.ts';

	/**
	 * The phone's page for the Mac's screen. Only a phone reaches its Mac this way, so there is
	 * no desktop pane for it; this host only keeps the key row above a software keyboard, the way
	 * the terminal's page does.
	 */
	interface Props {
		api: MessengerApi;
		t: Copy;
		onClose: () => void;
	}

	let { api, t, onClose }: Props = $props();

	let above = $state<{ top: number; height: number } | null>(null);

	$effect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const follow = () => (above = keyboardViewport(window.innerHeight, viewport));
		follow();
		viewport.addEventListener('resize', follow);
		viewport.addEventListener('scroll', follow);
		return () => {
			viewport.removeEventListener('resize', follow);
			viewport.removeEventListener('scroll', follow);
		};
	});
</script>

<div
	class="screen-overlay"
	style:top={above ? `${above.top}px` : null}
	style:bottom={above ? 'auto' : null}
	style:height={above ? `${above.height}px` : null}
	role="dialog"
	aria-modal="true"
	aria-label={t.screen.title}
>
	{#if api.kind === 'remote'}
		<RemoteScreenView {api} {t} {onClose} remember={rememberedSignIn(api.enrollment)} />
	{/if}
</div>

<style>
	.screen-overlay {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		background: var(--pane);
	}
</style>
