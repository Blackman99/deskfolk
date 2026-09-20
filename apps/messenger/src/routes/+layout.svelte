<script lang="ts">
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { themeManager } from '$lib/theme';
	import { HOSTED_MESSENGER } from '$lib/remote/mode';
	import '$lib/styles/index.css';

	let { children } = $props();

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
