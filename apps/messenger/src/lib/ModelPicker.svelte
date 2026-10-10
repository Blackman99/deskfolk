<script lang="ts">
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Copy } from './copy.ts';
	import ModelSourceMark from './ModelSourceMark.svelte';
	import { holdBack } from './chat/message-text-pages.ts';
	import {
		findPicked,
		searchPicker,
		sourceCount,
		sourceRows,
		type PickerData,
		type PickerGroup,
		type PickerRow,
		type PickerSource
	} from './model-picker.ts';

	/**
	 * A model picker for more models than one list can carry: endpoints, Claude Code and your other
	 * local agents (ADR 0079), OpenCode's hundreds among them. On a wide window a popover: a search
	 * over everything, the rows that are not models across the top, then where models come from on
	 * the left and the models of the one under the pointer on the right, in groups. On a phone a
	 * sheet from the bottom, one level at a time — sources, a provider's group when there are many,
	 * models — with Back going up a level. A source that lists no models, or not the one you want,
	 * takes a name typed into the search when it says how (`PickerSource.custom`).
	 */
	type Props = {
		value?: string;
		data: PickerData;
		t: Copy;
		placeholder?: string;
		id?: string;
		ariaLabel?: string;
		/** The sheet's heading on a phone; the field's label. */
		title?: string;
		disabled?: boolean;
		error?: boolean;
		size?: 'default' | 'sm';
		class?: string;
		onchange?: (value: string) => void;
	};

	let {
		value = $bindable(''),
		data,
		t,
		placeholder = '',
		id,
		ariaLabel,
		title,
		disabled = false,
		error = false,
		size = 'default',
		class: className = '',
		onchange
	}: Props = $props();

	const uid = $props.id();
	const listId = `model-picker-${uid}`;
	const phone = new MediaQuery('(max-width: 720px)');

	let containerEl = $state<HTMLDivElement | null>(null);
	let triggerEl = $state<HTMLButtonElement | null>(null);
	let panelEl = $state<HTMLDivElement | null>(null);
	let sheetEl = $state<HTMLDivElement | null>(null);
	let searchEl = $state<HTMLInputElement | null>(null);
	let open = $state(false);
	let query = $state('');
	/** The source whose models the popover shows on the right. */
	let activeKey = $state<string | null>(null);
	/** Where the arrow keys are in the popover: the sources on the left, or the rows. */
	let column = $state<'sources' | 'rows'>('rows');
	let cursor = $state(0);
	let placeAbove = $state(false);
	/** Where the sheet is: its list of sources (null), a source, a group of a source's models. */
	let sheetSource = $state<string | null>(null);
	let sheetGroup = $state<string | null>(null);
	let sheetStep = $state<'forward' | 'back'>('forward');

	const picked = $derived(findPicked(data, value));
	const many = $derived(data.sources.length > 1);
	const usable = $derived(data.sources.filter((source) => !source.disabled));
	const activeSource = $derived(data.sources.find((source) => source.key === activeKey) ?? usable[0] ?? data.sources[0] ?? null);
	const sheetAt = $derived(data.sources.find((source) => source.key === sheetSource) ?? null);
	const sheetGroupAt = $derived(sheetAt?.groups.find((group) => group.key === sheetGroup) ?? null);
	/** Where a search looks: everything, or the source the sheet is in (a picker of one source: all of it, the rows above it too). */
	const scope = $derived(phone.current && many ? sheetSource : null);
	const trimmed = $derived(query.trim());
	const results = $derived(trimmed ? searchPicker(data, trimmed, scope) : []);
	/** The source a typed name would be for: the one in view, if it takes typed names. */
	const typingFor = $derived(phone.current ? sheetAt ?? (data.sources.length === 1 ? data.sources[0]! : null) : (many ? activeSource : data.sources[0] ?? null));
	const typedRow = $derived.by((): PickerRow | null => {
		const source = typingFor;
		if (!trimmed || !source?.custom || source.disabled) return null;
		if (sourceRows(source).some((row) => row.value === trimmed || row.label === trimmed)) return null;
		const typed = source.custom(trimmed);
		return typed === null ? null : { value: typed, label: t.modelPicker.useTyped(trimmed), detail: t.modelPicker.usesTyped(source.label) };
	});
	/** The rows the arrow keys walk in the popover, in the order they are drawn. */
	const rows = $derived.by((): PickerRow[] => {
		if (trimmed) return [...results.flatMap((result) => result.rows), ...(typedRow ? [typedRow] : [])];
		return [...data.specials, ...(activeSource ? sourceRows(activeSource) : [])];
	});
	const display = $derived(picked ? picked.row.label : value || placeholder);
	const displayHint = $derived(many && picked?.source ? picked.source.label : picked?.row.hint);

	/** A source shows its groups as a level of their own on the phone once it lists this many. */
	const SHEET_GROUPS_AT = 30;
	const groupsLevel = (source: PickerSource) => source.groups.length > 1 && sourceCount(source) > SHEET_GROUPS_AT;

	function rowId(index: number): string {
		return `${listId}-row-${index}`;
	}

	function enabledFrom(start: number, step: 1 | -1): number {
		for (let at = start; at >= 0 && at < rows.length; at += step) {
			if (!rows[at]!.disabled) return at;
		}
		return -1;
	}

	async function openPicker(): Promise<void> {
		if (disabled || open) return;
		query = '';
		column = 'rows';
		activeKey = picked?.source?.key ?? usable[0]?.key ?? data.sources[0]?.key ?? null;
		sheetGroup = null;
		sheetStep = 'forward';
		sheetSource = many ? null : (data.sources[0]?.key ?? null);
		if (!phone.current && triggerEl) {
			const rect = triggerEl.getBoundingClientRect();
			placeAbove = window.innerHeight - rect.bottom < 320 && rect.top > window.innerHeight - rect.bottom;
		}
		open = true;
		const at = rows.findIndex((row) => row.value === value);
		cursor = at >= 0 ? at : Math.max(0, enabledFrom(0, 1));
		await tick();
		if (!phone.current) {
			searchEl?.focus({ preventScroll: true });
			scrollRowIntoView(cursor);
		} else {
			sheetEl?.querySelector<HTMLElement>('.mp-sheet')?.focus({ preventScroll: true });
		}
	}

	function close(focusTrigger = true): void {
		if (!open) return;
		open = false;
		query = '';
		if (focusTrigger && !phone.current) triggerEl?.focus({ preventScroll: true });
	}

	function choose(row: PickerRow): void {
		if (row.disabled) return;
		const changed = row.value !== value;
		value = row.value;
		close();
		if (changed) onchange?.(row.value);
	}

	function scrollRowIntoView(index: number): void {
		const el = panelEl?.querySelector<HTMLElement>(`#${CSS.escape(rowId(index))}`);
		el?.scrollIntoView?.({ block: 'nearest' });
	}

	function activate(source: PickerSource): void {
		if (source.disabled) return;
		activeKey = source.key;
		cursor = enabledFrom(data.specials.length, 1);
	}

	function moveSource(step: 1 | -1): void {
		const list = data.sources;
		let at = list.findIndex((source) => source.key === activeSource?.key);
		for (let i = 0; i < list.length; i++) {
			at = (at + step + list.length) % list.length;
			if (!list[at]!.disabled) {
				activate(list[at]!);
				panelEl?.querySelector<HTMLElement>(`[data-source-key="${CSS.escape(list[at]!.key)}"]`)?.scrollIntoView?.({ block: 'nearest' });
				return;
			}
		}
	}

	function onSearchKeydown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp': {
				event.preventDefault();
				const step = event.key === 'ArrowDown' ? 1 : -1;
				if (column === 'sources' && !trimmed) {
					moveSource(step);
					return;
				}
				const next = enabledFrom(cursor + step, step);
				if (next >= 0) {
					cursor = next;
					scrollRowIntoView(next);
				}
				return;
			}
			case 'ArrowLeft':
				if (!trimmed && many) {
					event.preventDefault();
					column = 'sources';
				}
				return;
			case 'ArrowRight':
				if (!trimmed && column === 'sources') {
					event.preventDefault();
					column = 'rows';
					cursor = Math.max(0, enabledFrom(data.specials.length, 1));
				}
				return;
			case 'Enter': {
				event.preventDefault();
				if (column === 'sources' && !trimmed) {
					column = 'rows';
					cursor = Math.max(0, enabledFrom(data.specials.length, 1));
					return;
				}
				const row = rows[cursor];
				if (row) choose(row);
				return;
			}
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				if (query) query = '';
				else close();
				return;
			case 'Tab':
				close(false);
				return;
		}
	}

	function onTriggerKeydown(event: KeyboardEvent): void {
		if (disabled || open) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			void openPicker();
		}
	}

	// A search moves the keys to the first row found; cleared, back to the model chosen.
	let searched = '';
	$effect(() => {
		const now = trimmed;
		if (!open || now === searched) return;
		searched = now;
		column = 'rows';
		const at = now ? -1 : rows.findIndex((row) => row.value === value);
		cursor = at >= 0 ? at : Math.max(0, enabledFrom(0, 1));
	});

	/** The popover in the top layer, against the window: under the field or over it, kept inside the window. */
	function place(): void {
		const el = panelEl;
		if (!el || !triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
		const wide = many ? 620 : Math.max(rect.width, 340);
		const width = Math.min(wide, viewportWidth - 16);
		el.style.width = `${width}px`;
		el.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - 8 - width))}px`;
		const room = placeAbove ? rect.top - 12 : window.innerHeight - rect.bottom - 12;
		el.style.maxHeight = `${Math.max(220, Math.min(460, room))}px`;
		if (placeAbove) {
			el.style.top = 'auto';
			el.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		} else {
			el.style.bottom = 'auto';
			el.style.top = `${rect.bottom + 4}px`;
		}
	}

	function showInTopLayer(el: HTMLElement): () => void {
		if (typeof el.showPopover !== 'function') return () => {};
		el.setAttribute('popover', 'manual');
		try {
			el.showPopover();
		} catch {
			// Already showing.
		}
		return () => {
			try {
				el.hidePopover();
			} catch {
				// Gone with it.
			}
			el.removeAttribute('popover');
		};
	}

	$effect(() => {
		const el = panelEl;
		if (!el || !open) return;
		const hide = showInTopLayer(el);
		place();
		return hide;
	});

	$effect(() => {
		const el = sheetEl;
		if (!el || !open) return;
		return showInTopLayer(el);
	});

	// The phone's Back walks up the sheet's levels, then closes it.
	$effect(() => {
		if (!open || !phone.current) return;
		return holdBack(() => sheetBack());
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

	function sheetInto(source: PickerSource): void {
		if (source.disabled) return;
		sheetStep = 'forward';
		sheetSource = source.key;
		sheetGroup = null;
		query = '';
	}

	function sheetIntoGroup(group: PickerGroup): void {
		sheetStep = 'forward';
		sheetGroup = group.key;
		query = '';
	}

	/** One level up; from the top (a picker of one source starts inside it), closed. */
	function sheetBack(): void {
		sheetStep = 'back';
		query = '';
		if (sheetGroup !== null) sheetGroup = null;
		else if (sheetSource !== null && many) sheetSource = null;
		else close();
	}

	const sheetTitle = $derived(sheetGroupAt?.label ?? sheetAt?.label ?? title ?? ariaLabel ?? '');
	const sheetDepth = $derived((sheetSource !== null && many ? 1 : 0) + (sheetGroup !== null ? 1 : 0));
	const sheetLevel = $derived(`${sheetSource ?? ''}/${sheetGroup ?? ''}`);
</script>

<div
	bind:this={containerEl}
	class="real-select model-picker-field {className} {size === 'sm' ? 'real-select--sm' : ''} {open ? 'is-open' : ''} {disabled ? 'is-disabled' : ''} {error ? 'has-error' : ''}"
>
	<button
		bind:this={triggerEl}
		{id}
		type="button"
		class="real-select-trigger"
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-label={ariaLabel}
		{disabled}
		onclick={() => (open ? close() : void openPicker())}
		onkeydown={onTriggerKeydown}
	>
		{#if picked?.source?.mark ?? picked?.row.mark}
			<ModelSourceMark source={(picked?.source?.mark ?? picked?.row.mark)!} />
		{/if}
		<span class="real-select-value" class:is-placeholder={!picked && !value}>
			{display}
			{#if displayHint}
				<span class="real-select-value-hint">{displayHint}</span>
			{/if}
		</span>
		<span class="real-select-arrow" aria-hidden="true">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
		</span>
	</button>

	{#snippet modelRow(row: PickerRow, index: number, active: boolean, mark: PickerSource | null)}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<li
			id={index >= 0 ? rowId(index) : undefined}
			class="mp-row"
			class:is-selected={row.value === value}
			class:is-active={active}
			class:is-disabled={row.disabled}
			role="option"
			aria-selected={row.value === value}
			aria-disabled={row.disabled}
			data-value={row.value}
			onclick={() => choose(row)}
			onmouseenter={() => {
				if (!phone.current && index >= 0 && !row.disabled) {
					cursor = index;
					column = 'rows';
				}
			}}
		>
			{#if mark?.mark}
				<ModelSourceMark source={mark.mark} />
			{:else if row.mark}
				<ModelSourceMark source={row.mark} />
			{/if}
			<span class="mp-row-text">
				<span class="mp-row-label">{row.label}{#if row.hint}<span class="mp-row-hint">{row.hint}</span>{/if}</span>
				{#if row.detail}<span class="mp-row-detail">{row.detail}</span>{/if}
			</span>
			{#if row.value === value}
				<svg class="mp-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
			{/if}
		</li>
	{/snippet}

	{#snippet searchField(placeholderText: string)}
		<div class="mp-search">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
			<input
				bind:this={searchEl}
				bind:value={query}
				type="search"
				placeholder={placeholderText}
				aria-label={placeholderText}
				role="combobox"
				aria-expanded="true"
				aria-controls={listId}
				aria-activedescendant={!phone.current && rows[cursor] ? rowId(cursor) : undefined}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				onkeydown={phone.current ? (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (query) query = ''; else sheetBack(); } } : onSearchKeydown}
			/>
		</div>
	{/snippet}

	{#snippet resultsList(withIndex: boolean)}
		<ul class="mp-list" id={listId} role="listbox" aria-label={ariaLabel ?? title}>
			{#each results as result, r (result.source?.key ?? '·special')}
				{@const before = results.slice(0, r).reduce((sum, prior) => sum + prior.rows.length, 0)}
				{#if result.source}
					<li class="mp-heading" role="presentation">
						{#if result.source.mark}<ModelSourceMark source={result.source.mark} tile />{/if}
						<span>{result.source.label}</span>
					</li>
				{/if}
				{#each result.rows as row, i (row.value)}
					{@render modelRow(row, withIndex ? before + i : -1, withIndex && cursor === before + i, null)}
				{/each}
			{/each}
			{#if typedRow}
				{@render modelRow(typedRow, withIndex ? rows.length - 1 : -1, withIndex && cursor === rows.length - 1, typingFor)}
			{/if}
			{#if results.length === 0 && !typedRow}
				<li class="mp-empty" role="presentation">{t.modelPicker.noMatch}</li>
			{/if}
		</ul>
	{/snippet}

	{#if open && !phone.current}
		<div
			bind:this={panelEl}
			class="mp-panel"
			class:is-above={placeAbove}
			class:is-single={!many}
			role="dialog"
			aria-label={ariaLabel ?? title}
		>
			{@render searchField(t.modelPicker.search)}
			{#if trimmed}
				<div class="mp-scroll">{@render resultsList(true)}</div>
			{:else}
				{#if data.specials.length > 0}
					<ul class="mp-list mp-specials" role="listbox" aria-label={ariaLabel ?? title}>
						{#each data.specials as row, i (row.value)}
							{@render modelRow(row, i, column === 'rows' && cursor === i, null)}
						{/each}
					</ul>
				{/if}
				<div class="mp-columns">
					{#if many}
						<div class="mp-sources" role="tablist" aria-orientation="vertical" aria-label={t.modelPicker.sources}>
							{#each data.sources as source (source.key)}
								<button
									type="button"
									role="tab"
									class="mp-source"
									class:is-active={source.key === activeSource?.key}
									class:is-keyed={column === 'sources' && source.key === activeSource?.key}
									class:is-disabled={source.disabled}
									aria-selected={source.key === activeSource?.key}
									aria-disabled={source.disabled}
									tabindex="-1"
									data-source-key={source.key}
									onmouseenter={() => activate(source)}
									onclick={() => {
										activate(source);
										column = 'rows';
										searchEl?.focus({ preventScroll: true });
									}}
								>
									{#if source.mark}<ModelSourceMark source={source.mark} tile />{/if}
									<span class="mp-source-label">{source.label}</span>
									<span class="mp-source-note">{source.note ?? t.modelPicker.count(sourceCount(source))}</span>
								</button>
							{/each}
						</div>
					{/if}
					<div class="mp-scroll">
						<ul class="mp-list" id={listId} role="listbox" aria-label={activeSource?.label ?? ariaLabel ?? title}>
							{#if activeSource}
								{#if sourceCount(activeSource) === 0}
									<li class="mp-empty" role="presentation">{t.modelPicker.noModels}{#if activeSource.custom}<br />{t.modelPicker.typeOwn}{/if}</li>
								{/if}
								{#each activeSource.groups as group (group.key)}
									{@const offset = data.specials.length + activeSource.groups.slice(0, activeSource.groups.indexOf(group)).reduce((sum, prior) => sum + prior.rows.length, 0)}
									{#if group.label}
										<li class="mp-group" role="presentation">{group.label}<span>{group.rows.length}</span></li>
									{/if}
									{#each group.rows as row, i (row.value)}
										{@render modelRow(row, offset + i, column === 'rows' && cursor === offset + i, null)}
									{/each}
								{/each}
							{/if}
						</ul>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if open && phone.current}
		<div bind:this={sheetEl} class="mp-sheet-layer">
			<button type="button" class="mp-sheet-backdrop" aria-label={t.modelPicker.close} tabindex="-1" onclick={() => close()}></button>
			<div class="mp-sheet" role="dialog" aria-modal="true" aria-label={sheetTitle} tabindex="-1">
				<div class="mp-sheet-grip" aria-hidden="true"></div>
				<header class="mp-sheet-head">
					{#if sheetDepth > 0}
						<button type="button" class="mp-sheet-icon" aria-label={t.modelPicker.back} onclick={sheetBack}>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
						</button>
					{/if}
					{#if sheetAt?.mark && sheetGroup === null}<ModelSourceMark source={sheetAt.mark} tile />{/if}
					<h2 class="mp-sheet-title">{sheetTitle}</h2>
					<button type="button" class="mp-sheet-icon" aria-label={t.modelPicker.close} onclick={() => close()}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
					</button>
				</header>
				{@render searchField(sheetAt ? t.modelPicker.searchIn(sheetGroupAt?.label ?? sheetAt.label) : t.modelPicker.search)}
				{#key trimmed ? 'search' : sheetLevel}
					<div class="mp-sheet-body is-{sheetStep}">
						{#if trimmed}
							{@render resultsList(false)}
						{:else if sheetAt === null}
							<ul class="mp-list" role="listbox" aria-label={sheetTitle}>
								{#each data.specials as row (row.value)}
									{@render modelRow(row, -1, false, null)}
								{/each}
								{#each data.sources as source (source.key)}
									<li role="presentation">
										<button type="button" class="mp-sheet-nav" class:is-disabled={source.disabled} disabled={source.disabled} data-source-key={source.key} onclick={() => sheetInto(source)}>
											{#if source.mark}<span class="mp-sheet-mark"><ModelSourceMark source={source.mark} tile /></span>{/if}
											<span class="mp-row-text">
												<span class="mp-row-label">{source.label}</span>
												<span class="mp-row-detail">{source.note ?? t.modelPicker.count(sourceCount(source))}{#if picked?.source?.key === source.key}{' · '}{picked.row.label}{/if}</span>
											</span>
											<svg class="mp-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
										</button>
									</li>
								{/each}
							</ul>
						{:else if sheetGroupAt === null && groupsLevel(sheetAt)}
							<ul class="mp-list" role="listbox" aria-label={sheetTitle}>
								{#if !many}
									{#each data.specials as row (row.value)}
										{@render modelRow(row, -1, false, null)}
									{/each}
								{/if}
								{#each sheetAt.groups as group (group.key)}
									<li role="presentation">
										<button type="button" class="mp-sheet-nav" data-group-key={group.key} onclick={() => sheetIntoGroup(group)}>
											<span class="mp-row-text">
												<span class="mp-row-label">{group.label ?? sheetAt.label}</span>
												<span class="mp-row-detail">{t.modelPicker.count(group.rows.length)}{#if picked?.group?.key === group.key && picked.source?.key === sheetAt.key}{' · '}{picked.row.label}{/if}</span>
											</span>
											<svg class="mp-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
										</button>
									</li>
								{/each}
							</ul>
						{:else}
							<ul class="mp-list" role="listbox" aria-label={sheetTitle}>
								{#if !many && sheetGroupAt === null}
									{#each data.specials as row (row.value)}
										{@render modelRow(row, -1, false, null)}
									{/each}
								{/if}
								{#if sourceCount(sheetAt) === 0}
									<li class="mp-empty" role="presentation">{t.modelPicker.noModels}{#if sheetAt.custom}<br />{t.modelPicker.typeOwn}{/if}</li>
								{/if}
								{#each sheetGroupAt ? [sheetGroupAt] : sheetAt.groups as group (group.key)}
									{#if group.label && !sheetGroupAt}
										<li class="mp-group" role="presentation">{group.label}<span>{group.rows.length}</span></li>
									{/if}
									{#each group.rows as row (row.value)}
										{@render modelRow(row, -1, false, null)}
									{/each}
								{/each}
							</ul>
						{/if}
					</div>
				{/key}
			</div>
		</div>
	{/if}
</div>

<style>
	.real-select {
		position: relative;
		display: inline-block;
		width: 100%;
		font-family: var(--font);
	}

	.real-select-trigger {
		display: flex;
		align-items: center;
		width: 100%;
		gap: 8px;
		padding: 8px 12px;
		background: var(--input-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		font-family: inherit;
		font-size: 14px;
		line-height: 1.4;
		color: var(--ink);
		box-shadow: var(--shadow-xs);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
		box-sizing: border-box;
		user-select: none;
	}

	.real-select-trigger:hover:not(:disabled) {
		border-color: var(--line-hover);
		background-color: var(--line-subtle);
	}

	.real-select.is-open .real-select-trigger,
	.real-select-trigger:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
		background-color: var(--input-bg);
	}

	.real-select.has-error .real-select-trigger {
		border-color: var(--danger-line);
		box-shadow: 0 0 0 3px var(--danger-bg);
	}

	.real-select-trigger:disabled {
		opacity: 0.55;
		cursor: not-allowed;
		background: var(--line-subtle);
		box-shadow: none;
	}

	.real-select--sm .real-select-trigger {
		padding: 6px 10px;
		font-size: 13px;
	}

	.real-select-value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		color: var(--ink);
	}

	.real-select-value.is-placeholder {
		color: var(--muted);
		font-weight: 400;
	}

	.real-select-value-hint {
		margin-left: 6px;
		font-size: 12px;
		font-weight: 400;
		color: var(--muted);
	}

	.real-select-arrow {
		display: inline-flex;
		flex: none;
		color: var(--muted);
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease;
	}

	.real-select.is-open .real-select-arrow {
		transform: rotate(180deg);
		color: var(--accent);
	}

	/* The popover: in the top layer, placed by `place()`. */
	.mp-panel {
		position: absolute;
		z-index: 100;
		display: flex;
		flex-direction: column;
		max-height: 460px;
		overflow: hidden;
		background: var(--pane);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		box-sizing: border-box;
		animation: mpIn 0.14s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.mp-panel:popover-open {
		position: fixed;
		inset: auto;
		margin: 0;
		padding: 0;
	}

	.mp-panel.is-above {
		animation-name: mpInAbove;
	}

	@keyframes mpIn {
		from { opacity: 0; transform: translateY(-4px) scale(0.99); }
		to { opacity: 1; transform: none; }
	}

	@keyframes mpInAbove {
		from { opacity: 0; transform: translateY(4px) scale(0.99); }
		to { opacity: 1; transform: none; }
	}

	.mp-search {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--line);
		color: var(--muted);
		flex: none;
	}

	.mp-search input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		padding: 2px 0;
		box-shadow: none;
	}

	.mp-search input::-webkit-search-cancel-button {
		cursor: pointer;
	}

	.mp-specials {
		flex: none;
		padding: 4px;
		border-bottom: 1px solid var(--line);
	}

	.mp-columns {
		display: flex;
		min-height: 0;
		flex: 1;
	}

	.mp-sources {
		flex: 0 0 196px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px;
		overflow-y: auto;
		border-right: 1px solid var(--line);
		background: var(--line-subtle);
		scrollbar-width: thin;
	}

	.mp-source {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}

	.mp-source.is-active {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
	}

	.mp-source.is-keyed {
		outline: 2px solid var(--accent-border);
		outline-offset: -2px;
	}

	.mp-source.is-disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.mp-source-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}

	.mp-source-note {
		flex: none;
		font-size: 11px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.mp-scroll {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	.mp-list {
		list-style: none;
		margin: 0;
		padding: 4px;
	}

	.mp-heading,
	.mp-group {
		position: sticky;
		top: -4px;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 10px 4px;
		background: var(--pane);
		font-size: 11px;
		line-height: 1.3;
		color: var(--muted);
		user-select: none;
	}

	.mp-heading {
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.mp-group span {
		font-variant-numeric: tabular-nums;
		opacity: 0.8;
	}

	.mp-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		line-height: 1.35;
		cursor: pointer;
		user-select: none;
	}

	.mp-row.is-active {
		background: var(--line-subtle);
	}

	.mp-row.is-selected {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.mp-row.is-selected.is-active {
		background: var(--accent-border);
	}

	.mp-row.is-disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.mp-row-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.mp-row-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}

	.mp-row.is-selected .mp-row-label {
		font-weight: 600;
	}

	.mp-row-hint {
		margin-left: 6px;
		font-size: 11px;
		font-weight: 400;
		color: var(--muted);
	}

	.mp-row-detail {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--muted);
	}

	.mp-check {
		flex: none;
		color: var(--accent);
	}

	.mp-empty {
		padding: 18px 12px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted);
		text-align: center;
	}

	/* The phone's sheet: the whole window in the top layer, the sheet at its foot. */
	.mp-sheet-layer {
		position: fixed;
		inset: 0;
		z-index: 400;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		overflow: hidden;
	}

	.mp-sheet-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		background: var(--backdrop, rgba(0, 0, 0, 0.36));
		animation: mpFade 0.18s ease;
	}

	@keyframes mpFade {
		from { opacity: 0; }
	}

	.mp-sheet {
		position: relative;
		display: flex;
		flex-direction: column;
		max-height: min(86dvh, 86vh);
		min-height: min(52dvh, 52vh);
		background: var(--pane);
		border-radius: 16px 16px 0 0;
		box-shadow: var(--shadow-lg);
		padding-bottom: env(safe-area-inset-bottom, 0);
		outline: none;
		animation: mpSheetIn 0.24s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes mpSheetIn {
		from { transform: translateY(100%); }
	}

	.mp-sheet-grip {
		width: 36px;
		height: 4px;
		margin: 8px auto 2px;
		border-radius: 2px;
		background: var(--line);
		flex: none;
	}

	.mp-sheet-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 8px 16px;
		flex: none;
	}

	.mp-sheet-head:has(.mp-sheet-icon:first-child) {
		padding-left: 4px;
	}

	.mp-sheet-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mp-sheet-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex: none;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.mp-sheet-icon:active {
		background: var(--line-subtle);
	}

	.mp-sheet .mp-search {
		margin: 0 12px 6px;
		padding: 9px 12px;
		border: 0;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
	}

	.mp-sheet .mp-search input {
		font-size: 16px;
	}

	.mp-sheet-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		animation: mpStepIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.mp-sheet-body.is-back {
		animation-name: mpStepBack;
	}

	@keyframes mpStepIn {
		from { opacity: 0; transform: translateX(20px); }
	}

	@keyframes mpStepBack {
		from { opacity: 0; transform: translateX(-20px); }
	}

	.mp-sheet .mp-list {
		padding: 0 8px 12px;
	}

	.mp-sheet .mp-row,
	.mp-sheet-nav {
		min-height: 48px;
		padding: 8px 12px;
		font-size: 15px;
	}

	.mp-sheet .mp-row-detail {
		font-size: 12px;
	}

	.mp-sheet .mp-row:active:not(.is-disabled) {
		background: var(--line-subtle);
	}

	.mp-sheet .mp-group,
	.mp-sheet .mp-heading {
		top: 0;
		padding: 10px 12px 6px;
		font-size: 12px;
	}

	.mp-sheet-nav {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		box-sizing: border-box;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 15px;
		text-align: left;
		cursor: pointer;
	}

	.mp-sheet-nav:active:not(:disabled) {
		background: var(--line-subtle);
	}

	.mp-sheet-nav.is-disabled {
		opacity: 0.5;
	}

	.mp-sheet-mark {
		display: inline-flex;
		--connector-logo-size: 28px;
		--agent-logo-size: 28px;
	}

	.mp-sheet-mark :global(.model-source) {
		min-width: 28px;
		height: 28px;
	}

	.mp-chevron {
		flex: none;
		color: var(--muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.mp-panel,
		.mp-sheet,
		.mp-sheet-body,
		.mp-sheet-backdrop {
			animation: none;
		}
	}
</style>
