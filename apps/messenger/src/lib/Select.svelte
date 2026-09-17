<script lang="ts">
	import {
		findNextEnabledIndex,
		findOptionByPrefix,
		normalizeOptions,
		type NormalizedSelectOption,
		type SelectOption
	} from './select-options.ts';

	interface Props {
		value?: string;
		options?: readonly (SelectOption | string)[];
		placeholder?: string;
		emptyLabel?: string;
		id?: string;
		name?: string;
		disabled?: boolean;
		error?: boolean;
		size?: 'default' | 'sm';
		placement?: 'auto' | 'bottom' | 'top';
		clearable?: boolean;
		class?: string;
		ariaLabel?: string;
		onchange?: (value: string) => void;
	}

	let {
		value = $bindable(''),
		options = [],
		placeholder = '',
		emptyLabel,
		id,
		name,
		disabled = false,
		error = false,
		size = 'default',
		placement = 'auto',
		clearable = false,
		class: className = '',
		ariaLabel,
		onchange
	}: Props = $props();

	let isOpen = $state(false);
	let highlightedIndex = $state(-1);
	let computedPlacement = $state<'bottom' | 'top'>('bottom');

	let containerEl = $state<HTMLDivElement | null>(null);
	let triggerEl = $state<HTMLButtonElement | null>(null);
	let menuEl = $state<HTMLUListElement | null>(null);
	let optionEls = $state<(HTMLLIElement | null)[]>([]);

	let typeaheadBuffer = '';
	let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

	const listboxId = $derived(
		id ? `${id}-listbox` : `select-menu-${Math.random().toString(36).slice(2, 8)}`
	);

	const normalizedOptions = $derived(normalizeOptions(options, emptyLabel));

	const selectedOption = $derived(
		normalizedOptions.find((opt) => opt.value === (value ?? ''))
	);

	const displayLabel = $derived.by(() => {
		if (selectedOption) {
			return selectedOption.label;
		}
		if ((value === '' || value == null) && placeholder) {
			return placeholder;
		}
		return value || placeholder || '';
	});

	const isPlaceholder = $derived(!selectedOption && Boolean(placeholder));

	function updatePlacement() {
		if (!triggerEl) return;
		if (placement !== 'auto') {
			computedPlacement = placement;
			return;
		}
		const rect = triggerEl.getBoundingClientRect();
		let scrollParent: HTMLElement | null = null;
		let parent = triggerEl.parentElement;
		while (parent && parent !== document.body) {
			const style = window.getComputedStyle(parent);
			if (/(auto|scroll)/.test(style.overflow + style.overflowY)) {
				scrollParent = parent;
				break;
			}
			parent = parent.parentElement;
		}

		const bottomBoundary = scrollParent
			? Math.min(window.innerHeight, scrollParent.getBoundingClientRect().bottom)
			: window.innerHeight;
		const topBoundary = scrollParent
			? Math.max(0, scrollParent.getBoundingClientRect().top)
			: 0;

		const spaceBelow = bottomBoundary - rect.bottom;
		const spaceAbove = rect.top - topBoundary;
		if (spaceBelow < 220 && spaceAbove > spaceBelow) {
			computedPlacement = 'top';
		} else {
			computedPlacement = 'bottom';
		}
	}

	function scrollToOption(index: number) {
		if (index >= 0 && optionEls[index]) {
			optionEls[index]?.scrollIntoView({ block: 'nearest' });
		}
	}

	function open() {
		if (disabled || isOpen) return;
		updatePlacement();
		isOpen = true;
		const idx = normalizedOptions.findIndex((opt) => opt.value === value);
		highlightedIndex = idx >= 0 ? idx : findNextEnabledIndex(normalizedOptions, -1, 1);
		requestAnimationFrame(() => {
			scrollToOption(highlightedIndex);
		});
	}

	function close() {
		if (!isOpen) return;
		isOpen = false;
		highlightedIndex = -1;
	}

	function toggle() {
		if (isOpen) {
			close();
		} else {
			open();
		}
	}

	function selectOption(opt: NormalizedSelectOption) {
		if (opt.disabled) return;
		const changed = value !== opt.value;
		value = opt.value;
		close();
		triggerEl?.focus();
		if (changed && onchange) {
			onchange(opt.value);
		}
	}

	function handleClear(e: MouseEvent) {
		e.stopPropagation();
		const changed = value !== '';
		value = '';
		if (changed && onchange) {
			onchange('');
		}
		triggerEl?.focus();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (disabled) return;

		if (!isOpen) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				open();
			}
			return;
		}

		switch (e.key) {
			case 'Escape':
				e.preventDefault();
				close();
				triggerEl?.focus();
				break;
			case 'Tab':
				close();
				break;
			case 'ArrowDown':
				e.preventDefault();
				highlightedIndex = findNextEnabledIndex(normalizedOptions, highlightedIndex, 1);
				scrollToOption(highlightedIndex);
				break;
			case 'ArrowUp':
				e.preventDefault();
				highlightedIndex = findNextEnabledIndex(normalizedOptions, highlightedIndex, -1);
				scrollToOption(highlightedIndex);
				break;
			case 'Home':
				e.preventDefault();
				highlightedIndex = findNextEnabledIndex(normalizedOptions, -1, 1);
				scrollToOption(highlightedIndex);
				break;
			case 'End':
				e.preventDefault();
				highlightedIndex = findNextEnabledIndex(normalizedOptions, normalizedOptions.length, -1);
				scrollToOption(highlightedIndex);
				break;
			case 'Enter':
			case ' ':
				e.preventDefault();
				if (highlightedIndex >= 0 && highlightedIndex < normalizedOptions.length) {
					selectOption(normalizedOptions[highlightedIndex]);
				}
				break;
			default:
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					clearTimeout(typeaheadTimer);
					typeaheadBuffer += e.key;
					typeaheadTimer = setTimeout(() => {
						typeaheadBuffer = '';
					}, 600);

					const matchIdx = findOptionByPrefix(normalizedOptions, typeaheadBuffer);
					if (matchIdx >= 0) {
						highlightedIndex = matchIdx;
						scrollToOption(matchIdx);
					}
				}
				break;
		}
	}

	$effect(() => {
		if (!isOpen) return;

		function handlePointerDown(e: PointerEvent) {
			if (containerEl && !containerEl.contains(e.target as Node)) {
				close();
			}
		}

		function handleWindowBlur() {
			close();
		}

		function handleResize() {
			updatePlacement();
		}

		function handleScroll(e: Event) {
			if (menuEl && menuEl.contains(e.target as Node)) return;
			updatePlacement();
		}

		document.addEventListener('pointerdown', handlePointerDown);
		window.addEventListener('blur', handleWindowBlur);
		window.addEventListener('resize', handleResize);
		window.addEventListener('scroll', handleScroll, true);

		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			window.removeEventListener('blur', handleWindowBlur);
			window.removeEventListener('resize', handleResize);
			window.removeEventListener('scroll', handleScroll, true);
		};
	});
