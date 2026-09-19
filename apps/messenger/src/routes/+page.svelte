<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { copyFor } from '$lib/copy';
	import { MessengerRuntime } from '$lib/runtime.svelte';
	import { previewFromUrl, selectionFromUrl, sessionFromUrl, sessionUrl } from '$lib/session-url';
	import { updateChecker } from '$lib/update-checker.svelte';
	import Shell from '$lib/Shell.svelte';

	const runtime = new MessengerRuntime();
	if (typeof window !== 'undefined') {
		(window as unknown as { __runtime?: MessengerRuntime }).__runtime = runtime;
	}

	// The open session is in the URL as `?s=<id>` and the open artifact preview as `?p=<relpath>`
	// so a reload, a hot reload and the back button all land back on them; `session-url.ts` says
	// why they are queries and not paths.
	//
	// Seeded before connecting. `connect()` already checks a restored id against the sessions it
	// fetched and drops it if that session is gone, which is what a stale link needs. A preview
	// path is restored even when the session list has not arrived yet — the pane fetches the file
	// from the workspace, not from the transcript.
	const fromUrl = sessionFromUrl(page.url);
	if (fromUrl) runtime.selectedId = fromUrl;
	const preview = previewFromUrl(page.url);
	if (preview) runtime.previewRelpath = preview;

	onMount(() => {
		runtime.start();
		updateChecker.start();
		return () => {
			runtime.destroy();
			updateChecker.stop();
		};
	});

	// Session and preview each have a URL→runtime effect; one write effect mirrors both back to
	// the URL. Track both sides in one effect and they fight: a click sets `selectedId`, the URL
	// effect re-runs before the navigation lands, reads a URL that still has no session, and
	// clears the selection again.

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

	$effect(() => {
		const wanted = previewFromUrl(page.url);
		untrack(() => {
			if (wanted !== runtime.previewRelpath) runtime.previewRelpath = wanted;
		});
	});

	/** The selection moved — a sidebar row, a search hit, a new Bot, a deleted session, a preview. */
	$effect(() => {
		const id = runtime.selectedId;
		const previewRelpath = runtime.previewRelpath;
		untrack(() => {
			const target = sessionUrl(page.url, id, previewRelpath);
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

<style>
	/* The disconnected screen and the three-pane grid. */
	/* Disconnected State */
	.disconnected {
		min-height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
		gap: 12px;
		background: var(--bg);
	}

	.disconnected::before {
		content: "";
		display: block;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		border: 3px solid var(--line);
		border-top-color: var(--accent);
		animation: spin 1s linear infinite;
	}
</style>
