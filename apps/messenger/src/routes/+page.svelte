<script lang="ts">
	import BrandMark from '$lib/BrandMark.svelte';
	import { onMount, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { copyFor } from '$lib/copy';
	import { MessengerRuntime } from '$lib/runtime.svelte';
	import {
		overlayApply,
		overlayFromFlags,
		overlayFromUrl,
		previewFromUrl,
		attachmentFromUrl,
		selectionFromUrl,
		sessionFromUrl,
		sessionUrl,
		viewFromUrl
	} from '$lib/session-url';
	import { planUrlNavigation, routeStep, stackAfter } from '$lib/mobile-route';
	import { HOSTED_MESSENGER } from '$lib/remote/mode';
	import { armBackFloor } from '$lib/back-floor';
	import PairingScreen from '$lib/remote/PairingScreen.svelte';
	import { updateChecker } from '$lib/update-checker.svelte';
	import Shell from '$lib/Shell.svelte';

	let shell = $state<Shell>();
beforeNavigate((navigation) => {
	// Back walks the app's own stack of screens before it walks history; see mobile-route.ts.
	if (navigation.type !== 'popstate') {
		cancelledBack = false;
		return;
	}
	// A step this page asked for is not the person pressing Back, so the chain stays out of it.
	if (selfBack) {
		selfBack = false;
		cancelledBack = false;
		return;
	}
	if ((navigation.delta ?? 0) < 0) {
		if (shell?.backMobileLayer()) {
			// The pointer stays where it was, so whatever closes next is written over this entry
			// rather than walked back to — walking would fight the restore this cancel triggers.
			// A pane that has to ask first answers later, so the flag waits for it.
			cancelledBack = true;
			awaitRestore();
			navigation.cancel();
			return;
		}
		cancelledBack = false;
	}
	// A forward step is the restore that cancel just asked for; it is not an answer to anything.
});

const runtime = new MessengerRuntime();
	if (typeof window !== 'undefined') {
		(window as unknown as { __runtime?: MessengerRuntime }).__runtime = runtime;
	}

	// The open session is `?s=<id>`, the artifact preview `?p=<relpath>`, and settings / the
	// session drawer / the workspace overlay share `?o=`. `session-url.ts` says why they are
	// queries and not paths.
	//
	// Connection setup must preserve these flags while the first snapshot is pending.
	// Seeded before connecting. `connect()` already checks a restored id against the sessions it
	// fetched and drops it if that session is gone, which is what a stale link needs. A preview
	// path is restored even when the session list has not arrived yet — the pane fetches the file
	// from the workspace, not from the transcript. Settings can open immediately; the drawer and
	// workspace wait for the snapshot so a missing session or Bot does not flash the wrong pane.
	const fromUrl = viewFromUrl(page.url, HOSTED_MESSENGER);
	if (fromUrl.selectedId) runtime.selectedId = fromUrl.selectedId;
	// The calendar drops a file preview: seeding one and then clearing it would flash the pane.
	if (fromUrl.overlay.kind !== 'routines' && fromUrl.overlay.kind !== 'spend' && fromUrl.overlay.kind !== 'terminal') {
		if (fromUrl.previewRelpath) runtime.previewRelpath = fromUrl.previewRelpath;
		if (fromUrl.previewAttachmentId) runtime.previewAttachmentId = fromUrl.previewAttachmentId;
	}
	if (fromUrl.overlay.kind !== 'none') runtime.applyOverlay(fromUrl.overlay);

	onMount(() => {
		runtime.start();
		updateChecker.start();
		// A phone's Back always has somewhere to go in the app before it leaves it; see back-floor.ts.
		const disarm = HOSTED_MESSENGER ? armBackFloor(() => shell?.backFromFloor() ?? false) : () => {};
		return () => {
			disarm();
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
			else if (next.action === 'select') void runtime.selectSession(next.id, { preservePage: true });
		});
	});

	$effect(() => {
		if (HOSTED_MESSENGER) return;
		const wanted = previewFromUrl(page.url);
		const overlayKind = overlayFromUrl(page.url).kind;
		const calendar = overlayKind === 'routines' || overlayKind === 'spend' || overlayKind === 'terminal' || runtime.routinesOpen || runtime.spendOpen || runtime.terminalOpen;
		untrack(() => {
			const next = calendar ? null : wanted;
			if (next !== runtime.previewRelpath) runtime.previewRelpath = next;
		});
	});

	$effect(() => {
		if (!HOSTED_MESSENGER) return;
		const wanted = attachmentFromUrl(page.url);
		untrack(() => {
			if (wanted !== runtime.previewAttachmentId) runtime.previewAttachmentId = wanted;
		});
	});

	$effect(() => {
		const wanted = overlayFromUrl(page.url, HOSTED_MESSENGER);
		// These states need no snapshot validation; a late detail must not undo pane navigation.
		if (wanted.kind === 'none' || wanted.kind === 'routines' || wanted.kind === 'spend' || wanted.kind === 'terminal' || wanted.kind === 'screen' || wanted.kind === 'usage' || wanted.kind === 'archived') {
			untrack(() => {
				if (overlayFromFlags(runtime).kind !== wanted.kind) runtime.applyOverlay(wanted);
			});
			return;
		}
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
				(wanted.kind === 'session' || wanted.kind === 'bot' || wanted.kind === 'trace') &&
				urlSession !== selectedId
			) {
				return;
			}
			// The window follows the conversation, so a stale job id in the URL must not win.
			if (wanted.kind === 'trace' && runtime.traceOpen && urlSession === selectedId) {
				return;
			}
			const current = overlayFromFlags({
				settingsOpen: runtime.settingsOpen,
				sessionSettingsOpen: runtime.sessionSettingsOpen,
				profileBotId: runtime.profileBotId,
				workspaceOpen: runtime.workspaceOpen,
				workspaceSelected: runtime.workspaceSelected,
				traceOpen: runtime.traceOpen,
				traceTaskId: runtime.traceTaskId,
				routinesOpen: runtime.routinesOpen,
				spendOpen: runtime.spendOpen,
				terminalOpen: runtime.terminalOpen,
				screenOpen: runtime.screenOpen,
				listPage: runtime.listPage
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

	/**
	 * History is a stack of screens, so opening one pushes and closing one walks back — see
	 * mobile-route.ts. `routeStack` is what this page put there; it is the only way to know
	 * whether the entry underneath is the one a close should return to, or whether the URL was
	 * someone else's deep link with nothing of ours behind it.
	 */
	let routeStack: string[] = [page.url.search];
	let replacing: string | null = null;
	/** A `history.back()` this page issued, so the layer chain does not treat it as a Back press. */
	let selfBack = false;
	/** A Back the chain answered: the entry is still ours to rewrite, not one to walk off. */
	let cancelledBack = false;
	/**
	 * A cancelled Back is undone by a step forward that lands a moment later. Until it does, the
	 * browser still sits on the entry underneath, so a URL written now — a file the chain just put
	 * away — would rewrite that entry, the conversation, instead of the one Back was pressed on.
	 */
	let restoring = $state(false);

	function awaitRestore(): void {
		restoring = true;
		// SvelteKit ignores the popstate of its own restore; it is only a signal here.
		const landed = () => {
			restoring = false;
			removeEventListener('popstate', landed);
			clearTimeout(timer);
		};
		addEventListener('popstate', landed);
		const timer = setTimeout(landed, 1000);
	}

	$effect(() => {
		const search = page.url.search;
		untrack(() => {
			routeStack = stackAfter(routeStack, search, replacing === search);
			replacing = null;
		});
	});

	/** The selection moved — a sidebar row, a search hit, a new Bot, a deleted session, a preview. */
	$effect(() => {
		const id = runtime.selectedId;
		const previewRelpath = runtime.previewRelpath;
		const previewAttachmentId = runtime.previewAttachmentId;
		const overlay = overlayFromFlags({
			settingsOpen: runtime.settingsOpen,
			sessionSettingsOpen: runtime.sessionSettingsOpen,
			profileBotId: runtime.profileBotId,
			workspaceOpen: runtime.workspaceOpen,
			workspaceSelected: runtime.workspaceSelected,
			traceOpen: runtime.traceOpen,
			traceTaskId: runtime.traceTaskId,
			routinesOpen: runtime.routinesOpen,
			spendOpen: runtime.spendOpen,
			terminalOpen: runtime.terminalOpen,
			screenOpen: runtime.screenOpen,
			listPage: runtime.listPage
		});
		// Written once the restore of a cancelled Back has landed; see `restoring`.
		if (restoring) return;
		untrack(() => {
			const wanted = { selectedId: id, previewRelpath, previewAttachmentId, overlay };
			const target = sessionUrl(page.url, wanted, HOSTED_MESSENGER);
			if (!target) return;
			const from = viewFromUrl(page.url, HOSTED_MESSENGER);
			const step = routeStep(from, wanted);
			// A Bot opened from a group's settings takes that page's place, so the entry
			// underneath has to be the conversation. Rewritten here rather than through
			// `stackAfter`: the conversation is already the entry below, and that helper would
			// pop this one instead of turning it into the conversation.
			if (step === 'swap' && from.overlay.kind === 'session' && wanted.overlay.kind === 'bot' && routeStack.length > 0) {
				const under = sessionUrl(page.url, { ...wanted, overlay: { kind: 'none' } }, HOSTED_MESSENGER);
				if (under) routeStack[routeStack.length - 1] = new URL(under, page.url).search;
			}
			const planned = planUrlNavigation({ target: new URL(target, page.url).search, stack: routeStack, step });
			const plan = planned === 'back' && cancelledBack ? 'replace' : planned;
			cancelledBack = false;
			if (plan === 'back') {
				selfBack = true;
				history.back();
				return;
			}
			if (plan === 'replace') replacing = new URL(target, page.url).search;
			void goto(target, { noScroll: true, keepFocus: true, replaceState: plan === 'replace' });
		});
	});

	const copy = $derived(copyFor(runtime.snapshot.settings.locale));
	const disconnectedCopy = $derived(
		runtime.hostUnreachable === 'host' ? copy.disconnected.host : copy.disconnected.message
	);
	// Not enrolled is not a connection problem: this device has nothing to connect with yet.
	const showPairing = $derived(HOSTED_MESSENGER && runtime.connection !== 'connected' && !runtime.enrolled);
	const connectingCopy = $derived(
		runtime.hostUnreachable === 'host' ? copy.disconnected.connectingHost : copy.disconnected.connecting
	);

	/*
	 * Once the shell has been up, losing the connection no longer swaps it for a blank screen: it
	 * stays where it was, faded and inert, under a banner that says what is going on. Coming back,
	 * it mounts afresh, exactly as it did when it had been taken away, so everything that
	 * re-attaches on mount (terminals, streams, history) does so as before. Before the first
	 * connection there is nothing to keep, and the centred screen still answers.
	 */
	let shellShown = $state(false);
	let shellGeneration = $state(0);
	let wasConnected = false;
	$effect(() => {
		const connected = runtime.connection === 'connected';
		untrack(() => {
			if (connected && !wasConnected && shellShown) shellGeneration += 1;
			if (connected) shellShown = true;
		});
		wasConnected = connected;
	});
	const offline = $derived(runtime.connection !== 'connected');
	const keepShell = $derived(shellShown && !showPairing && runtime.tabRole !== 'standby');
</script>

{#if offline && !keepShell}
	{#if showPairing}
		<PairingScreen {runtime} t={copy} />
	{:else if runtime.tabRole === 'standby'}
		<main class="disconnected" data-testid="tab-standby">
			<BrandMark size={48} />
			<span>{copy.notifications.tabTakeoverNotice}</span>
			<div class="disconnected-actions">
				<button type="button" data-testid="tab-takeover" onclick={() => void runtime.requestTabTakeover()}>
					{copy.notifications.tabTakeoverButton}
				</button>
			</div>
			{#if runtime.tabTakeoverTimeout}
				<p class="disconnected-hint">{copy.notifications.tabTakeoverTimeout}</p>
			{/if}
		</main>
	{:else if runtime.connection === 'connecting'}
		<main class="disconnected is-connecting" data-testid="connecting">
			<BrandMark size={48} />
			<span>{connectingCopy}</span>
		</main>
	{:else}
		<main class="disconnected" data-testid="unreachable">
			<BrandMark size={48} />
			<span>{disconnectedCopy}</span>
			{#if runtime.hostUnreachable === 'host'}
				<p class="disconnected-hint">{copy.disconnected.hostHint}</p>
			{/if}
			<div class="disconnected-actions">
				<button type="button" data-testid="retry-connection" onclick={() => runtime.retryConnection()}>
					{copy.disconnected.retry}
				</button>
			</div>
		</main>
	{/if}
{:else}
	{#if offline}
		<div class="offline-veil" aria-hidden="true"></div>
		<div class="offline-banner" role="status" data-testid={runtime.connection === 'connecting' ? 'connecting' : 'unreachable'}>
			{#if runtime.connection === 'connecting'}<span class="offline-spinner" aria-hidden="true"></span>{/if}
			<span class="offline-text">{runtime.connection === 'connecting' ? connectingCopy : disconnectedCopy}</span>
			{#if runtime.connection !== 'connecting'}
				<button type="button" class="offline-retry" data-testid="retry-connection" onclick={() => runtime.retryConnection()}>
					{copy.disconnected.retry}
				</button>
			{/if}
		</div>
	{/if}
	<div class="shell-host" inert={offline}>
		{#key shellGeneration}
			<Shell bind:this={shell} {runtime} />
		{/key}
	</div>
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

	.disconnected-hint {
		max-width: 28rem;
		text-align: center;
		font-size: 13px;
		font-weight: 500;
		line-height: 1.45;
	}
	.disconnected-actions {
		display: flex;
		gap: 8px;
	}
	.disconnected-actions button {
		min-height: 44px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		font-weight: 600;
	}
	/*
	 * Only an attempt in progress spins. A host that could not be reached waits for Retry, and a
	 * ring turning over "unreachable" said the opposite of what the line under it did.
	 */
	.disconnected.is-connecting::after {
		content: "";
		display: block;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		animation: spin 1s linear infinite;
	}

	/* Svelte scopes keyframes to the component; this one was left behind in the move to
	   component styles, so the ring has been sitting still ever since. */
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.disconnected.is-connecting::after {
			animation: none;
		}
	}

	/* The shell stays laid out exactly as before; this box only carries `inert` while offline. */
	.shell-host {
		display: contents;
	}

	/* Over the inert shell: it fades back so the banner reads first, and nothing under it takes a click. */
	.offline-veil {
		position: fixed;
		inset: 0;
		z-index: 900;
		background: color-mix(in srgb, var(--bg) 45%, transparent);
		-webkit-backdrop-filter: saturate(0.6);
		backdrop-filter: saturate(0.6);
		animation: offline-in var(--dur-slow) var(--ease-out);
	}

	.offline-banner {
		position: fixed;
		top: calc(env(safe-area-inset-top, 0px) + 10px);
		left: 50%;
		z-index: 901;
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: min(560px, calc(100% - 24px));
		min-height: 44px;
		padding: 6px 6px 6px 16px;
		border-radius: var(--radius-full);
		background: var(--pane);
		box-shadow: inset 0 0 0 1px var(--warn-line), var(--shadow-lg);
		color: var(--ink);
		font-size: var(--text-small);
		font-weight: 600;
		transform: translateX(-50%);
		animation: offline-banner-in var(--dur-slow) var(--ease-out);
	}

	.offline-text {
		min-width: 0;
	}

	.offline-spinner {
		flex: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		animation: spin 1s linear infinite;
	}

	.offline-retry {
		flex: none;
		height: 32px;
		padding: 0 14px;
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
		transition: background-color var(--dur-base) var(--ease-out), transform var(--dur-fast) var(--ease-out);
	}

	.offline-retry:hover {
		background: var(--accent-hover);
	}

	.offline-retry:active {
		transform: scale(0.97);
	}

	/* Without a spinner the banner waits for Retry; give its line the room the spinner had. */
	.offline-banner:not(:has(.offline-spinner)) {
		padding-left: 18px;
	}

	@keyframes offline-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@keyframes offline-banner-in {
		from {
			opacity: 0;
			transform: translate(-50%, -8px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}
</style>