</script>

<div
	bind:this={containerEl}
	class="real-select {className} {size === 'sm' ? 'real-select--sm' : ''} {isOpen ? 'is-open' : ''} {disabled ? 'is-disabled' : ''} {error ? 'has-error' : ''}"
>
	{#if name}
		<input type="hidden" {name} {value} />
	{/if}

	<button
		bind:this={triggerEl}
		{id}
		type="button"
		class="real-select-trigger"
		role="combobox"
		aria-haspopup="listbox"
		aria-expanded={isOpen}
		aria-controls={listboxId}
		aria-label={ariaLabel}
		{disabled}
		onclick={toggle}
		onkeydown={handleKeydown}
	>
		<span class="real-select-value {isPlaceholder ? 'is-placeholder' : ''}">
			{displayLabel}
		</span>

		<div class="real-select-actions">
			{#if clearable && value && !disabled}
				<span
					role="button"
					tabindex="-1"
					class="real-select-clear"
					onclick={handleClear}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							handleClear(e as unknown as MouseEvent);
						}
					}}
					title="清除"
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</span>
			{/if}
			<span class="real-select-arrow" aria-hidden="true">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="6 9 12 15 18 9"></polyline>
				</svg>
			</span>
		</div>
	</button>

	{#if isOpen}
		<ul
			bind:this={menuEl}
			id={listboxId}
			class="real-select-menu placement-{computedPlacement}"
			role="listbox"
			tabindex="-1"
			aria-activedescendant={highlightedIndex >= 0 ? `${listboxId}-opt-${highlightedIndex}` : undefined}
		>
			{#if normalizedOptions.length === 0}
				<li class="real-select-empty" role="presentation">
					暂无选项
				</li>
			{:else}
				{#each normalizedOptions as opt, idx (opt.value + ':' + opt.label)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						bind:this={optionEls[idx]}
						id={`${listboxId}-opt-${idx}`}
						class="real-select-option {opt.value === value ? 'is-selected' : ''} {highlightedIndex === idx ? 'is-highlighted' : ''} {opt.disabled ? 'is-disabled' : ''}"
						role="option"
						aria-selected={opt.value === value}
						aria-disabled={opt.disabled}
						onclick={() => selectOption(opt)}
						onmouseenter={() => {
							if (!opt.disabled) highlightedIndex = idx;
						}}
					>
						<span class="real-select-option-label">
							{opt.label}
							{#if opt.hint}
								<span class="real-select-option-hint">{opt.hint}</span>
							{/if}
						</span>

						{#if opt.value === value}
							<span class="real-select-check" aria-hidden="true">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="20 6 9 17 4 12"></polyline>
								</svg>
							</span>
						{/if}
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>

<style>
	.real-select {
		position: relative;
		display: inline-block;
		width: 100%;
		font-family: var(--font);
	}

	.real-select.is-open {
		z-index: 50;
	}

	.real-select-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		gap: 8px;
		padding: 8px 12px;
		background: var(--input-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		font-family: inherit;
		font-size: 13.5px;
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

	.real-select.has-error.is-open .real-select-trigger,
	.real-select.has-error .real-select-trigger:focus-visible {
		border-color: var(--danger);
		box-shadow: 0 0 0 3px var(--danger-bg);
	}

	.real-select.is-disabled .real-select-trigger,
	.real-select-trigger:disabled {
		opacity: 0.55;
		cursor: not-allowed;
		background: var(--line-subtle);
		border-color: var(--line);
		box-shadow: none;
	}

	.real-select--sm .real-select-trigger {
		padding: 6px 10px;
		font-size: 13px;
	}

	.real-select-value {
		flex: 1;
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

	.real-select-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.real-select-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		color: var(--muted);
		cursor: pointer;
		transition: color 0.12s ease, background-color 0.12s ease;
	}

	.real-select-clear:hover {
		color: var(--ink);
		background: var(--line-subtle);
	}

	.real-select-arrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease;
	}

	.real-select.is-open .real-select-arrow {
		transform: rotate(180deg);
		color: var(--accent);
	}

	.real-select-menu {
		position: absolute;
		left: 0;
		right: 0;
		min-width: 100%;
		z-index: 100;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		padding: 4px;
		margin: 0;
		list-style: none;
		max-height: 230px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--muted-light) transparent;
		box-sizing: border-box;
		animation: menuIn 0.14s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.real-select-menu.placement-bottom {
		top: calc(100% + 4px);
	}

	.real-select-menu.placement-top {
		bottom: calc(100% + 4px);
	}

	@keyframes menuIn {
		from {
			opacity: 0;
			transform: scale(0.98) translateY(-4px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	.real-select-empty {
		padding: 10px 12px;
		font-size: 12.5px;
		color: var(--muted);
		text-align: center;
	}

	.real-select-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 7px 10px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		line-height: 1.4;
		color: var(--ink);
		cursor: pointer;
		user-select: none;
		transition: background-color 0.1s ease, color 0.1s ease;
		box-sizing: border-box;
	}

	.real-select--sm .real-select-option {
		padding: 5px 8px;
		font-size: 12.5px;
	}

	.real-select-option.is-highlighted {
		background-color: var(--line-subtle);
		color: var(--ink);
	}

	.real-select-option.is-selected {
		background-color: var(--accent-tint);
		color: var(--accent);
		font-weight: 600;
	}

	.real-select-option.is-selected.is-highlighted {
		background-color: var(--accent-border);
	}

	.real-select-option.is-disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.real-select-option-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.real-select-option-hint {
		display: inline-block;
		margin-left: 6px;
		font-size: 11px;
		color: var(--muted);
		font-weight: 400;
	}

	.real-select-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
		flex-shrink: 0;
	}
</style>
