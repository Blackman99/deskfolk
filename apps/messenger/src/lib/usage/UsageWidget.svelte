<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { isOutside } from '../click-outside.ts';
	import { localeTag } from '../locale-tag.ts';
	import { listenToWindow } from '../tauri.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import UsagePanelBody from './UsagePanelBody.svelte';
	import UsageRing from './UsageRing.svelte';
	import { usageFeedOf } from './usage-feed.svelte.ts';
	import { usageAccountName, usageLeftText, usageLevel, usageMeterEntries, usageSummary } from './usage.ts';
	import { usageDrop, usageWidget } from './usage-widget.svelte.ts';

	/**
	 * Every agent's usage, floating over the main window (ADR 0080). A pill with a ring per account
	 * whose plan reports windows, as full as what is left of its tightest one; dragged anywhere, and
	 * dropped by the left or right edge it docks there and tucks away to a sliver until pointed at.
	 * A click opens the panel with everything; its context menu hides it, and Tools › Usage (or the
	 * menu bar's "Show all usage…") brings it back with the panel open.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
	}

	let { runtime, t }: Props = $props();

	/** The pill shows this many accounts; the rest are a count. */
	const SHOWN = 3;
	/** What a tucked pill keeps in view. */
	const SLIVER_PX = 14;
	/** Past this far a press is a drag, not a click. */
	const DRAG_PX = 4;
	const MARGIN = 8;

	const feed = $derived(usageFeedOf(runtime));
	const client = $derived(runtime.connection === 'connected' ? runtime.client : null);
	const locale = $derived(localeTag(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh'));
	const entries = $derived(usageMeterEntries(feed.agents ?? []));
	const shown = $derived(entries.slice(0, SHOWN));
	const extra = $derived(entries.length - shown.length);
	const worst = $derived(entries.reduce((most, entry) => Math.max(most, entry.tightest.percent), 0));
	/** The pill, while something runs on a local agent; the panel opens from Tools even when nothing does, to say so. */
	const visible = $derived(!usageWidget.hidden && (feed.agents?.length ?? 0) > 0);
	const label = $derived(
		[t.usage.widget, ...entries.map((entry) => `${usageAccountName(entry.agent, entry.account, t)} ${usageSummary(entry.account, t)}`)].join('; ')
	);

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
	let pillEl = $state<HTMLButtonElement | null>(null);
	let panelEl = $state<HTMLElement | null>(null);
	let menuEl = $state<HTMLElement | null>(null);
	let pillW = $state(0);
	let pillH = $state(0);

	let pointing = $state(false);
	let focused = $state(false);
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;
	let menuAt = $state<{ x: number; y: number } | null>(null);

	let press: { id: number; x: number; y: number; dx: number; dy: number; moved: boolean } | null = null;
	let dragAt = $state<{ left: number; top: number } | null>(null);
	let swallowClick = false;

	const place = $derived(usageWidget.place);
	const docked = $derived(dragAt ? null : place.dock);
	const tucked = $derived(docked !== null && !pointing && !focused && !usageWidget.open && menuAt === null);
	const top = $derived(dragAt ? dragAt.top : Math.round(place.top * Math.max(0, viewH - pillH)));
	const left = $derived.by(() => {
		if (dragAt) return dragAt.left;
		if (place.dock === null) return Math.round(place.left * Math.max(0, viewW - pillW));
		return place.dock === 'left' ? 0 : Math.max(0, viewW - pillW);
	});
	const shift = $derived(!tucked ? 0 : docked === 'right' ? pillW - SLIVER_PX : -(pillW - SLIVER_PX));

	function onPointerEnter(): void {
		clearTimeout(leaveTimer);
		pointing = true;
	}

	function onPointerLeave(): void {
		clearTimeout(leaveTimer);
		// A moment's grace, so brushing past the edge does not snap it in and out.
		leaveTimer = setTimeout(() => (pointing = false), 700);
	}

	/** Only a keyboard's focus keeps it out: a click focuses the pill in some engines, and it should still tuck. */
	function onFocusIn(event: FocusEvent): void {
		try {
			focused = (event.target as Element).matches(':focus-visible');
		} catch {
			focused = true;
		}
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.button !== 0 || !pillEl) return;
		const box = pillEl.getBoundingClientRect();
		press = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false };
		pillEl.setPointerCapture?.(event.pointerId);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!press || event.pointerId !== press.id) return;
		if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_PX) return;
		press.moved = true;
		usageWidget.open = false;
		dragAt = {
			left: Math.min(Math.max(0, event.clientX - press.dx), Math.max(0, viewW - pillW)),
			top: Math.min(Math.max(0, event.clientY - press.dy), Math.max(0, viewH - pillH))
		};
	}

	function onPointerUp(event: PointerEvent): void {
		if (!press || event.pointerId !== press.id) return;
		const moved = press.moved;
		press = null;
		if (!moved || !dragAt) return;
		usageWidget.move(usageDrop(dragAt.left, dragAt.top, pillW, pillH, viewW, viewH));
		dragAt = null;
		swallowClick = true;
	}

	function onPointerCancel(): void {
		press = null;
		dragAt = null;
	}

	function onClick(): void {
		if (swallowClick) {
			swallowClick = false;
			return;
		}
		usageWidget.open = !usageWidget.open;
	}

	function onContextMenu(event: MouseEvent): void {
		event.preventDefault();
		usageWidget.open = false;
		menuAt = { x: event.clientX, y: event.clientY };
	}

	function hide(): void {
		menuAt = null;
		usageWidget.hide();
	}

	function close(): void {
		usageWidget.open = false;
		pillEl?.focus();
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		if (menuAt) {
			event.preventDefault();
			event.stopPropagation();
			menuAt = null;
			pillEl?.focus();
		} else if (usageWidget.open) {
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	}

	function onWindowPointerDown(event: PointerEvent): void {
		const target = event.target as Node | null;
		if (menuAt && isOutside(target, menuEl)) menuAt = null;
		if (usageWidget.open && isOutside(target, panelEl, pillEl) && !(target instanceof Element && target.closest('[data-tools-usage]'))) usageWidget.open = false;
	}

	/**
	 * The panel beside the pill, on the roomier side, under it unless there is more room above. Placed
	 * from where the pill rests, not where it is drawn: it may still be sliding out of its tuck.
	 */
	function placePanel(): void {
		if (!panelEl) return;
		const box = panelEl.getBoundingClientRect();
		// No pill to hang from (nothing in use, or hidden): where the pill would stand, top right.
		const pill = visible ? { left, top, right: left + pillW, bottom: top + pillH } : { left: viewW - MARGIN, top: MARGIN, right: viewW - MARGIN, bottom: 48 };
		const fromRight = (pill.left + pill.right) / 2 > viewW / 2;
		const x = fromRight ? pill.right - box.width : pill.left;
		const below = pill.bottom + 6;
		const above = pill.top - box.height - 6;
		const y = below + box.height <= viewH - MARGIN || below > viewH - pill.bottom ? below : above;
		panelEl.style.left = `${Math.max(MARGIN, Math.min(x, viewW - box.width - MARGIN))}px`;
		panelEl.style.top = `${Math.max(MARGIN, Math.min(y, viewH - box.height - MARGIN))}px`;
	}

	$effect(() => {
		if (!usageWidget.open || !panelEl) return;
		panelEl.focus({ preventScroll: true });
	});

	$effect(() => {
		if (!usageWidget.open || !panelEl) return;
		// Moves with the pill and the window, and again as the panel's own height changes.
		void [left, top, pillW, pillH, viewW, viewH];
		placePanel();
		const observer = new ResizeObserver(() => placePanel());
		observer.observe(panelEl);
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
</script>

<svelte:window bind:innerWidth={viewW} bind:innerHeight={viewH} onpointerdowncapture={onWindowPointerDown} />

{#if visible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={wrapEl}
		class="usage-widget is-{usageLevel(worst)}"
		class:is-docked-left={docked === 'left'}
		class:is-docked-right={docked === 'right'}
		class:is-tucked={tucked}
		class:is-dragging={dragAt !== null}
		class:is-measuring={pillW === 0}
		style:left="{left}px"
		style:top="{top}px"
		style:transform="translateX({shift}px)"
		data-usage-widget
		data-dock={docked ?? 'free'}
		data-tucked={tucked ? 'yes' : 'no'}
		onpointerenter={onPointerEnter}
		onpointerleave={onPointerLeave}
		onfocusin={onFocusIn}
		onfocusout={(event) => {
			if (!wrapEl?.contains(event.relatedTarget as Node | null)) focused = false;
		}}
		onkeydown={onKeyDown}
		bind:offsetWidth={pillW}
		bind:offsetHeight={pillH}
	>
		<button
			bind:this={pillEl}
			type="button"
			class="usage-pill"
			aria-label={label}
			title={usageWidget.open ? t.usage.close : t.usage.show}
			aria-haspopup="dialog"
			aria-expanded={usageWidget.open}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerCancel}
			onclick={onClick}
			oncontextmenu={onContextMenu}
		>
			<span class="usage-grip" aria-hidden="true"></span>
			{#if shown.length > 0}
				{#each shown as entry (`${entry.agent.runner}:${entry.agent.custom_id ?? ''}:${entry.account.config_dir ?? ''}`)}
					<span class="usage-pill-item" data-usage-pill-item={entry.agent.runner}>
						<AgentLogo runner={entry.agent.runner} size={12} />
						<UsageRing percent={entry.tightest.percent} size={13} />
						<span class="usage-pill-left is-{usageLevel(entry.tightest.percent)}">{usageLeftText(entry.tightest.percent)}</span>
					</span>
				{/each}
				{#if extra > 0}<span class="usage-pill-more" title={t.usage.more(extra)}>+{extra}</span>{/if}
			{:else}
				<!-- Only agents with today's records: a gauge, no percentage to give. -->
				<svg class="usage-pill-gauge" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 14l4-4"></path>
					<path d="M3.34 19a10 10 0 1 1 17.32 0"></path>
				</svg>
			{/if}
		</button>
	</div>
{/if}

{#if usageWidget.open && feed.agents !== null}
	<div bind:this={panelEl} class="usage-panel" role="dialog" aria-label={t.usage.title} tabindex="-1" onkeydown={onKeyDown} data-usage-panel>
		<h2 class="usage-panel-title">{t.usage.title}</h2>
		<UsagePanelBody agents={feed.agents} {t} {locale} now={feed.now} busy={feed.busy} failed={feed.failed} onRefresh={() => client && void feed.load(client, true)} />
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
		transition: transform 0.18s ease;
		touch-action: none;
	}

	/* Tucking waits a beat after the pointer leaves; coming out does not. */
	.usage-widget.is-tucked {
		transition: transform 0.22s ease 0.1s;
	}

	/* Before its width is known it would slide in from the edge's wrong side: it waits unseen. */
	.usage-widget.is-dragging,
	.usage-widget.is-measuring {
		transition: none;
	}

	.usage-widget.is-measuring {
		visibility: hidden;
	}

	.usage-pill {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 28px;
		padding: 0 10px 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		box-shadow: var(--shadow-md);
		color: var(--ink);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		cursor: grab;
		user-select: none;
		-webkit-user-select: none;
	}

	.usage-widget.is-dragging .usage-pill {
		cursor: grabbing;
		box-shadow: var(--shadow-lg);
	}

	.usage-widget.is-warn .usage-pill {
		border-color: var(--warn);
	}

	.usage-widget.is-danger .usage-pill {
		border-color: var(--danger);
	}

	/* Docked: flat against the edge, round on the inside. */
	.is-docked-right .usage-pill {
		border-right: 0;
		border-radius: var(--radius-full) 0 0 var(--radius-full);
		padding-right: 12px;
	}

	.is-docked-left .usage-pill {
		flex-direction: row-reverse;
		border-left: 0;
		border-radius: 0 var(--radius-full) var(--radius-full) 0;
		padding: 0 6px 0 12px;
	}

	/* The sliver a tucked pill keeps in view: a handle in the colour of its tightest window. */
	.usage-grip {
		flex: none;
		width: 3px;
		height: 14px;
		border-radius: var(--radius-full);
		background: var(--line);
	}

	.usage-widget.is-warn .usage-grip {
		background: var(--warn);
	}

	.usage-widget.is-danger .usage-grip {
		background: var(--danger);
	}

	.usage-pill-item {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.usage-pill-left.is-warn {
		color: var(--warn-text);
	}

	.usage-pill-left.is-danger {
		color: var(--danger-text);
	}

	.usage-pill-more,
	.usage-pill-gauge {
		color: var(--muted);
	}

	.usage-panel {
		position: fixed;
		z-index: 95;
		width: 340px;
		max-width: calc(100vw - 16px);
		max-height: min(70vh, calc(100dvh - 16px));
		overflow-y: auto;
		padding: 12px 14px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
		outline: none;
	}

	.usage-panel-title {
		margin: 0 0 12px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
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
</style>
