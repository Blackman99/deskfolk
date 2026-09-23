<script lang="ts">
	import type { FieldErrorKind } from './wizard-save.ts';
	import type { Copy } from '../copy.ts';
	import {
		PRESET_STRENGTHS,
		addAttrStrength,
		addAttrThinkingLevel,
		addDraftModel,
		emptyModelAttr,
		hasCustomAttrs,
		pickerModels,
		thinkingChipOptions,
		probeSignature,
		setDraftModels,
		toggleAttrStrength,
		toggleAttrThinkingLevel,
		toggleDraftModel,
		type ModelAttrDraft,
		type ProviderDraft,
		type ProviderFieldErrors
	} from './provider-form.ts';
	import { thinkingLevelLabel } from '../copy.ts';

	interface Props {
		draft: ProviderDraft;
		errors: ProviderFieldErrors;
		failed: boolean;
		fetching: boolean;
		fetchError: string | null;
		fieldPrefix: string;
		/** Set when editing: whether the daemon already holds a key for this endpoint. */
		keySet?: boolean;
		/** `connection` is name, URL and key. `models` is the enable list and its attributes. */
		view?: 'connection' | 'models';
		t: Copy;
		onchange: (draft: ProviderDraft) => void;
		onfetch: () => void;
	}

	let {
		draft,
		errors,
		failed,
		fetching,
		fetchError,
		fieldPrefix,
		keySet,
		view = 'connection',
		t,
		onchange,
		onfetch
	}: Props = $props();

	const TOOLBAR_MIN_ROWS = 6;
	const PRESET_KEYS = new Set<string>(PRESET_STRENGTHS);

	let filterQuery = $state('');
	let filterMode = $state<'all' | 'enabled'>('all');
	let expanded = $state<Record<string, boolean>>({});
	let manualOpen = $state(false);
	let manualName = $state('');
	let strengthEditing = $state<string | null>(null);
	let strengthText = $state('');
	let thinkingEditing = $state<string | null>(null);
	let thinkingText = $state('');

	const rows = $derived(pickerModels(draft));
	const enabled = $derived(new Set(draft.models));
	const available = $derived(new Set(draft.availableModels));
	const canProbe = $derived(probeSignature(draft, Boolean(keySet)) !== null);
	const showToolbar = $derived(rows.length > TOOLBAR_MIN_ROWS);
	const visibleRows = $derived.by(() => {
		const q = filterQuery.trim().toLowerCase();
		return rows.filter((name) => {
			if (filterMode === 'enabled' && !enabled.has(name)) return false;
			return q.length === 0 || name.toLowerCase().includes(q);
		});
	});

	function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
		if (kind === 'empty') return empty;
		if (kind === 'invalid') return invalid;
		return '';
	}

	function patch(partial: Partial<ProviderDraft>): void {
		onchange({ ...draft, ...partial });
	}

	function attrOf(name: string): ModelAttrDraft {
		return draft.modelAttrs[name] ?? emptyModelAttr();
	}

	function patchAttr(name: string, next: ModelAttrDraft): void {
		if (next === draft.modelAttrs[name]) return;
		patch({ modelAttrs: { ...draft.modelAttrs, [name]: next } });
	}

	function toggleExpanded(name: string): void {
		expanded = { ...expanded, [name]: !expanded[name] };
	}

	function selectVisible(): void {
		const merged = [...draft.models];
		for (const name of visibleRows) if (!merged.includes(name)) merged.push(name);
		onchange(setDraftModels(draft, merged));
	}

	function submitManual(): void {
		const next = addDraftModel(draft, manualName);
		if (next === draft) return;
		onchange(next);
		manualName = '';
	}

	function openStrengthInput(name: string): void {
		strengthEditing = name;
		strengthText = '';
	}

	function submitStrength(name: string): void {
		patchAttr(name, addAttrStrength(attrOf(name), strengthText));
		strengthEditing = null;
		strengthText = '';
	}

	function openThinkingInput(name: string): void {
		thinkingEditing = name;
		thinkingText = '';
	}

	function submitThinking(name: string): void {
		patchAttr(name, addAttrThinkingLevel(attrOf(name), thinkingText));
		thinkingEditing = null;
		thinkingText = '';
	}

	function customStrengths(attr: ModelAttrDraft): string[] {
		return attr.strengths.filter((tag) => !PRESET_KEYS.has(tag.toLowerCase()));
	}

	function hasStrength(attr: ModelAttrDraft, tag: string): boolean {
		return attr.strengths.some((item) => item.toLowerCase() === tag.toLowerCase());
	}

	function emptyHint(): string {
		if (fetching) return t.settings.modelsFetchingHint;
		if (canProbe && !fetchError) return t.settings.modelsAutoFetchHint;
		return t.settings.modelsEmptyHint;
	}
