<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { copyFor } from '$lib/copy';
	import { MessengerRuntime } from '$lib/runtime.svelte';
	import { selectionFromUrl, sessionFromUrl, sessionUrl } from '$lib/session-url';
	import { updateChecker } from '$lib/update-checker.svelte';
	import Shell from '$lib/Shell.svelte';

	const runtime = new MessengerRuntime();
	if (typeof window !== 'undefined') {
		(window as unknown as { __runtime?: MessengerRuntime }).__runtime = runtime;
	}

	// The open session is in the URL as `?s=<id>` so a reload, a hot reload and the back button
	// all land back on it; `session-url.ts` says why it is a query and not a path.
	//
	// Seeded before connecting. `connect()` already checks a restored id against the sessions it
	// fetched and drops it if that session is gone, which is what a stale link needs.
	const fromUrl = sessionFromUrl(page.url);
	if (fromUrl) runtime.selectedId = fromUrl;

	onMount(() => {
		runtime.start();
		updateChecker.start();
		return () => {
			runtime.destroy();
			updateChecker.stop();
		};
	});

	// The two effects mirror each other, so each tracks only its own side. Track both and they
	// fight: a click sets `selectedId`, the URL effect re-runs before the navigation lands, reads
	// a URL that still has no session, and clears the selection again.

	/** The URL moved — a deep link, the back button, the forward button. */
	$effect(() => {
		const wanted = sessionFromUrl(page.url);
		untrack(() => {
			const next = selectionFromUrl(
				wanted,
				runtime.selectedId,
				runtime.snapshot.sessions.map((session) => session.id)
			);
			if (next.action === 'clear') runtime.selectedId = null;
			else if (next.action === 'select') void runtime.selectSession(next.id);
		});
	});

	/** The selection moved — a sidebar row, a search hit, a new Bot, a deleted session. */
	$effect(() => {
		const id = runtime.selectedId;
		untrack(() => {
			const target = sessionUrl(page.url, id);
			if (target) void goto(target, { noScroll: true, keepFocus: true });
		});
	});

	const disconnectedCopy = $derived(copyFor(runtime.snapshot.settings.locale).disconnected.message);
</script>

{#if runtime.connection === 'disconnected'}
	<main class="disconnected">{disconnectedCopy}</main>
{:else}
	<Shell {runtime} />
{/if}
