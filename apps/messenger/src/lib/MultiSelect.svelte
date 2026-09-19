<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		filterOptions,
		findNextEnabledIndex,
		normalizeOptions,
		toggleValue,
		type NormalizedSelectOption,
		type SelectOption
	} from './select-options.ts';

	interface Props {
		values?: string[];
		options?: readonly (SelectOption | string)[];
		/** Shown in the field while nothing is picked. */
		placeholder?: string;
		/** Shown in the field once something is, where the typing goes. */
		searchPlaceholder?: string;
		/** The list is empty to begin with. */
		emptyLabel?: string;
		/** The query matched nothing. */
		noMatchLabel?: string;
		removeLabel?: string;
		/**
		 * Drawn before the label, in a row of the list and again in the chip that row becomes —
		 * an avatar, an icon. The second argument says which of the two is asking, because the
		 * two are not the same size.
		 */
		media?: Snippet<[NormalizedSelectOption, 'chip' | 'option']>;
		id?: string;
		disabled?: boolean;
		error?: boolean;
		placement?: 'auto' | 'bottom' | 'top';
		class?: string;
		ariaLabel?: string;
		onchange?: (values: string[]) => void;
	}

	let {
		values = $bindable([]),
		options = [],
		placeholder = '',
		searchPlaceholder = '',
		emptyLabel = '',
		noMatchLabel = '',
		removeLabel = '',
		media,
		id,
		disabled = false,
		error = false,
		placement = 'auto',
		class: className = '',
		ariaLabel,
		onchange
	}: Props = $props();

	/** The menu's height cap, and the room it wants below the field before it flips above it. */
	const MENU_MAX = 264;

	let isOpen = $state(false);
	let query = $state('');
	let highlightedIndex = $state(-1);
	let computedPlacement = $state<'bottom' | 'top'>('bottom');

	let containerEl = $state<HTMLDivElement | null>(null);
	let fieldEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);
	let menuEl = $state<HTMLUListElement | null>(null);
	let optionEls = $state<(HTMLLIElement | null)[]>([]);

	const listboxId = $derived(id ? `${id}-listbox` : 'multi-select-listbox');
	const normalizedOptions = $derived(normalizeOptions(options));
	const visibleOptions = $derived(filterOptions(normalizedOptions, query));
	const selectedOptions = $derived(
		values
			.map((value) => normalizedOptions.find((opt) => opt.value === value))
			.filter((opt): opt is NormalizedSelectOption => Boolean(opt))
	);

	/**
	 * Flip the menu above the field when the room below has run out. The menu is positioned
	 * against the field, not the viewport: the dialog this opens in is scaled by its entry
	 * animation, and anything placed in viewport coordinates lands somewhere else entirely for
	 * as long as that transform is on the box.
	 */
	function updatePlacement(): void {
		if (!fieldEl) return;
		if (placement !== 'auto') {
			computedPlacement = placement;
			return;
		}
		const rect = fieldEl.getBoundingClientRect();
		const below = window.innerHeight - rect.bottom;
		computedPlacement = below < MENU_MAX && rect.top > below ? 'top' : 'bottom';
	}

	function open(): void {
		if (disabled || isOpen) return;
		updatePlacement();
		isOpen = true;
		highlightedIndex = findNextEnabledIndex(visibleOptions, -1, 1);
	}

	function close(): void {
		if (!isOpen) return;
		isOpen = false;
		highlightedIndex = -1;
		query = '';
	}

	function commit(next: string[]): void {
		values = next;
		onchange?.(next);
	}

	function toggle(option: NormalizedSelectOption): void {
		if (option.disabled) return;
		commit(toggleValue(values, option.value));
		// A group takes several members, so the list stays open and the query stays put: one
		// search, several ticks.
		inputEl?.focus();
	}

	function remove(value: string): void {
		if (disabled) return;
		commit(values.filter((held) => held !== value));
		inputEl?.focus();
	}

	function onFieldPointerDown(e: MouseEvent): void {
		if (disabled) return;
		// A click on a chip's ✕ is that chip's business, not the field's.
		if ((e.target as HTMLElement).closest('.multi-select-chip-remove')) return;
		if (!isOpen) open();
		inputEl?.focus();
	}

	function onQueryInput(): void {
		if (!isOpen) open();
		highlightedIndex = findNextEnabledIndex(visibleOptions, -1, 1);
	}

	function scrollToOption(index: number): void {
		if (index >= 0) optionEls[index]?.scrollIntoView({ block: 'nearest' });
	}

	function move(direction: 1 | -1): void {
		highlightedIndex = findNextEnabledIndex(visibleOptions, highlightedIndex, direction);
		scrollToOption(highlightedIndex);
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (disabled) return;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				if (!isOpen) open();
				else move(1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				if (!isOpen) open();
				else move(-1);
				break;
			case 'Enter':
				if (!isOpen) return;
				e.preventDefault();
				if (highlightedIndex >= 0 && highlightedIndex < visibleOptions.length) {
					toggle(visibleOptions[highlightedIndex]!);
				}
				break;
			case 'Escape':
				if (!isOpen) return;
				// The sheet around this one also closes on Escape. Closing the menu is the whole
				// keystroke; the modal behind it stays.
				e.preventDefault();
				e.stopPropagation();
				close();
				break;
			case 'Backspace':
				if (query.length > 0 || values.length === 0) return;
				e.preventDefault();
				remove(values[values.length - 1]!);
				break;
			default:
				break;
		}
	}

	$effect(() => {
		if (!isOpen) return;

		function onPointerDown(e: PointerEvent): void {
			if (containerEl?.contains(e.target as Node)) return;
			close();
		}

		function reposition(): void {
			updatePlacement();
		}

		function onScroll(e: Event): void {
			if (menuEl && menuEl.contains(e.target as Node)) return;
			updatePlacement();
		}

		document.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', onScroll, true);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', onScroll, true);
		};
	});