</script>

{#if failed}
	<p class="field-error">{t.settings.saveFailed}</p>
{/if}
{#if view === 'connection'}
<div class="modal-section">
	<label for={`${fieldPrefix}-name`}>{t.settings.providerName}</label>
	<input
		id={`${fieldPrefix}-name`}
		type="text"
		placeholder="OpenAI"
		value={draft.name}
		oninput={(ev) => patch({ name: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.name}
		<p class="field-error">{t.settings.providerNameEmpty}</p>
	{/if}
</div>
<div class="modal-section">
	<label for={`${fieldPrefix}-url`}>{t.settings.endpoint}</label>
	<input
		id={`${fieldPrefix}-url`}
		type="text"
		class="mono"
		inputmode="url"
		autocapitalize="off"
		autocorrect="off"
		spellcheck="false"
		placeholder="https://api.openai.com/v1"
		value={draft.baseUrl}
		oninput={(ev) => patch({ baseUrl: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.endpoint}
		<p class="field-error">
			{fieldCopy(errors.endpoint, t.settings.endpointEmpty, t.settings.endpointInvalid)}
		</p>
	{/if}
</div>
<div class="modal-section">
	<div class="field-head-row">
		<label for={`${fieldPrefix}-key`}>{t.settings.endpointKey}</label>
		{#if keySet !== undefined}
			<span class="key-status-badge" class:is-set={keySet}>
				{keySet ? t.settings.keySet : t.settings.keyUnset}
			</span>
		{/if}
	</div>
	<input
		id={`${fieldPrefix}-key`}
		type="password"
		autocomplete="off"
		placeholder={keySet ? '••••••••' : ''}
		value={draft.apiKey}
		oninput={(ev) => patch({ apiKey: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.endpointKey}
		<p class="field-error">{t.settings.keyEmpty}</p>
	{/if}
</div>
{:else}
<div class="modal-section">
	<div class="field-head-row">
		<span class="field-head model-picker-head inline-flex items-center" id={`${fieldPrefix}-models-label`}>
			{t.settings.models}
			{#if rows.length > 0}
				<span class="badge-count-inline">
					{t.settings.modelsCounts(draft.models.length, draft.availableModels.length)}
				</span>
			{/if}
		</span>
		<button
			type="button"
			class="btn-fetch-models-mini"
			disabled={fetching || !canProbe}
			onclick={onfetch}
		>
			{#if fetching}
				{t.settings.modelsFetching}
			{:else}
				↻ {draft.availableModels.length > 0 ? t.settings.modelsRefetch : t.settings.modelsFetch}
			{/if}
		</button>
	</div>
	{#if fetchError}
		<div class="models-fetch-tip">{fetchError}</div>
	{/if}
	<div class="model-picker" class:has-error={Boolean(errors.models)}>
		{#if rows.length === 0}
			<div class="model-picker-empty py-9 px-7 text-center">
				<p class="muted">{emptyHint()}</p>
			</div>
		{:else}
			{#if showToolbar}
				<div class="model-picker-toolbar">
					<input
						type="search"
						class="model-picker-search"
						placeholder={t.settings.modelsSearchPlaceholder}
						aria-label={t.settings.modelsSearchPlaceholder}
						bind:value={filterQuery}
					/>
					<div class="segmented" role="group" aria-label={t.settings.models}>
						<button
							type="button"
							class:active={filterMode === 'all'}
							aria-pressed={filterMode === 'all'}
							onclick={() => (filterMode = 'all')}
						>
							{t.settings.modelsFilterAll}
						</button>
						<button
							type="button"
							class:active={filterMode === 'enabled'}
							aria-pressed={filterMode === 'enabled'}
							onclick={() => (filterMode = 'enabled')}
						>
							{t.settings.modelsFilterEnabled} {draft.models.length}
						</button>
					</div>
					<button type="button" class="btn-xs" onclick={selectVisible}>
						{t.settings.modelsSelectAll}
					</button>
					<button type="button" class="btn-xs" onclick={() => onchange(setDraftModels(draft, []))}>
						{t.settings.modelsDeselectAll}
					</button>
				</div>
			{/if}
			<ul class="model-picker-list list-none m-0 p-2 max-h-[260px] overflow-y-auto flex flex-col gap-1" aria-labelledby={`${fieldPrefix}-models-label`}>
				{#if visibleRows.length === 0}
					<li class="model-picker-none muted p-7 text-center text-12">
						{filterMode === 'enabled' && filterQuery.trim().length === 0
							? t.settings.modelsEnabledEmpty
							: t.settings.modelAttrsEmptyFilter}
					</li>
				{/if}
				{#each visibleRows as name (name)}
					{@const on = enabled.has(name)}
					{@const attr = attrOf(name)}
					{@const open = on && Boolean(expanded[name])}
					{@const customTags = customStrengths(attr)}
					<li class="model-row" class:is-on={on} class:is-open={open}>
						<div class="model-row-line flex items-center gap-2">
							<button
								type="button"
								role="checkbox"
								aria-checked={on}
								class="model-row-toggle"
								onclick={() => onchange(toggleDraftModel(draft, name))}
							>
								<span class="model-row-box" aria-hidden="true">{on ? '✓' : ''}</span>
								<span class="model-row-name mono flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-12p5">{name}</span>
								{#if !available.has(name)}
									<span class="model-custom-tag">{t.settings.modelCustomBadge}</span>
								{/if}
							</button>
							{#if on}
								<button
									type="button"
									class="model-row-attrs"
									class:has-custom={hasCustomAttrs(attr, draft.advertisedThinking[name])}
									aria-expanded={open}
									aria-label={t.settings.modelAttrsToggle(name)}
									onclick={() => toggleExpanded(name)}
								>
									{#if attr.price.trim()}
										<span class="attr-pill pill-price">{attr.price.trim()}</span>
									{/if}
									{#if hasCustomAttrs({ ...attr, price: '', strengths: [] }, draft.advertisedThinking[name])}
										<span class="attr-pill pill-thinking">{attr.thinkingLevels.join('/')}</span>
									{/if}
									{#each attr.strengths as tag (tag)}
										<span class="attr-pill pill-strengths">{tag}</span>
									{/each}
									<span class="model-row-caret w-6 text-center text-11" aria-hidden="true">{open ? '▾' : '▸'}</span>
								</button>
							{/if}
						</div>
						{#if open}
							<div class="model-row-body">
								<div class="attr-field">
									<label for={`${fieldPrefix}-price-${name}`} title={t.settings.modelPriceTitle}>
										{t.settings.modelPrice}
									</label>
									<input
										id={`${fieldPrefix}-price-${name}`}
										class="attr-price-input"
										type="number"
										inputmode="decimal"
										min="0"
										step="any"
										placeholder={t.settings.modelPriceHint}
										value={attr.price}
										oninput={(ev) =>
											patchAttr(name, { ...attr, price: (ev.currentTarget as HTMLInputElement).value })}
									/>
								</div>
								<div class="attr-field">
									<span class="attr-field-label">{t.settings.modelThinking}</span>
									<div class="chip-row flex flex-wrap items-center gap-2 min-h-11" role="group" aria-label={t.settings.modelThinking}>
										{#each thinkingChipOptions(attr, draft.advertisedThinking[name]) as level (level)}
											<button
												type="button"
												class="btn-chip"
												class:active={attr.thinkingLevels.includes(level)}
												aria-pressed={attr.thinkingLevels.includes(level)}
												onclick={() => patchAttr(name, toggleAttrThinkingLevel(attr, level))}
											>
												{thinkingLevelLabel(t.sidebar.thinkingLevels, level)}
											</button>
										{/each}
										{#if thinkingEditing === name}
											<!-- svelte-ignore a11y_autofocus -->
											<input
												type="text"
												class="chip-input mono"
												autofocus
												placeholder={t.settings.modelThinkingAddPlaceholder}
												bind:value={thinkingText}
												onkeydown={(ev) => {
													if (ev.key === 'Enter') {
														ev.preventDefault();
														submitThinking(name);
													} else if (ev.key === 'Escape') {
														ev.preventDefault();
														thinkingEditing = null;
													}
												}}
												onblur={() => submitThinking(name)}
											/>
										{:else}
											<button
												type="button"
												class="btn-chip is-add"
												onclick={() => openThinkingInput(name)}
											>
												+ {t.settings.modelThinkingAdd}
											</button>
										{/if}
									</div>
								</div>
								<div class="attr-field attr-field-strengths">
									<span class="attr-field-label">{t.settings.modelStrengths}</span>
									<div class="chip-row flex flex-wrap items-center gap-2 min-h-11" role="group" aria-label={t.settings.modelStrengths}>
										{#each PRESET_STRENGTHS as tag (tag)}
											<button
												type="button"
												class="btn-chip"
												class:active={hasStrength(attr, tag)}
												aria-pressed={hasStrength(attr, tag)}
												onclick={() => patchAttr(name, toggleAttrStrength(attr, tag))}
											>
												{tag}
											</button>
										{/each}
										{#each customTags as tag (tag)}
											<button
												type="button"
												class="btn-chip active is-custom"
												aria-label={t.settings.modelStrengthRemove(tag)}
												onclick={() => patchAttr(name, toggleAttrStrength(attr, tag))}
											>
												{tag} ×
											</button>
										{/each}
										{#if strengthEditing === name}
											<!-- svelte-ignore a11y_autofocus -->
											<input
												type="text"
												class="chip-input mono"
												autofocus
												placeholder={t.settings.modelStrengthsAddPlaceholder}
												bind:value={strengthText}
												onkeydown={(ev) => {
													if (ev.key === 'Enter') {
														ev.preventDefault();
														submitStrength(name);
													} else if (ev.key === 'Escape') {
														ev.preventDefault();
														strengthEditing = null;
													}
												}}
												onblur={() => submitStrength(name)}
											/>
										{:else}
											<button
												type="button"
												class="btn-chip is-add"
												onclick={() => openStrengthInput(name)}
											>
												+ {t.settings.modelStrengthsAdd}
											</button>
										{/if}
									</div>
								</div>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<div class="model-picker-foot">
			{#if manualOpen}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					class="model-manual-input mono"
					autofocus
					placeholder={t.settings.modelsAddManualPlaceholder}
					aria-label={t.settings.modelsAddManual}
					bind:value={manualName}
					onkeydown={(ev) => {
						if (ev.key === 'Enter') {
							ev.preventDefault();
							submitManual();
						} else if (ev.key === 'Escape') {
							ev.preventDefault();
							manualOpen = false;
							manualName = '';
						}
					}}
				/>
				<button type="button" class="btn-xs" onclick={submitManual}>
					{t.settings.modelsAddConfirm}
				</button>
			{:else}
				<button type="button" class="btn-text-action" onclick={() => (manualOpen = true)}>
					+ {t.settings.modelsAddManual}
				</button>
			{/if}
		</div>
	</div>
	{#if errors.models}
		<p class="field-error">{t.settings.modelsEmpty}</p>
	{/if}
	{#if errors.defaultModel}
		<p class="field-error">
			{fieldCopy(errors.defaultModel, t.settings.defaultModelEmpty, t.settings.defaultModelInvalid)}
		</p>
	{/if}
</div>
{/if}

<style>
	:global([data-theme='dark']) .attr-pill.pill-price,

	:global(body.dark) .attr-pill.pill-price {
		background: rgba(245, 158, 11, 0.2);
		color: #fbbf24;
		border-color: rgba(245, 158, 11, 0.4);
	}

	:global([data-theme='dark']) .attr-pill.pill-thinking,

	:global(body.dark) .attr-pill.pill-thinking {
		background: rgba(139, 92, 246, 0.2);
		color: #c4b5fd;
		border-color: rgba(139, 92, 246, 0.4);
	}

	:global([data-theme='dark']) .attr-pill.pill-strengths,

	:global(body.dark) .attr-pill.pill-strengths {
		background: rgba(14, 165, 233, 0.2);
		color: #7dd3fc;
		border-color: rgba(14, 165, 233, 0.4);
	}

	.key-status-badge {
		font-size: 11px;
		font-weight: 500;
		padding: 2px 8px;
		border-radius: 9999px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--muted);
	}

	.key-status-badge.is-set {
		background: var(--ok-bg);
		border-color: var(--ok-line);
		color: var(--ok);
		font-weight: 600;
	}

	.badge-count-inline {
		font-size: 11px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--muted);
		margin-left: 6px;
		vertical-align: middle;
	}

	.attr-pill {
		font-size: 11px;
		padding: 2px 7px;
		border-radius: 4px;
		font-weight: 500;
		white-space: nowrap;
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.attr-pill.pill-price {
		background: #fef3c7;
		color: #92400e;
		border: 1px solid #fde68a;
		font-family: var(--mono);
	}

	.attr-pill.pill-thinking {
		background: #ede9fe;
		color: #5b21b6;
		border: 1px solid #ddd6fe;
	}

	.attr-pill.pill-strengths {
		background: #e0f2fe;
		color: #075985;
		border: 1px solid #bae6fd;
	}

	.model-picker {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--chip);
		overflow: hidden;
	}

	.model-picker.has-error {
		border-color: var(--danger);
	}

	.model-picker-empty :global(p) {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.5;
	}

	.model-picker-toolbar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px;
		border-bottom: 1px solid var(--line);
	}

	:global(.modal-body) .model-picker-search {
		flex: 1;
		min-width: 0;
		padding: 4px 8px;
		font-size: 12px;
		border-radius: var(--radius-sm);
		box-shadow: none;
	}

	.segmented {
		display: inline-flex;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.segmented :global(button) {
		padding: 3px 8px;
		font-size: 11px;
		font-weight: 500;
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		border: none;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s ease;
	}

	.segmented :global(button) + :global(button) {
		border-left: 1px solid var(--line);
	}

	.segmented :global(button.active) {
		background: var(--accent-tint);
		color: var(--accent);
		font-weight: 600;
	}

	.model-row {
		border-radius: var(--radius-sm);
	}

	.model-row.is-on {
		background: var(--input-bg);
	}

	.model-row.is-open {
		box-shadow: inset 0 0 0 1px var(--accent-border);
	}

	.model-row-toggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		text-align: left;
		color: var(--ink);
		cursor: pointer;
	}

	.model-row-toggle:hover {
		background: var(--line-subtle);
	}

	.model-row-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.model-row-box {
		flex: none;
		width: 15px;
		height: 15px;
		border-radius: 4px;
		border: 1px solid var(--line-hover);
		background: var(--input-bg);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		font-weight: 700;
		color: #ffffff;
	}

	.model-row.is-on .model-row-box {
		background: var(--accent);
		border-color: var(--accent);
	}

	.model-custom-tag {
		flex: none;
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--muted);
		white-space: nowrap;
	}

	.model-row-attrs {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 55%;
		padding: 4px 6px;
		margin-right: 2px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		cursor: pointer;
	}

	.model-row-attrs:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.model-row-attrs .attr-pill {
		max-width: 110px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-row-body {
		display: grid;
		grid-template-columns: 120px 1fr;
		gap: 8px 12px;
		padding: 4px 10px 10px 31px;
	}

	.attr-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.attr-field-strengths {
		grid-column: 1 / -1;
	}

	.attr-field :global(label),

	.attr-field-label {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	:global(.modal-body) .attr-price-input {
		padding: 4px 8px;
		font-size: 12px;
		font-family: var(--mono);
		border-radius: var(--radius-sm);
		box-shadow: none;
	}

	:global(.modal-body) .chip-input {
		width: 120px;
		padding: 2px 7px;
		font-size: 10.5px;
		border-radius: 4px;
		border-color: var(--accent);
		box-shadow: none;
	}

	.model-picker-foot {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		border-top: 1px solid var(--line);
	}

	:global(.modal-body) .model-manual-input {
		flex: 1;
		padding: 4px 8px;
		font-size: 12px;
		border-radius: var(--radius-sm);
		box-shadow: none;
	}
</style>
