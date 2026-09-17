<script lang="ts">
	import { onMount } from 'svelte';
	import { copyFor } from '$lib/copy';
	import { MessengerRuntime } from '$lib/runtime.svelte';
	import Shell from '$lib/Shell.svelte';

	const runtime = new MessengerRuntime();
	if (typeof window !== 'undefined') {
		(window as unknown as { __runtime?: MessengerRuntime }).__runtime = runtime;
	}

	onMount(() => {
		runtime.start();
		return () => runtime.destroy();
	});

	const disconnectedCopy = $derived(copyFor(runtime.snapshot.settings.locale).disconnected.message);
</script>

{#if runtime.connection === 'disconnected'}
	<main class="disconnected">{disconnectedCopy}</main>
{:else}
	<Shell {runtime} />
{/if}