</script>

<div
	bind:this={containerEl}
	class="multi-select {className} {isOpen ? 'is-open' : ''} {disabled ? 'is-disabled' : ''} {error
		? 'has-error'
		: ''}"
>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div bind:this={fieldEl} class="multi-select-field" onmousedown={onFieldPointerDown}>
		{#each selectedOptions as option (option.value)}
			<span class="multi-select-chip">
				{#if media}
					<span class="multi-select-chip-media">{@render media(option, 'chip')}</span>
				{/if}
				<span class="multi-select-chip-label">{option.label}</span>
				<button
					type="button"
					class="multi-select-chip-remove"
					title={removeLabel}
					aria-label={`${removeLabel} ${option.label}`}
					{disabled}
					onclick={() => remove(option.value)}
				>
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</span>
		{/each}
		<input
			bind:this={inputEl}
			bind:value={query}
			{id}
			type="text"
			class="multi-select-input"
			role="combobox"
			autocomplete="off"
			aria-expanded={isOpen}
			aria-controls={listboxId}
			aria-label={ariaLabel}
			aria-activedescendant={isOpen && highlightedIndex >= 0
				? `${listboxId}-opt-${highlightedIndex}`
				: undefined}
			placeholder={selectedOptions.length > 0 ? searchPlaceholder : placeholder}
			{disabled}
			oninput={onQueryInput}
			onkeydown={handleKeydown}
		/>
		<span class="multi-select-arrow" aria-hidden="true">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="6 9 12 15 18 9"></polyline>
			</svg>
		</span>
	</div>

	{#if isOpen}
		<ul
			bind:this={menuEl}
			id={listboxId}
			class="multi-select-menu placement-{computedPlacement}"
			role="listbox"
			aria-multiselectable="true"
			tabindex="-1"
		>
			{#if visibleOptions.length === 0}
				<li class="multi-select-empty" role="presentation">
					{normalizedOptions.length === 0 ? emptyLabel : noMatchLabel}
				</li>
			{:else}
				{#each visibleOptions as option, idx (option.value)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						bind:this={optionEls[idx]}
						id={`${listboxId}-opt-${idx}`}
						class="multi-select-option {values.includes(option.value) ? 'is-selected' : ''} {highlightedIndex ===
						idx
							? 'is-highlighted'
							: ''} {option.disabled ? 'is-disabled' : ''}"
						role="option"
						aria-selected={values.includes(option.value)}
						aria-disabled={option.disabled}
						onclick={() => toggle(option)}
						onmouseenter={() => {
							if (!option.disabled) highlightedIndex = idx;
						}}
					>
						<span class="multi-select-box" aria-hidden="true">
							{#if values.includes(option.value)}
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="20 6 9 17 4 12"></polyline>
								</svg>
							{/if}
						</span>
						{#if media}
							<span class="multi-select-option-media">{@render media(option, 'option')}</span>
						{/if}
						<span class="multi-select-option-label">{option.label}</span>
						{#if option.hint}
							<span class="multi-select-option-hint">{option.hint}</span>
						{/if}
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>

<style>
	.multi-select {
		position: relative;
		width: 100%;
		font-family: var(--font);
	}

	.multi-select-field {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 5px;
		width: 100%;
		min-height: 36px;
		padding: 5px 30px 5px 6px;
		background: var(--input-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		cursor: text;
		box-sizing: border-box;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.multi-select-field:hover {
		border-color: var(--line-hover);
	}

	.multi-select.is-open .multi-select-field,
	.multi-select-field:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	.multi-select.has-error .multi-select-field {
		border-color: var(--danger-line);
		box-shadow: 0 0 0 3px var(--danger-bg);
	}

	.multi-select.has-error.is-open .multi-select-field,
	.multi-select.has-error .multi-select-field:focus-within {
		border-color: var(--danger);
	}

	.multi-select.is-disabled .multi-select-field {
		opacity: 0.55;
		cursor: not-allowed;
		background: var(--line-subtle);
	}

	.multi-select-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 2px 4px 2px 8px;
		border-radius: 9999px;
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
		line-height: 1.5;
	}

	/* An avatar sits closer to the chip's edge than a bare name does. */
	.multi-select-chip:has(.multi-select-chip-media) {
		padding-left: 3px;
	}

	.multi-select-chip-media,
	.multi-select-option-media {
		display: inline-flex;
		flex-shrink: 0;
	}

	.multi-select-chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.multi-select-chip-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: inherit;
		opacity: 0.7;
		cursor: pointer;
		transition: background-color 0.12s ease, opacity 0.12s ease;
	}

	.multi-select-chip-remove:hover:not(:disabled) {
		background: var(--accent-border);
		opacity: 1;
	}

	/*
	 * The field is the box you type into, so the input inside it drops the border, background and
	 * full width every sheet gives a text input and takes only what is left of the row. Those
	 * sheet rules are written `.modal-body input[type="text"]`, which outweighs one scoped class —
	 * hence the descendant selector.
	 */
	.multi-select .multi-select-input {
		flex: 1 1 60px;
		width: auto;
		min-width: 60px;
		border: 0;
		outline: none;
		background: transparent;
		padding: 2px 4px;
		font-family: inherit;
		font-size: 13.5px;
		line-height: 1.4;
		color: var(--ink);
		box-shadow: none;
	}

	.multi-select .multi-select-input:focus {
		border: 0;
		box-shadow: none;
	}

	.multi-select .multi-select-input::placeholder {
		color: var(--muted);
	}

	.multi-select-arrow {
		position: absolute;
		top: 9px;
		right: 10px;
		display: inline-flex;
		color: var(--muted);
		pointer-events: none;
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease;
	}

	.multi-select.is-open .multi-select-arrow {
		transform: rotate(180deg);
		color: var(--accent);
	}

	/*
	 * Absolute, against the field. Whatever opens this has to let it out: `.create-group-modal`
	 * turns off the overflow a modal body normally has for exactly that reason.
	 */
	.multi-select-menu {
		position: absolute;
		left: 0;
		right: 0;
		z-index: 140;
		/* `MENU_MAX` above decides where the menu opens from this number; keep the two in step. */
		max-height: 264px;
		margin: 0;
		padding: 4px;
		list-style: none;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--muted-light) transparent;
		box-sizing: border-box;
		animation: multiSelectMenuIn 0.14s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.multi-select-menu.placement-bottom {
		top: calc(100% + 4px);
	}

	.multi-select-menu.placement-top {
		bottom: calc(100% + 4px);
	}

	@keyframes multiSelectMenuIn {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.multi-select-empty {
		padding: 10px 12px;
		font-size: 12.5px;
		color: var(--muted);
		text-align: center;
	}

	.multi-select-option {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		line-height: 1.4;
		color: var(--ink);
		cursor: pointer;
		user-select: none;
		transition: background-color 0.1s ease;
	}

	.multi-select-option.is-highlighted {
		background-color: var(--line-subtle);
	}

	.multi-select-option.is-selected {
		color: var(--accent);
		font-weight: 600;
	}

	.multi-select-option.is-disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.multi-select-box {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		flex-shrink: 0;
		border: 1px solid var(--line-hover);
		border-radius: 4px;
		background: var(--input-bg);
		color: #ffffff;
	}

	.multi-select-option.is-selected .multi-select-box {
		background: var(--accent);
		border-color: var(--accent);
	}

	.multi-select-option-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.multi-select-option-hint {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: right;
		font-size: 11px;
		font-weight: 400;
		color: var(--muted);
	}
</style>
