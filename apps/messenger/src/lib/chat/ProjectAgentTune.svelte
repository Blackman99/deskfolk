<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import type { ClaudeCodeModel, PatchProjectSessionRequest, ProjectAgent } from '@real-bot/protocol';
	import BottomSheet from '../BottomSheet.svelte';
	import Icon from '../Icon.svelte';
	import ModelSourceMark from '../ModelSourceMark.svelte';
	import { PHONE_SHEET_QUERY } from '../bottom-sheet.ts';
	import { claudeModelsOf, loadClaudeModels, modelChoices, modelRowOf, type Choice } from '../claude-models.svelte.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { runnerSource } from '../model-source.ts';
	import { effortOn, effortRows, effortsShown, modelRows, tunePatch, type AgentTune, type TuneRow } from './project-agent-tune.ts';

	/**
	 * A project session's account, model and thinking level (ADR 0095) in one picker that cascades:
	 * the accounts, the models of the one in focus, the levels of the model in focus, each column
	 * opening beside the one before it, the session's own path open from the start. Pointing at a
	 * row opens what is under it; a click takes the path up to that row and closes. On a phone a
	 * sheet from the bottom: the three, each with what it is now, and a level of its own for each.
	 * A Codex session (ADR 0099) has no account to pick: its models are the ones Codex lists.
	 */
	type Level = 'account' | 'model' | 'effort';

	type Props = {
		t: Copy;
		/** Whose session it is: its name and mark on the picker. */
		agent: ProjectAgent;
		tune: AgentTune;
		/** The agent's own models when it is not Claude Code (Codex's, as it lists them); left out, Claude Code's for the account. */
		models?: ClaudeCodeModel[];
		/** Your accounts, with a second one to pick; null leaves the account out. */
		accounts: Choice[] | null;
		/** A run is going: the account waits for it to end. */
		accountLocked: boolean;
		disabled: boolean;
		client: Pick<MessengerApi, 'claudeCodeModels'> | null;
		onpick: (change: PatchProjectSessionRequest) => void;
	};

	let { t, agent, tune, models: ownModels, accounts, accountLocked, disabled, client, onpick }: Props = $props();
	const agentName = $derived(t.project.agentNames[agent]);

	const phone = new MediaQuery(PHONE_SHEET_QUERY);
	const uid = $props.id();

	let containerEl = $state<HTMLDivElement | null>(null);
	let triggerEl = $state<HTMLButtonElement | null>(null);
	let panelEl = $state<HTMLDivElement | null>(null);
	let open = $state(false);
	let placeAbove = $state(true);
	/** The path in focus: what each column's highlighted row is, and so what the next column lists. */
	let focusAccount = $state('');
	let focusModel = $state('');
	let focusEffort = $state('');
	/** The column the arrow keys move in, and whether they moved last (its row is ringed then, not under a pointer). */
	let active = $state<Level>('model');
	let keyed = $state(false);
	/** Where the phone's sheet is: the three (null), or one of them. */
	let sheetLevel = $state<Level | null>(null);
	/** A finger has no pointing: its first tap on a row with a column beside it opens that column. */
	let touching = false;

	const nowList = $derived(ownModels ?? claudeModelsOf(tune.account || null));
	const focusList = $derived(ownModels ?? claudeModelsOf(focusAccount || null));
	/** The level the session keeps on a model: its own on its own model, else its own only if that model takes it. */
	const keptOn = (model: string) => (model === tune.model ? tune.effort : effortOn(focusList, model, tune.effort));
	const keptEffort = $derived(keptOn(focusModel));

	const accountRows = $derived(
		(accounts ?? []).map((row): TuneRow => ({ ...row, disabled: accountLocked && row.value !== tune.account }))
	);
	const models = $derived(modelRows(focusList, tune.model, t.project.modelDefault, t.project.modelDefaultHint(agentName)));
	const efforts = $derived(effortRows(focusList, focusModel, keptEffort, t.project.effortDefault, t.sidebar.thinkingLevels));
	const levels = $derived(
		[accounts ? 'account' : null, 'model', effortsShown(focusList, focusModel, keptEffort) ? 'effort' : null].filter((level): level is Level => level !== null)
	);

	function rowsOf(level: Level): TuneRow[] {
		return level === 'account' ? accountRows : level === 'model' ? models : efforts;
	}

	function headingOf(level: Level): string {
		return level === 'account' ? t.project.accountLabel : level === 'model' ? t.project.modelLabel : t.project.effortLabel;
	}

	/** The checked row of each column: what the session would have after taking the path up to it. */
	function checkedOf(level: Level): string {
		return level === 'account' ? tune.account : level === 'model' ? tune.model : keptEffort;
	}

	function focusOf(level: Level): string {
		return level === 'account' ? focusAccount : level === 'model' ? focusModel : focusEffort;
	}

	/** Whether a row has a column beside it: every account has its models, a model the levels it takes. */
	function opensMore(level: Level, value: string): boolean {
		if (level === 'account') return true;
		return level === 'model' && effortsShown(focusList, value, keptOn(value));
	}

	// What the closed picker says: the model and its level; the account after them, quieter, cut first.
	const modelLabel = $derived(modelChoices(nowList, tune.model, t.project.modelDefault).find((row) => row.value === tune.model)?.label ?? tune.model);
	const modelNote = $derived(modelRowOf(nowList, tune.model)?.description || (tune.model ? undefined : t.project.modelDefaultHint(agentName)));
	const effortShown = $derived(effortsShown(nowList, tune.model, tune.effort));
	const effortLabel = $derived(tune.effort ? (t.sidebar.thinkingLevels[tune.effort as keyof typeof t.sidebar.thinkingLevels] ?? tune.effort) : t.project.effortDefault);
	const accountLabel = $derived(accounts?.find((row) => row.value === tune.account)?.label ?? null);
	const triggerTitle = $derived(
		[accountLabel, modelNote ? `${modelLabel} · ${modelNote}` : modelLabel, effortShown ? effortLabel : null].filter(Boolean).join('\n')
	);

	function labelOf(level: Level): string {
		return level === 'account' ? (accountLabel ?? '') : level === 'model' ? modelLabel : effortLabel;
	}

	function focusAt(level: Level, value: string): void {
		if (level === 'account') {
			if (value === focusAccount) return;
			focusAccount = value;
			loadClaudeModels(client, value || null);
			focusModel = tune.model;
			focusEffort = tune.effort;
		} else if (level === 'model') {
			focusModel = value;
			focusEffort = keptOn(value);
		} else {
			focusEffort = value;
		}
	}

	function openPicker(): void {
		if (disabled || open) return;
		focusAccount = tune.account;
		focusModel = tune.model;
		focusEffort = tune.effort;
		active = 'model';
		keyed = false;
		sheetLevel = levels.length === 1 ? 'model' : null;
		if (!phone.current && triggerEl) {
			const rect = triggerEl.getBoundingClientRect();
			const below = window.innerHeight - rect.bottom;
			placeAbove = below < 280 && rect.top > below;
			// The keys are read on the field, and WebKit does not focus a button it was clicked on.
			triggerEl.focus({ preventScroll: true });
		}
		open = true;
	}

	function close(focusTrigger = true): void {
		if (!open) return;
		clearTimeout(hoverTimer);
		open = false;
		// A phone has no focus ring to put back, and focusing the field can scroll the page under it.
		if (focusTrigger && !phone.current) triggerEl?.focus({ preventScroll: true });
	}

	/** Takes the path in focus up to `level`, as one change. */
	function commit(level: Level): void {
		const picked =
			level === 'account'
				? { account: focusAccount }
				: level === 'model'
					? { account: focusAccount, model: focusModel }
					: { account: focusAccount, model: focusModel, effort: focusEffort };
		const change = tunePatch(tune, picked, focusList);
		close();
		if (change) onpick(change);
	}

	function press(level: Level, row: TuneRow): void {
		if (row.disabled) return;
		clearTimeout(hoverTimer);
		active = level;
		if (touching && !phone.current && row.value !== focusOf(level) && opensMore(level, row.value)) {
			focusAt(level, row.value);
			return;
		}
		focusAt(level, row.value);
		commit(level);
	}

	/**
	 * Pointing opens what is under a row after a moment, so a slanting path from a row to the column
	 * beside it does not open every row it crosses: a row pointed at before then takes over.
	 */
	const HOVER_INTENT_MS = 90;
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;

	function hover(level: Level, row: TuneRow): void {
		if (row.disabled || touching) return;
		clearTimeout(hoverTimer);
		keyed = false;
		if (level === 'effort') {
			active = level;
			focusEffort = row.value;
			return;
		}
		if (row.value === focusOf(level)) return;
		hoverTimer = setTimeout(() => {
			active = level;
			focusAt(level, row.value);
		}, HOVER_INTENT_MS);
	}

	$effect(() => () => clearTimeout(hoverTimer));

	function step(level: Level, by: 1 | -1 | 'first' | 'last'): void {
		const rows = rowsOf(level);
		if (rows.length === 0) return;
		const from = rows.findIndex((row) => row.value === focusOf(level));
		const order = by === 'first' ? rows.map((_, i) => i) : by === 'last' ? rows.map((_, i) => rows.length - 1 - i) : rows.map((_, i) => (from + by * (i + 1) + rows.length * 2) % rows.length);
		const next = order.map((i) => rows[i]!).find((row) => !row.disabled);
		if (next) focusAt(level, next.value);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (disabled) return;
		if (!open) {
			if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
				event.preventDefault();
				openPicker();
			}
			return;
		}
		if (phone.current) return;
		const at = levels.indexOf(active);
		if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) keyed = true;
		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				close();
				return;
			case 'Tab':
				close(false);
				return;
			case 'ArrowDown':
			case 'ArrowUp':
			case 'Home':
			case 'End':
				event.preventDefault();
				step(active, event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? 'first' : 'last');
				return;
			case 'ArrowRight':
				event.preventDefault();
				if (at >= 0 && at < levels.length - 1) active = levels[at + 1]!;
				return;
			case 'ArrowLeft':
				event.preventDefault();
				if (at > 0) active = levels[at - 1]!;
				return;
			case 'Enter':
			case ' ':
				event.preventDefault();
				commit(active);
				return;
		}
	}

	// A column the keys were in can go: the model in focus may take no level.
	$effect(() => {
		if (open && !levels.includes(active)) active = levels[levels.length - 1]!;
	});

	/** In the top layer, against the window: over the field (or under it), kept inside the window, as tall as the room there. */
	function place(): void {
		const el = panelEl;
		if (!el || !triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
		const room = placeAbove ? rect.top - 12 : window.innerHeight - rect.bottom - 12;
		el.style.setProperty('--tune-height', `${Math.max(220, Math.min(640, room))}px`);
		el.style.maxWidth = `${viewportWidth - 16}px`;
		const width = el.offsetWidth;
		el.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - 8 - width))}px`;
		if (placeAbove) {
			el.style.top = 'auto';
			el.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		} else {
			el.style.bottom = 'auto';
			el.style.top = `${rect.bottom + 4}px`;
		}
	}

	$effect(() => {
		const el = panelEl;
		if (!el || !open || typeof el.showPopover !== 'function') return;
		el.setAttribute('popover', 'manual');
		try {
			el.showPopover();
		} catch {
			// Already showing.
		}
		place();
		return () => {
			try {
				el.hidePopover();
			} catch {
				// Gone with it.
			}
			el.removeAttribute('popover');
		};
	});

	// A column opening or closing changes the panel's width.
	$effect(() => {
		void levels.length;
		void focusList;
		if (open) place();
	});

	$effect(() => {
		if (!open || phone.current) return;
		const outside = (event: PointerEvent) => {
			if (containerEl && !containerEl.contains(event.target as Node)) close(false);
		};
		const blur = () => close(false);
		const reposition = (event: Event) => {
			if (panelEl && event.target instanceof Node && panelEl.contains(event.target)) return;
			place();
		};
		document.addEventListener('pointerdown', outside);
		window.addEventListener('blur', blur);
		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', reposition, true);
		return () => {
			document.removeEventListener('pointerdown', outside);
			window.removeEventListener('blur', blur);
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', reposition, true);
		};
	});

	function rowId(level: Level, value: string): string {
		return `tune-${uid}-${level}-${value.replace(/[^\w-]/g, '_')}`;
	}
</script>

<div bind:this={containerEl} class="tune" class:is-open={open} class:is-disabled={disabled} data-project-tune>
	<button
		bind:this={triggerEl}
		type="button"
		class="tune-trigger"
		role="combobox"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls={open && !phone.current ? `tune-${uid}-${active}` : undefined}
		aria-activedescendant={open && !phone.current ? rowId(active, focusOf(active)) : undefined}
		aria-label={t.project.tuneLabel}
		title={triggerTitle}
		{disabled}
		onclick={() => (open ? close() : openPicker())}
		onkeydown={onKeydown}
	>
		<ModelSourceMark source={runnerSource(agent, agentName, t)} />
		<span class="tune-value">
			<span class="tune-model">{modelLabel}</span>
			{#if effortShown}
				<span class="tune-sep" aria-hidden="true">·</span>
				<span class="tune-effort">{effortLabel}</span>
			{/if}
			{#if accountLabel}
				<span class="tune-account">{accountLabel}</span>
			{/if}
		</span>
		<span class="tune-arrow" aria-hidden="true">
			<Icon name="chevron-down" size={12} />
		</span>
	</button>

	{#if open && !phone.current}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={panelEl}
			class="tune-panel"
			class:is-above={placeAbove}
			role="group"
			aria-label={t.project.tuneLabel}
			onpointerdown={(event) => (touching = event.pointerType === 'touch')}
		>
			{#each levels as level (level)}
				<div class="tune-column is-{level}" data-tune-column={level}>
					<div class="tune-heading" aria-hidden="true">{headingOf(level)}</div>
					<ul id={`tune-${uid}-${level}`} class="tune-list" role="listbox" aria-label={headingOf(level)}>
						{#each rowsOf(level) as row (row.value)}
							{@const checked = row.value === checkedOf(level)}
							{@const more = level !== 'effort' && opensMore(level, row.value)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<li
								id={rowId(level, row.value)}
								class="tune-row"
								class:is-checked={checked}
								class:is-focus={row.value === focusOf(level)}
								class:is-keyed={keyed && active === level && row.value === focusOf(level)}
								class:is-disabled={row.disabled}
								role="option"
								aria-selected={checked}
								aria-disabled={row.disabled}
								title={row.detail}
								data-value={row.value}
								onclick={() => press(level, row)}
								onmouseenter={() => hover(level, row)}
							>
								<span class="tune-row-text">
									<span class="tune-row-label">{row.label}</span>
									{#if row.detail && level === 'model'}<span class="tune-row-detail">{row.detail}</span>{/if}
								</span>
								{#if checked}
									<Icon name="check" size={12} class="tune-check" />
								{/if}
								{#if more}
									<Icon name="chevron-right" size={12} class="tune-more" />
								{/if}
							</li>
						{/each}
					</ul>
					{#if level === 'account' && accountLocked}
						<p class="tune-note">{t.project.accountBusy}</p>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if open && phone.current}
		<BottomSheet
			title={sheetLevel ? headingOf(sheetLevel) : agentName}
			closeLabel={t.common.close}
			onClose={() => close()}
			onBack={sheetLevel && levels.length > 1 ? () => (sheetLevel = null) : undefined}
			backLabel={t.common.back}
		>
			{#if sheetLevel === null}
				{#each levels as level (level)}
					<button type="button" class="sheet-item tune-sheet-nav" data-tune-level={level} onclick={() => (sheetLevel = level)}>
						<span class="sheet-item-label">
							{headingOf(level)}
							<span class="sheet-item-detail">{labelOf(level)}</span>
						</span>
						<Icon name="chevron-right" />
					</button>
				{/each}
				{#if accounts && accountLocked}
					<p class="tune-note">{t.project.accountBusy}</p>
				{/if}
			{:else}
				{@const level = sheetLevel}
				<ul class="tune-sheet-list" role="listbox" aria-label={headingOf(level)} data-tune-column={level}>
					{#each rowsOf(level) as row (row.value)}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<li
							class="sheet-item"
							class:is-disabled={row.disabled}
							role="option"
							aria-selected={row.value === checkedOf(level)}
							aria-disabled={row.disabled}
							data-value={row.value}
							onclick={() => press(level, row)}
						>
							<span class="sheet-item-label">
								{row.label}
								{#if row.detail}<span class="sheet-item-detail">{row.detail}</span>{/if}
							</span>
							{#if row.value === checkedOf(level)}
								<Icon name="check" />
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</BottomSheet>
	{/if}
</div>

<style>
	.tune {
		position: relative;
		min-width: 0;
		max-width: 460px;
		font-family: var(--font);
	}

	.tune-trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 10px;
		background: var(--input-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		font-family: inherit;
		font-size: 13px;
		line-height: 1.4;
		color: var(--ink);
		box-shadow: var(--shadow-xs);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
		box-sizing: border-box;
		user-select: none;
	}

	.tune-trigger:hover:not(:disabled) {
		border-color: var(--line-hover);
		background-color: var(--line-subtle);
	}

	.tune.is-open .tune-trigger,
	.tune-trigger:focus-visible {
		outline: none;
		border-color: var(--field-focus-border);
		box-shadow: var(--field-focus-ring);
		background-color: var(--input-bg);
	}

	.tune-trigger:disabled {
		opacity: 0.55;
		cursor: not-allowed;
		background: var(--line-subtle);
		box-shadow: none;
	}

	.tune-value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}

	.tune-sep {
		margin: 0 5px;
		color: var(--muted);
	}

	/* Whose account, after the model and its level: quieter, and the first to be cut. */
	.tune-account {
		margin-left: 8px;
		font-size: 12px;
		font-weight: 400;
		color: var(--muted);
	}

	.tune-arrow {
		display: inline-flex;
		flex: none;
		color: var(--muted);
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease;
	}

	.tune.is-open .tune-arrow {
		transform: rotate(180deg);
		color: var(--accent);
	}

	/* The columns side by side, in the top layer: placed by `place()`. */
	.tune-panel {
		position: absolute;
		left: 0;
		bottom: calc(100% + 4px);
		z-index: 100;
		display: flex;
		align-items: stretch;
		width: max-content;
		background: var(--pane);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		box-sizing: border-box;
		overflow: hidden;
		animation: tuneIn 0.14s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.tune-panel:popover-open {
		position: fixed;
		inset: auto;
		margin: 0;
		padding: 0;
	}

	.tune-panel:not(.is-above) {
		animation-name: tuneInBelow;
	}

	@keyframes tuneIn {
		from { opacity: 0; transform: translateY(4px) scale(0.99); }
		to { opacity: 1; transform: none; }
	}

	@keyframes tuneInBelow {
		from { opacity: 0; transform: translateY(-4px) scale(0.99); }
		to { opacity: 1; transform: none; }
	}

	.tune-column {
		display: flex;
		flex-direction: column;
		min-width: 0;
		max-height: var(--tune-height, 360px);
		padding: 4px;
		box-sizing: border-box;
	}

	.tune-column + .tune-column {
		border-left: 1px solid var(--line);
	}

	.tune-column.is-account {
		width: 264px;
		background: var(--line-subtle);
	}

	.tune-column.is-model {
		width: 290px;
	}

	.tune-column.is-effort {
		width: 140px;
	}

	.tune-heading {
		flex: none;
		padding: 6px 8px 4px;
		font-size: 11px;
		line-height: 1.3;
		color: var(--muted);
		user-select: none;
	}

	.tune-list {
		flex: 1;
		min-height: 0;
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	.tune-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		line-height: 1.35;
		color: var(--ink);
		cursor: pointer;
		user-select: none;
	}

	/* The path in focus: its row in each column stands out, as the source column of the model picker does. */
	.tune-row:hover:not(.is-disabled),
	.tune-row.is-focus {
		background: var(--pane);
		box-shadow: var(--shadow-xs);
	}

	.tune-column:not(.is-account) .tune-row:hover:not(.is-disabled),
	.tune-column:not(.is-account) .tune-row.is-focus {
		background: var(--line-subtle);
		box-shadow: none;
	}

	.tune-row.is-keyed {
		outline: 2px solid var(--accent-border);
		outline-offset: -2px;
	}

	.tune-row.is-checked {
		color: var(--accent);
	}

	.tune-row.is-disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.tune-row-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.tune-row-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}

	.tune-row.is-checked .tune-row-label {
		font-weight: 600;
	}

	.tune-row-detail {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--muted);
	}

	:global(.icon.tune-check) {
		flex: none;
		color: var(--accent);
	}

	:global(.icon.tune-more) {
		flex: none;
		color: var(--muted);
	}

	.tune-note {
		flex: none;
		margin: 4px 8px 4px;
		font-size: 11px;
		line-height: 1.4;
		color: var(--muted);
	}

	.tune-sheet-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tune-sheet-list .is-disabled {
		opacity: 0.45;
	}

	:global(.bottom-sheet-body) .tune-note {
		margin: 6px 12px;
		font-size: 12px;
	}

	@media (prefers-reduced-motion: reduce) {
		.tune-panel {
			animation: none;
		}
	}
</style>
