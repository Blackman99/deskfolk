<script lang="ts">
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { themeManager } from '$lib/theme';
	import '$lib/styles/index.css';

	let { children } = $props();

	onMount(() => {
		return themeManager.init();
	});
</script>

<svelte:head>
	<title>Real Bot</title>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
