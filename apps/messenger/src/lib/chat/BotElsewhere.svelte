<script lang="ts">
	/**
	 * Where else the Bot of a direct is at work. Its avatar says it is busy wherever that is; this
	 * says where, beside the header, and takes you there: one place is one press, more open a list,
	 * the ones waiting on you first. Nothing shows while it works nowhere else.
	 */
	import type { SessionSummary } from '@real-bot/protocol';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import Icon from '../Icon.svelte';
	import BottomSheet from '../BottomSheet.svelte';
	import { PHONE_SHEET_QUERY } from '../bottom-sheet.ts';
	import { isOutside } from '../click-outside.ts';
	import { roveFocus } from '../menu-roving.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { botWorkPlaces, elsewhereLine, type WorkPlace } from '../sidebar/bot-elsewhere.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import { classifySession } from '../sidebar/session-groups.ts';
	import { isWorkingStatus, sessionStatus } from '../sidebar/session-status.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		botId: string;
		/** The conversation on screen, left out of the places. */
		here: SessionSummary;
	};

	let { runtime, t, botId, here }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const roster = $derived({ deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop });
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		failed: t.sidebar.statusFailed,
		interrupted: t.sidebar.statusInterrupted,
		idle: t.sidebar.statusIdle
	});
	const places = $derived(
		botWorkPlaces(botId, here.id, snapshot.sessions, snapshot.turns, snapshot.approvals, statusLabels, snapshot.pendingJudgements)
	);
	const alsoHere = $derived(
		isWorkingStatus(
			sessionStatus(
				here.id,
				snapshot.turns.filter((turn) => turn.bot_id === botId),
				snapshot.approvals,
				statusLabels,
				snapshot.pendingJudgements.filter((j) => j.bot_id === botId)
			).kind
		)
	);
	const line = $derived(elsewhereLine(places, alsoHere, botsById, roster, t.sidebar.elsewhere));
	/** The trigger's colour: waiting on you outranks working, as in the list. */
	const lead = $derived(places[0]?.status.kind ?? 'idle');

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLElement | null>(null);
	const phone = new MediaQuery(PHONE_SHEET_QUERY);

	function kindLabel(place: WorkPlace): string {
		const kind = classifySession(place.session);
		return kind === 'group' ? t.sidebar.groups : kind === 'bot-bot' ? t.sidebar.botBot : t.sidebar.youBot;
	}

	function go(place: WorkPlace): void {
		open = false;
		void runtime.selectSession(place.session.id);
	}

	function entries(): HTMLButtonElement[] {
		return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
	}

	async function press(): Promise<void> {
		if (places.length === 1) return go(places[0]);
		open = !open;
		if (!open || phone.current) return;
		await tick();
		entries()[0]?.focus();
	}

	function close(): void {
		open = false;
		if (!phone.current) trigger?.focus();
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape' || e.key === 'Tab') {
			if (e.key === 'Escape') e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		roveFocus(e, entries);
	}

	function onWindowClick(e: MouseEvent): void {
		if (open && !phone.current && menu && trigger && isOutside(e.target as Node | null, menu, trigger)) open = false;
	}

	// Done everywhere else meanwhile: the list goes with it.
	$effect(() => {
		if (places.length < 2) open = false;
	});
</script>

<svelte:window onclick={onWindowClick} />

<!-- A row of the list: what kind of conversation, its name, how it stands there. -->
{#snippet placeRow(place: WorkPlace)}
	<span class="place-kind">{kindLabel(place)}</span>
	<span class="place-name">{sessionTitle(place.session, botsById, roster)}</span>
	<span class="place-status is-{place.status.kind}">{place.status.label}</span>
{/snippet}

{#if line}
	<div class="elsewhere">
		<button
			bind:this={trigger}
			type="button"
			class="elsewhere-trigger is-{lead}"
			title={line}
			aria-haspopup={places.length > 1 ? 'menu' : undefined}
			aria-expanded={places.length > 1 ? open : undefined}
			onclick={() => void press()}
		>
			<span class="elsewhere-dot" class:is-busy={places[0]?.status.isBusy}></span>
			<span class="elsewhere-text">{line}</span>
			<Icon name={places.length > 1 ? 'chevron-down' : 'chevron-right'} size={12} />
		</button>
		{#if open && phone.current}
			<BottomSheet title={t.sidebar.elsewhere.menu} closeLabel={t.common.close} onClose={close}>
				<div bind:this={menu} role="menu" tabindex="-1" aria-label={t.sidebar.elsewhere.menu} onkeydown={onKeyDown}>
					{#each places as place (place.session.id)}
						<button type="button" role="menuitem" class="place is-sheet" onclick={() => go(place)}>{@render placeRow(place)}</button>
					{/each}
				</div>
			</BottomSheet>
		{:else if open}
			<div bind:this={menu} class="elsewhere-list" role="menu" tabindex="-1" aria-label={t.sidebar.elsewhere.menu} onkeydown={onKeyDown}>
				{#each places as place (place.session.id)}
					<button type="button" role="menuitem" class="place" onclick={() => go(place)}>{@render placeRow(place)}</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.elsewhere {
		position: relative;
		display: inline-flex;
		min-width: 0;
	}

	/* A quiet pill in the place's status colour: working is the accent, waiting on you warn or purple. */
	.elsewhere-trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		height: 26px;
		padding: 0 8px 0 10px;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent);
		font-size: var(--text-caption);
		font-weight: 600;
		white-space: nowrap;
		transition-duration: var(--dur-fast);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.elsewhere-trigger.is-waiting_approval {
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.elsewhere-trigger.is-waiting_ask {
		background: var(--purple-bg);
		color: var(--purple-text);
	}

	.elsewhere-trigger:hover,
	.elsewhere-trigger[aria-expanded='true'] {
		box-shadow: inset 0 0 0 1px currentColor;
	}

	.elsewhere-trigger:active {
		transform: scale(0.97);
	}

	.elsewhere-trigger:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.elsewhere-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.elsewhere-dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}

	.elsewhere-dot.is-busy {
		animation: elsewhere-pulse 1.8s ease-in-out infinite;
	}

	.elsewhere-list {
		animation: menuIn var(--dur-base) var(--ease-out);
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 30;
		display: flex;
		flex-direction: column;
		min-width: 240px;
		max-width: min(360px, 90vw);
		padding: 4px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-menu);
	}

	.place {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 8px;
		padding: 7px 10px;
		border-radius: var(--radius-sm);
		font-size: var(--text-small);
		color: var(--ink);
		text-align: left;
		cursor: pointer;
	}

	.place:hover,
	.place:focus-visible {
		background: var(--chip);
		outline: none;
	}

	.place.is-sheet {
		width: 100%;
		padding: 12px;
	}

	.place-kind {
		font-size: var(--text-micro);
		color: var(--muted);
	}

	.place-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.place-status {
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--accent);
	}

	.place-status.is-waiting_approval {
		color: var(--warn-text);
	}

	.place-status.is-waiting_ask {
		color: var(--purple-text);
	}

	@keyframes elsewhere-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.elsewhere-dot.is-busy {
			animation: none;
		}
	}
</style>
