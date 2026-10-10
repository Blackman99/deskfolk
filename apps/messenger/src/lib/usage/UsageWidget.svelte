<script lang="ts">
	import type { UsageAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { isOutside } from '../click-outside.ts';
	import { localeTag } from '../locale-tag.ts';
	import { listenToWindow } from '../tauri.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import UsageAgentSection from './UsageAgentSection.svelte';
	import { usageFeedOf } from './usage-feed.svelte.ts';
	import { usageCheckedTime, usageLatestCheck, usageLeft, usageLeftText, usageLevel, usageTightest } from './usage.ts';
	import { usageDrop, usageWidget } from './usage-widget.svelte.ts';

	/**
	 * Every agent's usage as a small ball over the main window (ADR 0080). Its ring is as full as what
	 * is left of the tightest window of all. Pointed at, the ball morphs into a column of the agents,
	 * each ringed by its own tightest window (a dashed ring: today's records only); pointing at one
	 * morphs a card out of it with every account of that agent. Dragged anywhere; dropped by the left
	 * or right edge it docks there, half tucked away. Clicks pin it open (touch, or to keep it), its
	 * context menu hides it, and Tools › Usage brings it back open.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
	}

	let { runtime, t }: Props = $props();

	/** The ball's box and each agent's slot in the column. */
	const SLOT = 46;
	const DRAG_PX = 4;
	const MARGIN = 8;
	/** Moving between the column and a card crosses a gap: this long before it all folds away. */
	const LEAVE_MS = 320;
	const CARD_W = 340;

	const feed = $derived(usageFeedOf(runtime));
	const client = $derived(runtime.connection === 'connected' ? runtime.client : null);
	const locale = $derived(localeTag(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh'));
	const agents = $derived(feed.agents ?? []);
	const key = (agent: UsageAgent) => `${agent.runner}:${agent.custom_id ?? ''}`;
	/** Each agent's tightest window over all its accounts; null for one with today's records only. */
	const tightestOf = (agent: UsageAgent) =>
		usageTightest(agent.accounts.flatMap((account) => (account.available ? account.windows : [])));
	const worst = $derived(agents.reduce((most, agent) => Math.max(most, tightestOf(agent)?.percent ?? 0), 0));
	const anyWindow = $derived(agents.some((agent) => tightestOf(agent) !== null));
	const visible = $derived(!usageWidget.hidden && agents.length > 0);
	const checked = $derived(usageCheckedTime(usageLatestCheck(agents), locale));

	$effect(() => {
		const api = client;
		if (!api) return;
		return feed.watch(api);
	});

	// The menu bar's "Show all usage…".
	$effect(() =>
		listenToWindow('pane-command', (id) => {
			if (id === 'view-usage') usageWidget.show();
		})
	);

	let viewW = $state(1280);
	let viewH = $state(800);
	let wrapEl = $state<HTMLElement | null>(null);
	let ballEl = $state<HTMLButtonElement | null>(null);
	let cardEl = $state<HTMLElement | null>(null);
	let menuEl = $state<HTMLElement | null>(null);

	let pointing = $state(false);
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;
	let keyboard = $state(false);
	/** The agent pointed at or picked, and where its bubble is, for the card to grow out of. */
	let active = $state<string | null>(null);
	let pinnedAgent = $state<string | null>(null);
	let menuAt = $state<{ x: number; y: number } | null>(null);

	let press: { id: number; x: number; y: number; dx: number; dy: number; moved: boolean } | null = null;
	let dragAt = $state<{ left: number; top: number } | null>(null);
	let swallowClick = false;

	const place = $derived(usageWidget.place);
	const docked = $derived(dragAt ? null : place.dock);
	const expanded = $derived(dragAt === null && (pointing || keyboard || usageWidget.open || menuAt !== null));
	const tucked = $derived(docked !== null && !expanded);
	const top = $derived(dragAt ? dragAt.top : Math.round(place.top * Math.max(0, viewH - SLOT)));
	const left = $derived.by(() => {
		if (dragAt) return dragAt.left;
		if (place.dock === null) return Math.round(place.left * Math.max(0, viewW - SLOT));
		return place.dock === 'left' ? 0 : Math.max(0, viewW - SLOT);
	});
	/** The column grows toward the roomier half: down from a ball in the top half, up from one below. */
	const upward = $derived(top + SLOT / 2 > viewH / 2);
	/** Cards open toward the middle of the window. */
	const cardLeftward = $derived(left + SLOT / 2 > viewW / 2);
	const shift = $derived(!tucked ? 0 : docked === 'right' ? SLOT / 2 : -SLOT / 2);
	const columnH = $derived(SLOT + agents.length * SLOT + 4);
	const shownAgent = $derived(expanded ? (agents.find((agent) => key(agent) === (pinnedAgent ?? active)) ?? null) : null);

	function enter(): void {
		clearTimeout(leaveTimer);
		pointing = true;
	}

	function leave(): void {
		clearTimeout(leaveTimer);
		leaveTimer = setTimeout(() => {
			pointing = false;
			if (!usageWidget.open) active = null;
		}, LEAVE_MS);
	}

	function pointAt(agent: UsageAgent): void {
		if (pinnedAgent && pinnedAgent !== key(agent)) pinnedAgent = null;
		active = key(agent);
	}

	function pick(agent: UsageAgent): void {
		pointAt(agent);
		pinnedAgent = pinnedAgent === key(agent) && usageWidget.open ? null : key(agent);
		usageWidget.open = true;
	}

	/** Focus handed back to the ball as it folds: it must not open it again. */
	let returning = false;

	/** Only a keyboard's focus keeps it open: a click focuses buttons in some engines. */
	function onFocusIn(event: FocusEvent): void {
		if (returning) {
			returning = false;
			return;
		}
		try {
			keyboard = (event.target as Element).matches(':focus-visible');
		} catch {
			keyboard = true;
		}
	}

	function onFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget as Node | null;
		if (!wrapEl?.contains(next) && !cardEl?.contains(next)) keyboard = false;
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.button !== 0 || !ballEl || !wrapEl) return;
		const box = wrapEl.getBoundingClientRect();
		press = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false };
		ballEl.setPointerCapture?.(event.pointerId);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!press || event.pointerId !== press.id) return;
		if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_PX) return;
		press.moved = true;
		usageWidget.open = false;
		pinnedAgent = null;
		active = null;
		dragAt = {
			left: Math.min(Math.max(0, event.clientX - press.dx), Math.max(0, viewW - SLOT)),
			top: Math.min(Math.max(0, event.clientY - press.dy), Math.max(0, viewH - SLOT))
		};
	}

	function onPointerUp(event: PointerEvent): void {
		if (!press || event.pointerId !== press.id) return;
		const moved = press.moved;
		press = null;
		if (!moved || !dragAt) return;
		usageWidget.move(usageDrop(dragAt.left, dragAt.top, SLOT, SLOT, viewW, viewH));
		dragAt = null;
		swallowClick = true;
	}

	function onPointerCancel(): void {
		press = null;
		dragAt = null;
	}

	function onBallClick(): void {
		if (swallowClick) {
			swallowClick = false;
			return;
		}
		usageWidget.open = !usageWidget.open;
		if (!usageWidget.open) pinnedAgent = null;
	}

	function onContextMenu(event: MouseEvent): void {
		event.preventDefault();
		menuAt = { x: event.clientX, y: event.clientY };
	}

	function hide(): void {
		menuAt = null;
		pinnedAgent = null;
		active = null;
		usageWidget.hide();
	}

	function closeAll(): void {
		usageWidget.open = false;
		keyboard = false;
		pinnedAgent = null;
		active = null;
		pointing = false;
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		if (!menuAt && !usageWidget.open && !shownAgent) return;
		event.preventDefault();
		event.stopPropagation();
		menuAt = null;
		closeAll();
		if (document.activeElement !== ballEl) {
			returning = true;
			ballEl?.focus();
			returning = false;
		}
	}

	function onWindowPointerDown(event: PointerEvent): void {
		const target = event.target as Node | null;
		if (menuAt && isOutside(target, menuEl)) menuAt = null;
		const fromTools = target instanceof Element && target.closest('[data-tools-usage]');
		if (usageWidget.open && !fromTools && isOutside(target, wrapEl, cardEl)) closeAll();
	}

	/** Tools › Usage (or the menu bar) opened it: the column, with the first agent's card. */
	$effect(() => {
		if (!usageWidget.open || pinnedAgent || active || agents.length === 0 || !wrapEl) return;
		const first = agents[0]!;
		pinnedAgent = key(first);
	});

	/**
	 * Where the shown agent's bubble stands once the column is open: worked out from where the ball
	 * rests, not measured, since the ball may still be sliding out of its tuck.
	 */
	const anchor = $derived.by(() => {
		const index = shownAgent ? agents.findIndex((agent) => key(agent) === key(shownAgent!)) : -1;
		if (index < 0) return null;
		const y = upward ? top - (index + 1) * SLOT : top + (index + 1) * SLOT;
		return { left, right: left + SLOT, top: y, height: SLOT };
	});

	/** Where the card stands: beside its agent's bubble, toward the middle, kept on screen. */
	const cardBox = $derived.by(() => {
		if (!anchor) return { left: 0, top: 0 };
		const x = cardLeftward ? anchor.left - 8 - CARD_W : anchor.right + 8;
		return { left: Math.max(MARGIN, Math.min(x, viewW - CARD_W - MARGIN)), top: Math.max(MARGIN, anchor.top - 6) };
	});

	$effect(() => {
		if (!cardEl) return;
		const fit = () => {
			if (!cardEl) return;
			const h = cardEl.offsetHeight;
			if (cardBox.top + h > viewH - MARGIN) cardEl.style.top = `${Math.max(MARGIN, viewH - MARGIN - h)}px`;
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(cardEl);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!menuAt || !menuEl) return;
		const box = menuEl.getBoundingClientRect();
		menuEl.style.left = `${Math.max(MARGIN, Math.min(menuAt.x, viewW - box.width - MARGIN))}px`;
		menuEl.style.top = `${Math.max(MARGIN, Math.min(menuAt.y, viewH - box.height - MARGIN))}px`;
		menuEl.querySelector('button')?.focus({ preventScroll: true });
	});

	$effect(() => () => clearTimeout(leaveTimer));

	const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	/**
	 * The card grows out of its agent's bubble: a circle where the bubble is, opening into the card's
	 * rounded box (clip-path insets, so both ends are the same shape and morph smoothly).
	 */
	function morph(node: HTMLElement, { duration }: { duration: number }) {
		if (reduced || !anchor) return { duration: 0 };
		const box = node.getBoundingClientRect();
		const w = box.width || CARD_W;
		const h = box.height || 200;
		const cy = Math.min(Math.max(anchor.top + anchor.height / 2 - box.top, SLOT / 2), h - SLOT / 2);
		const startTop = cy - SLOT / 2;
		const startBottom = h - cy - SLOT / 2;
		// The circle sits on the card's edge nearest the bubble.
		const startLeft = cardLeftward ? w - SLOT : 0;
		const startRight = cardLeftward ? 0 : w - SLOT;
		return {
			duration,
			css: (t: number) => {
				const e = 1 - Math.pow(1 - t, 3);
				const inset = (from: number) => (from * (1 - e)).toFixed(1);
				const radius = (SLOT / 2) * (1 - e) + 12 * e;
				return `clip-path: inset(${inset(startTop)}px ${inset(startRight)}px ${inset(startBottom)}px ${inset(startLeft)}px round ${radius.toFixed(1)}px); opacity: ${Math.min(1, t * 2.5)};`;
			}
		};
	}
