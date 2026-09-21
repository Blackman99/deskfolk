<script lang="ts">
	import { onMount } from 'svelte';
	import { updated } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import { copyFor } from '$lib/copy';
	import { themeManager } from '$lib/theme';
	import { HOSTED_MESSENGER } from '$lib/remote/mode';
	import '$lib/styles/index.css';

	let { children } = $props();
	// The layout sits above the runtime, so this one line follows the browser rather than the
	// stored setting; everything else in the app reads the setting.
	const t = copyFor(
		typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('zh') ? 'en' : 'zh'
	);

	onMount(() => {
		const stop = themeManager.init();
		if (HOSTED_MESSENGER && 'serviceWorker' in navigator) {
			void navigator.serviceWorker.register('/sw.js');
		}
		return stop;
	});
</script>

<svelte:head>
	<title>Real Bot</title>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

{#if updated.current}
	<div class="app-updated" role="status">
		<span>{t.common.updateReady}</span>
		<button type="button" onclick={() => location.reload()}>{t.common.updateReload}</button>
	</div>
{/if}

<style>
	/* A new build is worth a line, not a takeover: nobody wants the page swapped mid-sentence. */
	.app-updated {
		position: fixed;
		left: 50%;
		bottom: max(16px, env(safe-area-inset-bottom));
		transform: translateX(-50%);
		z-index: 90;
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: calc(100vw - 32px);
		padding: 8px 10px 8px 14px;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--pane);
		color: var(--ink);
		font-size: 12.5px;
		box-shadow: 0 14px 30px -12px rgba(2, 6, 23, 0.55);
	}

	.app-updated button {
		min-height: 32px;
		padding: 0 12px;
		border-radius: 9999px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-size: 12.5px;
		font-weight: 600;
	}
</style>
