<script lang="ts">
	import { untrack } from 'svelte';
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
	 * A project session's account, model and thinking level (ADR 0095) in one picker that cascades
	 * a level at a time: it opens on the accounts alone, and a row opens what is under it beside it
	 * (an account its models, a model the levels it takes) when it is pointed at or clicked. Only a
	 * row with nothing under it — a level, or a model that takes none — is a pick: it takes the
	 * path up to it and closes. On a phone a sheet from the bottom that goes into a row the same
	 * way, a level at a time, Back going up one. A Codex session (ADR 0099) has no account to pick:
	 * the picker starts at the models Codex lists.
	 */
	type Level = 'account' | 'model' | 'effort';

	/** Each column's width, so the field can keep room for every column that may open beside the first. */
	const COLUMN_WIDTH: Record<Level, number> = { account: 264, model: 290, effort: 140 };
	const COLUMN_GAP = 4;

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
	/** How far the path is open: the columns side by side, or how deep the phone's sheet has gone. One is the first level alone. */
	let depth = $state(1);
	/** The column the arrow keys move in, and whether they moved last (its row is ringed then, not under a pointer). */
	let active = $state<Level>('model');
	let keyed = $state(false);
	/** Which way the phone's sheet went last, for the way its list slides in. */
	let sheetStep = $state<'forward' | 'back'>('forward');
	/** The width every column that may open takes, kept from the start so opening one never moves the others. */
	let reserve = 0;

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
	/** Every level along the path in focus; the ones open are the first `depth`. */
	const levels = $derived(
		[accounts ? 'account' : null, 'model', effortsShown(focusList, focusModel, keptEffort) ? 'effort' : null].filter((level): level is Level => level !== null)
	);
	const shown = $derived(levels.slice(0, Math.max(1, depth)));
	/** The level the phone's sheet lists: the deepest one open. */
	const sheetLevel = $derived(shown[shown.length - 1]!);

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

	/** The phone sheet's heading a level down: the row it went into (an account, a model). At the top, whose session it is. */
	const sheetTitle = $derived.by(() => {
		const at = shown.length - 1;
		if (at === 0) return agentName;
		const parent = shown[at - 1]!;
		return rowsOf(parent).find((row) => row.value === focusOf(parent))?.label ?? agentName;
	});

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

	/** Where a level sits along the path: its column, counted from the first. */
	function columnOf(level: Level): number {
		return levels.indexOf(level);
	}

	/** Puts the path through a row and opens what is under it, if anything: its column beside it, or the sheet a level down. */
	function openAt(level: Level, value: string): void {
		focusAt(level, value);
		const at = columnOf(level);
		depth = opensMore(level, value) ? at + 2 : at + 1;
	}

	/** The column `level` opens on its own path's row, or the first one that can be taken when that row is not in it. */
	function landIn(level: Level): void {
		const rows = rowsOf(level);
		if (!rows.some((row) => row.value === focusOf(level) && !row.disabled)) step(level, 'first');
	}

	function openPicker(): void {
		if (disabled || open) return;
		focusAccount = tune.account;
		focusModel = tune.model;
		focusEffort = tune.effort;
		depth = 1;
		active = levels[0]!;
		keyed = false;
		sheetStep = 'forward';
		if (!phone.current && triggerEl) {
			const rect = triggerEl.getBoundingClientRect();
			const below = window.innerHeight - rect.bottom;
			placeAbove = below < 280 && rect.top > below;
			// Room for every column that may open: another account's models may take levels, so with accounts the levels count too.
			const mayTakeLevels = Boolean(accounts) || models.some((row) => opensMore('model', row.value));
			const widths = [accounts ? COLUMN_WIDTH.account : 0, COLUMN_WIDTH.model, mayTakeLevels ? COLUMN_WIDTH.effort : 0].filter(Boolean);
			reserve = widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * (widths.length - 1);
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

	/** A click or a tap: a row with something under it opens it (the sheet goes into it); a row with nothing under it is the pick. */
	function press(level: Level, row: TuneRow): void {
		if (row.disabled) return;
		clearTimeout(hoverTimer);
		active = level;
		if (opensMore(level, row.value)) {
			sheetStep = 'forward';
			openAt(level, row.value);
			return;
		}
		focusAt(level, row.value);
		commit(level);
	}

	/** The phone sheet's Back: one level up. */
	function sheetBack(): void {
		sheetStep = 'back';
		depth = Math.max(1, shown.length - 1);
	}

	/**
	 * Pointing opens what is under a row after a moment, so a slanting path from a row to the column
	 * beside it does not open every row it crosses: a row pointed at before then takes over.
	 */
	const HOVER_INTENT_MS = 90;
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;

	function hover(level: Level, row: TuneRow): void {
		if (row.disabled) return;
		clearTimeout(hoverTimer);
		keyed = false;
		if (level === 'effort') {
			active = level;
			focusEffort = row.value;
			return;
		}
		// Back on the row whose column is open: it stays open, and so does anything beyond it.
		const at = columnOf(level);
		if (row.value === focusOf(level) && depth >= (opensMore(level, row.value) ? at + 2 : at + 1)) {
			active = level;
			return;
		}
		hoverTimer = setTimeout(() => {
			active = level;
			openAt(level, row.value);
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

	/** Right, or Enter on a row with something under it: its column opens and the keys go into it. */
	function enter(): boolean {
		const at = columnOf(active);
		if (at < 0 || !opensMore(active, focusOf(active))) return false;
		depth = at + 2;
		active = levels[at + 1]!;
		landIn(active);
		return true;
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
		const at = columnOf(active);
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
				// Another row: what was open beside the one before closes.
				depth = at + 1;
				return;
			case 'ArrowRight':
				event.preventDefault();
				enter();
				return;
			case 'ArrowLeft':
				// Back a column, closing the one the keys were in.
				event.preventDefault();
				if (at > 0) {
					depth = at;
					active = levels[at - 1]!;
				}
				return;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (!enter()) commit(active);
				return;
		}
	}

	// A column the keys were in can go: the model in focus may take no level.
	$effect(() => {
		if (open && !shown.includes(active)) active = shown[shown.length - 1]!;
	});

	/**
	 * In the top layer, against the window: over the field (or under it), as tall as the room there,
	 * and far enough left that every column that may open fits in the window, so a column opening
	 * never moves the ones before it.
	 */
	function place(): void {
		const el = panelEl;
		if (!el || !triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
		const room = placeAbove ? rect.top - 12 : window.innerHeight - rect.bottom - 12;
		el.style.setProperty('--tune-height', `${Math.max(220, Math.min(640, room))}px`);
		el.style.maxWidth = `${viewportWidth - 16}px`;
		el.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - 8 - reserve))}px`;
		if (placeAbove) {
			el.style.top = 'auto';
			el.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		} else {
			el.style.bottom = 'auto';
			el.style.top = `${rect.bottom + 4}px`;
		}
		// Not read by the effect that shows the panel: a hover moving the path would take it out of the top layer and back.
		untrack(lineUp);
	}

	/**
	 * The first column sits on the field's edge; each one after it opens beside the row it came
	 * from, its first row level with that row, and moves back into the room over (or under) the
	 * field when it would not fit there. Each column is placed before the next one reads its row.
	 * The panel's opening scale skews what is read while it plays; it lines up again at its end.
	 */
	function lineUp(): void {
		const el = panelEl;
		if (!el || !triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const top = placeAbove ? 8 : rect.bottom + 4;
		const bottom = placeAbove ? rect.top - 4 : window.innerHeight - 8;
		shown.forEach((level, at) => {
			const column = el.querySelector<HTMLElement>(`[data-tune-column="${level}"]`);
			if (!column) return;
			const box = column.getBoundingClientRect();
			let columnTop = placeAbove ? bottom - box.height : top;
			const parent = at > 0 ? shown[at - 1]! : null;
			const row = parent ? document.getElementById(rowId(parent, focusOf(parent))) : null;
			const list = column.querySelector('.tune-list');
			if (row && list) {
				// Where this card's rows start below its top.
				const lead = list.getBoundingClientRect().top - box.top;
				columnTop = Math.max(top, Math.min(row.getBoundingClientRect().top - lead, bottom - box.height));
			}
			const shift = Math.max(0, placeAbove ? bottom - columnTop - box.height : columnTop - top);
			column.style.marginBottom = placeAbove ? `${shift}px` : '';
			column.style.marginTop = placeAbove ? '' : `${shift}px`;
		});
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

	// A column opening or closing, the path moving to another row, or a list's rows changing (another account's models coming in) lines the columns up again.
	$effect(() => {
		if (!open || phone.current) return;
		for (const level of shown) rowsOf(level);
		lineUp();
	});

	$effect(() => {
		if (!open || phone.current) return;
		const outside = (event: PointerEvent) => {
			if (containerEl && !containerEl.contains(event.target as Node)) close(false);
		};
		const blur = () => close(false);
		const reposition = (event: Event) => {
			// A list scrolling inside: the column beside it follows its row.
			if (panelEl && event.target instanceof Node && panelEl.contains(event.target)) lineUp();
			else place();
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
			onanimationend={lineUp}
		>
			{#each shown as level, at (level)}
				<div class="tune-column is-{level}" style:width="{COLUMN_WIDTH[level]}px" data-tune-column={level}>
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
								class:is-focus={at < shown.length - 1 && row.value === focusOf(level)}
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
			title={sheetTitle}
			closeLabel={t.common.close}
			onClose={() => close()}
			onBack={shown.length > 1 ? sheetBack : undefined}
			backLabel={t.common.back}
		>
			{@const level = sheetLevel}
			<div class="tune-sheet">
				{#key `${shown.length}:${level}`}
					<div class="tune-sheet-step" class:is-back={sheetStep === 'back'}>
						<div class="tune-sheet-heading" aria-hidden="true">{headingOf(level)}</div>
						<ul class="tune-sheet-list" role="listbox" aria-label={headingOf(level)} data-tune-column={level}>
							{#each rowsOf(level) as row (row.value)}
								{@const checked = row.value === checkedOf(level)}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<li
									class="sheet-item"
									class:is-disabled={row.disabled}
									role="option"
									aria-selected={checked}
									aria-disabled={row.disabled}
									data-value={row.value}
									onclick={() => press(level, row)}
								>
									<span class="sheet-item-label">
										{row.label}
										{#if row.detail}<span class="sheet-item-detail">{row.detail}</span>{/if}
									</span>
									{#if checked}
										<Icon name="check" class="tune-check" />
									{/if}
									{#if opensMore(level, row.value)}
										<Icon name="chevron-right" class="tune-more" />
									{/if}
								</li>
							{/each}
						</ul>
						{#if level === 'account' && accountLocked}
							<p class="tune-note">{t.project.accountBusy}</p>
						{/if}
					</div>
				{/key}
			</div>
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

	/*
	 * The columns side by side, in the top layer: placed by `place()`. Each is a card of its own, as
	 * tall as its rows, the first on the edge by the field (the foot when it opens upwards); a margin
	 * from `lineUp()` moves each one after it beside the row it came from, so a column opening never
	 * moves the ones before it. The room around the cards is not the picker's: a click there is outside.
	 */
	.tune-panel {
		position: absolute;
		left: 0;
		bottom: calc(100% + 4px);
		z-index: 100;
		display: flex;
		align-items: flex-end;
		gap: 4px;
		width: max-content;
		background: transparent;
		color: var(--ink);
		border: 0;
		box-sizing: border-box;
		overflow: visible;
		pointer-events: none;
		animation: tuneIn 0.14s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.tune-panel:popover-open {
		position: fixed;
		inset: auto;
		margin: 0;
		padding: 0;
	}

	.tune-panel:not(.is-above) {
		align-items: flex-start;
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

	/* Widths come from `COLUMN_WIDTH`, which `place()` keeps room for. */
	.tune-column {
		display: flex;
		flex-direction: column;
		flex: none;
		min-width: 0;
		max-height: var(--tune-height, 360px);
		padding: 4px;
		box-sizing: border-box;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		pointer-events: auto;
	}

	/* A column opening beside the one before it comes out of it. */
	.tune-column + .tune-column {
		animation: tuneColumnIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes tuneColumnIn {
		from { opacity: 0; transform: translateX(-6px); }
		to { opacity: 1; transform: none; }
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

	/* The row under the pointer, and the row whose column is open beside it: the path so far. */
	.tune-row:hover:not(.is-disabled),
	.tune-row.is-focus {
		background: var(--line-subtle);
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

	/* A level down the phone's sheet slides in from the side it went to, inside the sheet. */
	.tune-sheet {
		overflow: hidden;
	}

	.tune-sheet-step {
		animation: tuneStepIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.tune-sheet-step.is-back {
		animation-name: tuneStepBack;
	}

	@keyframes tuneStepIn {
		from { opacity: 0; transform: translateX(20px); }
	}

	@keyframes tuneStepBack {
		from { opacity: 0; transform: translateX(-20px); }
	}

	.tune-sheet-heading {
		padding: 2px 12px 6px;
		font-size: 12px;
		line-height: 1.3;
		color: var(--muted);
		user-select: none;
		-webkit-user-select: none;
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
		.tune-panel,
		.tune-column + .tune-column,
		.tune-sheet-step {
			animation: none;
		}
	}
</style>
