<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { copyFor } from '$lib/copy';
	import { MessengerRuntime } from '$lib/runtime.svelte';
	import {
		overlayApply,
		overlayFromFlags,
		overlayFromUrl,
		previewFromUrl,
		selectionFromUrl,
		sessionFromUrl,
		sessionUrl,
		viewFromUrl
	} from '$lib/session-url';
	import { updateChecker } from '$lib/update-checker.svelte';
	import Shell from '$lib/Shell.svelte';

	const runtime = new MessengerRuntime();
	if (typeof window !== 'undefined') {
		(window as unknown as { __runtime?: MessengerRuntime }).__runtime = runtime;
	}

	// The open session is `?s=<id>`, the artifact preview `?p=<relpath>`, and settings / the
	// session drawer / the workspace overlay share `?o=`. `session-url.ts` says why they are
	// queries and not paths.
	//
	// Seeded before connecting. `connect()` already checks a restored id against the sessions it
	// fetched and drops it if that session is gone, which is what a stale link needs. A preview
	// path is restored even when the session list has not arrived yet — the pane fetches the file
	// from the workspace, not from the transcript. Settings can open immediately; the drawer and
	// workspace wait for the snapshot so a missing session or Bot does not flash the wrong pane.
	const fromUrl = viewFromUrl(page.url);
	if (fromUrl.selectedId) runtime.selectedId = fromUrl.selectedId;
	if (fromUrl.previewRelpath) runtime.previewRelpath = fromUrl.previewRelpath;
	if (fromUrl.overlay.kind !== 'none') runtime.applyOverlay(fromUrl.overlay);

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

	$effect(() => {
		const wanted = overlayFromUrl(page.url);
		const urlSession = sessionFromUrl(page.url);
		const sessions = runtime.snapshot.sessions;
		const bots = runtime.snapshot.bots;
		const connected = runtime.connection;
		const workspacePath = runtime.snapshot.settings.workspace_path;
		untrack(() => {
			const selectedId = runtime.selectedId;
			// Session and overlay queries can land a tick apart. Wait until they name the same
			// session so a click that already closed the drawer is not reopened from a stale `?o=`.
			if (
				(wanted.kind === 'session' || wanted.kind === 'bot') &&
				urlSession !== selectedId
			) {
				return;
			}
			const current = overlayFromFlags({
				settingsOpen: runtime.settingsOpen,
				sessionSettingsOpen: runtime.sessionSettingsOpen,
				profileBotId: runtime.profileBotId,
				workspaceOpen: runtime.workspaceOpen,
				workspaceSelected: runtime.workspaceSelected
			});
			const next = overlayApply(wanted, current, {
				selectedId,
				knownSessionIds: sessions.map((session) => session.id),
				knownBotIds: bots.map((bot) => bot.id),
				hasWorkspacePath: Boolean(workspacePath),
				snapshotReady: connected === 'connected'
			});
			if (next.action === 'set') runtime.applyOverlay(next.overlay);
		});
	});

	/** The selection moved — a sidebar row, a search hit, a new Bot, a deleted session, a preview. */
	$effect(() => {
		const id = runtime.selectedId;
		const previewRelpath = runtime.previewRelpath;
		const overlay = overlayFromFlags({
			settingsOpen: runtime.settingsOpen,
			sessionSettingsOpen: runtime.sessionSettingsOpen,
			profileBotId: runtime.profileBotId,
			workspaceOpen: runtime.workspaceOpen,
			workspaceSelected: runtime.workspaceSelected
		});
		untrack(() => {
			const target = sessionUrl(page.url, { selectedId: id, previewRelpath, overlay });
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