</script>

<svelte:window bind:innerWidth={viewW} bind:innerHeight={viewH} onpointerdowncapture={onWindowPointerDown} />

{#if visible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={wrapEl}
		class="usage-widget"
		class:is-tucked={tucked}
		class:is-dragging={dragAt !== null}
		class:is-expanded={expanded}
		class:is-upward={upward}
		class:no-motion={reduced}
		style:left="{left}px"
		style:top="{top}px"
		style:transform="translateX({shift}px)"
		style:--column-h="{columnH}px"
		data-usage-widget
		data-dock={docked ?? 'free'}
		data-tucked={tucked ? 'yes' : 'no'}
		data-expanded={expanded ? 'yes' : 'no'}
		onpointerenter={enter}
		onpointerleave={leave}
		onfocusin={onFocusIn}
		onfocusout={onFocusOut}
		onkeydown={onKeyDown}
	>
		<!-- One shape: the ball, which the column grows out of and folds back into. -->
		<div class="usage-shell is-{usageLevel(worst)}">
			<button
				bind:this={ballEl}
				type="button"
				class="usage-ball"
				aria-label={t.usage.widget}
				title={usageWidget.open ? t.usage.close : t.usage.show}
				aria-expanded={expanded}
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerCancel}
				onclick={onBallClick}
				oncontextmenu={onContextMenu}
			>
				<svg class="usage-ball-ring is-{usageLevel(worst)}" width="36" height="36" viewBox="0 0 28 28" aria-hidden="true">
					<circle cx="14" cy="14" r="12" fill="none" stroke="var(--line)" stroke-width="2.5" />
					{#if anyWindow}
						<circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset={100 - usageLeft(worst)} transform="rotate(-90 14 14)" />
					{/if}
					<path d="M14 15.5l3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
					<path d="M8.6 18.5a6 6 0 1 1 10.8 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
				</svg>
			</button>
			<ul class="usage-column" aria-label={t.usage.title}>
				{#each agents as agent, index (key(agent))}
					{@const tightest = tightestOf(agent)}
					<li style:--i={index}>
						<button
							type="button"
							class="usage-bubble is-{tightest ? usageLevel(tightest.percent) : 'today'}"
							class:is-active={shownAgent !== null && key(shownAgent) === key(agent)}
							data-usage-bubble={key(agent)}
							aria-label={`${agent.runner === 'claude_code' ? 'Claude' : agent.label}${tightest ? ` ${t.usage.left(usageLeftText(tightest.percent))}` : ''}`}
							tabindex={expanded ? 0 : -1}
							onpointerenter={() => pointAt(agent)}
							onfocus={() => pointAt(agent)}
							onclick={() => pick(agent)}
						>
							<svg class="usage-bubble-ring" width="40" height="40" viewBox="0 0 32 32" aria-hidden="true">
								{#if tightest}
									<circle cx="16" cy="16" r="14.5" fill="none" stroke="var(--line)" stroke-width="2" />
									<circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset={100 - usageLeft(tightest.percent)} transform="rotate(-90 16 16)" />
								{:else}
									<circle cx="16" cy="16" r="14.5" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-dasharray="3 3" />
								{/if}
							</svg>
							<span class="usage-bubble-logo"><AgentLogo runner={agent.runner} size={20} /></span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</div>

	{#if shownAgent}
		{#key key(shownAgent)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				bind:this={cardEl}
				class="usage-card"
				role="dialog"
				aria-label={shownAgent.runner === 'claude_code' ? 'Claude' : shownAgent.label}
				tabindex="-1"
				style:left="{cardBox.left}px"
				style:top="{cardBox.top}px"
				style:width="{CARD_W}px"
				data-usage-card={key(shownAgent)}
				onpointerenter={enter}
				onpointerleave={leave}
				onfocusin={onFocusIn}
				onfocusout={onFocusOut}
				onkeydown={onKeyDown}
				in:morph={{ duration: 260 }}
				out:morph={{ duration: 140 }}
			>
				<UsageAgentSection agent={shownAgent} {t} {locale} now={feed.now} />
				{#if shownAgent.accounts.length === 0}
					<p class="usage-card-note">{t.usage.todayOnlyHint}</p>
				{/if}
				<footer class="usage-card-foot">
					<span class="usage-card-checked">{checked ? (feed.failed ? t.usage.stale(checked) : t.usage.checkedAt(checked)) : ''}</span>
					<button type="button" class="usage-card-refresh" disabled={feed.busy} onclick={() => client && void feed.load(client, true)}>{feed.busy ? t.usage.refreshing : t.usage.refresh}</button>
				</footer>
			</div>
		{/key}
	{/if}
{/if}

{#if usageWidget.open && !visible && feed.agents !== null && agents.length === 0}
	<div class="usage-card is-empty" role="dialog" aria-label={t.usage.title} style:right="{MARGIN}px" style:top="{MARGIN}px" style:width="{CARD_W}px" data-usage-card="empty">
		<p class="usage-empty">{t.usage.empty}</p>
	</div>
{/if}

{#if menuAt && visible}
	<div bind:this={menuEl} class="usage-menu" role="menu" tabindex="-1" onkeydown={onKeyDown}>
		<button type="button" class="usage-menu-item" role="menuitem" onclick={hide}>{t.usage.hide}</button>
	</div>
{/if}

<style>
	.usage-widget {
		position: fixed;
		z-index: 90;
		width: 46px;
		height: 46px;
		transition: transform 0.2s ease;
		touch-action: none;
	}

	/* Tucking waits a beat after the pointer leaves; coming out does not. */
	.usage-widget.is-tucked {
		transition: transform 0.22s ease 0.1s;
	}

	.usage-widget.is-dragging,
	.usage-widget.no-motion,
	.no-motion .usage-shell,
	.no-motion .usage-column li {
		transition: none;
	}

	/*
	 * The ball and the column are one shape: clipped to the ball while folded, opened to the whole
	 * column when pointed at, so the ball itself grows into it.
	 */
	.usage-shell {
		position: absolute;
		left: 0;
		top: 0;
		width: 46px;
		height: var(--column-h);
		display: flex;
		flex-direction: column;
		align-items: center;
		border: 1px solid var(--line);
		border-radius: 23px;
		background: var(--pane);
		box-shadow: var(--shadow-md);
		box-sizing: border-box;
		clip-path: inset(0 0 calc(var(--column-h) - 46px) 0 round 23px);
		transition: clip-path 0.26s cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.is-upward .usage-shell {
		top: auto;
		bottom: 0;
		flex-direction: column-reverse;
		clip-path: inset(calc(var(--column-h) - 46px) 0 0 0 round 23px);
	}

	.is-expanded .usage-shell,
	.is-upward.is-expanded .usage-shell {
		clip-path: inset(0 0 0 0 round 23px);
	}

	.usage-shell.is-warn {
		border-color: var(--warn);
	}

	.usage-shell.is-danger {
		border-color: var(--danger);
	}

	.usage-ball {
		flex: none;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		cursor: grab;
		transition: none;
		user-select: none;
		-webkit-user-select: none;
	}

	.is-dragging .usage-ball {
		cursor: grabbing;
	}

	.usage-ball-ring.is-warn {
		color: var(--warn);
	}

	.usage-ball-ring.is-danger {
		color: var(--danger);
	}

	.usage-column {
		list-style: none;
		margin: 0;
		padding: 0 0 2px;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.is-upward .usage-column {
		flex-direction: column-reverse;
		padding: 2px 0 0;
	}

	/* The bubbles come in one after another as the column opens, and leave together. */
	.usage-column li {
		display: grid;
		place-items: center;
		width: 46px;
		height: 46px;
		opacity: 0;
		transform: scale(0.6);
		transition: opacity 0.12s ease, transform 0.12s ease;
	}

	.is-expanded .usage-column li {
		opacity: 1;
		transform: none;
		transition: opacity 0.2s ease calc(var(--i) * 35ms + 60ms), transform 0.24s cubic-bezier(0.3, 1.4, 0.5, 1) calc(var(--i) * 35ms + 60ms);
	}

	.usage-bubble {
		position: relative;
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: background-color 0.15s ease;
	}

	.usage-bubble:hover,
	.usage-bubble.is-active {
		background: var(--row-hover);
	}

	.usage-bubble.is-warn {
		color: var(--warn);
	}

	.usage-bubble.is-danger {
		color: var(--danger);
	}

	.usage-bubble-ring {
		position: absolute;
		inset: 0;
	}

	.usage-bubble-logo {
		display: grid;
		place-items: center;
	}

	.usage-card {
		position: fixed;
		z-index: 95;
		max-height: min(70vh, calc(100dvh - 16px));
		overflow-y: auto;
		padding: 12px 14px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--pane);
		box-shadow: var(--shadow-lg);
		outline: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* A little larger than the phone's page: read at a glance, over whatever is under it. */
	.usage-card :global(.usage-agent-head),
	.usage-card :global(.usage-account-head),
	.usage-card :global(.usage-row),
	.usage-card :global(.usage-note) {
		font-size: 13px;
	}

	.usage-card :global(.usage-agent-today),
	.usage-card :global(.usage-credits),
	.usage-card :global(.usage-reset) {
		font-size: 12px;
	}

	.usage-card-note,
	.usage-empty {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.5;
	}

	.usage-card-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
		font-size: 11px;
		color: var(--muted);
	}

	.usage-card-checked {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-card-refresh {
		flex: none;
		padding: 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--ink);
		font-size: 11px;
		cursor: pointer;
	}

	.usage-card-refresh:hover:not(:disabled) {
		background: var(--row-hover);
	}

	.usage-card-refresh:disabled {
		color: var(--muted);
		cursor: default;
	}

	.usage-menu {
		position: fixed;
		z-index: 100;
		padding: 5px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-menu);
	}

	.usage-menu-item {
		display: block;
		width: 100%;
		padding: 6px 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font-size: 12px;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.usage-menu-item:hover,
	.usage-menu-item:focus-visible {
		background: var(--row-hover);
		outline: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.usage-widget,
		.usage-shell,
		.usage-column li {
			transition: none !important;
		}
	}
</style>
